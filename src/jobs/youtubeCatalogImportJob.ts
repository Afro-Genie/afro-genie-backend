import type { Job } from 'bullmq';
import { logger } from '../lib/logger';
import { youtubeCatalogImportQueue } from '../lib/queue';
import {
  addYouTubeCatalogQuotaEstimates,
  applyYouTubeCatalogPreview,
  buildYouTubeCatalogPreview,
  discoverYouTubeSearch,
  discoverYouTubePlaylist,
  resolveYouTubeCatalogImportSource,
  type CatalogPlaylistCheckpoint,
  type CatalogImportSource,
  YouTubeQuotaExceededError,
  validateYouTubeCatalogPreview,
  type CatalogPreview,
} from '../services/youtubeCatalogImportService';

export interface YouTubeCatalogImportJobData {
  operation: 'preview' | 'resume' | 'apply';
  adminId: string;
  source?: CatalogImportSource;
  sourceType?: 'artist' | 'genre' | 'song';
  query?: string;
  maxResults?: number;
  playlistId?: string;
  maxPages?: number;
  previewJobId?: string;
  sourcePreviewJobId?: string;
  expectedPreviewHash?: string;
  resumeCheckpoint?: CatalogPlaylistCheckpoint;
  retryOf?: string;
}

function mergeDiscovery(
  previous: CatalogPreview['discovery'] | undefined,
  current: CatalogPreview['discovery'],
): CatalogPreview['discovery'] {
  const unreviewedChannels = new Map(
    (previous?.unreviewedChannels || []).map((channel) => [channel.channelId, channel]),
  );
  for (const channel of current.unreviewedChannels) {
    const existing = unreviewedChannels.get(channel.channelId);
    unreviewedChannels.set(channel.channelId, existing
      ? {
        ...existing,
        videos: existing.videos + channel.videos,
        sampleTitles: [...existing.sampleTitles, ...channel.sampleTitles].slice(0, 3),
      }
      : channel);
  }
  return {
    pagesRead: (previous?.pagesRead || 0) + current.pagesRead,
    videosExamined: (previous?.videosExamined || 0) + current.videosExamined,
    rejectedChannel: (previous?.rejectedChannel || 0) + current.rejectedChannel,
    rejectedVideo: (previous?.rejectedVideo || 0) + current.rejectedVideo,
    quotaEstimate: addYouTubeCatalogQuotaEstimates(previous?.quotaEstimate, current.quotaEstimate),
    unreviewedChannels: [...unreviewedChannels.values()],
  };
}

export async function processYouTubeCatalogImportJob(
  job: Job<YouTubeCatalogImportJobData>,
): Promise<unknown> {
  const { operation, adminId } = job.data;
  if (!adminId) throw new Error('YouTube catalog import job is missing its admin audit identity');

  if (operation === 'preview' || operation === 'resume') {
    let sourcePreview: CatalogPreview | null = null;
    let source = job.data.source;
    if (!source && job.data.playlistId) {
      source = resolveYouTubeCatalogImportSource('playlist', job.data.playlistId, job.data.maxPages);
    } else if (!source && job.data.sourceType && job.data.query) {
      source = resolveYouTubeCatalogImportSource(
        job.data.sourceType,
        job.data.query,
        undefined,
        job.data.maxResults,
      );
    }
    if (operation === 'resume') {
      if (!job.data.sourcePreviewJobId) throw new Error('Source preview is required to resume an import');
      const sourceJob = await youtubeCatalogImportQueue.getJob(job.data.sourcePreviewJobId);
      if (
        !sourceJob ||
        !['preview', 'resume'].includes(sourceJob.data.operation) ||
        sourceJob.data.adminId !== adminId ||
        await sourceJob.getState() !== 'completed'
      ) {
        throw new Error('The source preview is unavailable or no longer belongs to this admin');
      }
      sourcePreview = sourceJob.returnvalue as CatalogPreview;
      if (
        !sourcePreview ||
        !sourcePreview.source ||
        typeof sourcePreview.source !== 'object' ||
        sourcePreview.source.type !== 'playlist' ||
        sourcePreview.complete ||
        !sourcePreview.nextPageToken
      ) {
        throw new Error('Only an incomplete playlist preview can be resumed');
      }
    }

    const savedCheckpoint = job.data.resumeCheckpoint;
    if (sourcePreview) {
      validateYouTubeCatalogPreview(sourcePreview, sourcePreview.previewHash, true);
      source = {
        type: 'playlist',
        value: sourcePreview.source.value,
        maxPages: job.data.maxPages || 80,
      };
    }

    if (!source) throw new Error('A supported source is required for an import preview');
    if (operation === 'resume' && source.type !== 'playlist') {
      throw new Error('Only playlist previews can be resumed');
    }

    logger.info(
      { adminId, jobId: job.id, sourceType: source.type, sourceValue: source.value, operation },
      'Starting YouTube catalog preview',
    );
    const previewSource: CatalogPreview['source'] = sourcePreview?.source || {
      type: source.type === 'playlist' ? 'playlist' : `${source.type}-search` as CatalogPreview['source']['type'],
      value: source.value,
    };
    const priorCandidates = savedCheckpoint?.candidates
      || sourcePreview?.items.map((item) => item.candidate)
      || [];
    const priorDiscovery = savedCheckpoint?.discovery || sourcePreview?.discovery;
    let candidates: CatalogPreview['items'][number]['candidate'][] = [];
    let complete = savedCheckpoint?.complete || false;
    let nextPageToken = savedCheckpoint?.nextPageToken ?? sourcePreview?.nextPageToken ?? null;
    let discovered: CatalogPreview['discovery'] = {
      pagesRead: 0,
      videosExamined: 0,
      rejectedChannel: 0,
      rejectedVideo: 0,
      quotaEstimate: {
        estimatedUnits: 0,
        maxUnits: 0,
        searchListCalls: 0,
        playlistItemsListCalls: 0,
        videosListCalls: 0,
      },
      unreviewedChannels: [],
    };
    try {
      if (source.type === 'playlist' && !complete) {
        const maxPages = source.maxPages;
        if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 80) {
          throw new Error('Page cap must be an integer between 1 and 80');
        }
        const playlistId = source.value;
        const result = await discoverYouTubePlaylist(
          playlistId,
          maxPages,
          async (progress) => {
            await job.updateProgress({ stage: 'discovering', ...progress });
          },
          nextPageToken || undefined,
          async (checkpoint) => {
            await job.updateData({
              ...job.data,
              resumeCheckpoint: {
                ...checkpoint,
                candidates: [...priorCandidates, ...checkpoint.candidates],
                discovery: mergeDiscovery(priorDiscovery, checkpoint.discovery),
              },
            });
          },
        );
        candidates = result.candidates;
        complete = result.complete;
        nextPageToken = result.nextPageToken;
        discovered = result.discovery;
      } else if (source.type !== 'playlist') {
        if (sourcePreview) throw new Error('Only playlist previews can be resumed');
        const result = await discoverYouTubeSearch(
          source.type,
          source.value,
          source.maxResults,
          async (progress) => {
            await job.updateProgress({ stage: 'discovering', ...progress });
          },
        );
        candidates = result.candidates;
        complete = result.complete;
        nextPageToken = null;
        discovered = result.discovery;
      }
    } catch (error) {
      if (error instanceof YouTubeQuotaExceededError) {
        const previousProgress = typeof job.progress === 'object' && job.progress !== null
          ? job.progress
          : {};
        await job.updateProgress({
          ...previousProgress,
          stage: 'quota-paused',
          quotaMessage: error.message,
        });
      }
      throw error;
    }
    const totalDiscovery = mergeDiscovery(priorDiscovery, discovered);
    const preview = await buildYouTubeCatalogPreview(
      [...priorCandidates, ...candidates],
      previewSource,
      totalDiscovery,
      complete,
      nextPageToken,
    );
    await job.updateProgress({
      stage: 'preview-ready',
      current: preview.summary.candidates,
      total: preview.summary.candidates,
    });
    logger.info(
      { adminId, jobId: job.id, candidates: preview.summary.candidates, complete: preview.complete, operation },
      'YouTube catalog preview completed',
    );
    return preview;
  }

  if (operation === 'apply') {
    if (!job.data.previewJobId || !job.data.expectedPreviewHash) {
      throw new Error('Preview job and confirmation hash are required for catalog apply');
    }
    const previewJob = await youtubeCatalogImportQueue.getJob(job.data.previewJobId);
    if (
      !previewJob ||
      !['preview', 'resume'].includes(previewJob.data.operation) ||
      previewJob.data.adminId !== adminId ||
      await previewJob.getState() !== 'completed'
    ) {
      throw new Error('The reviewed preview is unavailable or no longer belongs to this admin');
    }

    const preview = previewJob.returnvalue as CatalogPreview;
    const result = await applyYouTubeCatalogPreview(
      preview,
      job.data.expectedPreviewHash,
      async (progress) => {
        await job.updateProgress({ stage: 'applying', ...progress });
      },
    );
    logger.info(
      { adminId, jobId: job.id, previewJobId: job.data.previewJobId, ...result },
      'YouTube catalog apply completed',
    );
    return result;
  }

  throw new Error(`Unknown YouTube catalog import operation: ${String(operation)}`);
}
