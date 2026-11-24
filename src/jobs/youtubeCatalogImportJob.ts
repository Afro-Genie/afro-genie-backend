import type { Job } from 'bullmq';
import {
  assertCatalogImportQuota,
  CatalogQuotaExceededError,
  consumeCatalogImportQuota,
  getCatalogImportQuota,
} from '../lib/catalogImportQuota';
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
  YouTubeRequestTimeoutError,
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
  selectedVideoIds?: string[];
  resumeCheckpoint?: CatalogPlaylistCheckpoint;
  retryOf?: string;
  cancelRequested?: boolean;
  supersededBy?: string;
  recoveredFrom?: string;
  recoveryReason?: string;
  recoveredAt?: string;
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

class CatalogImportCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogImportCancelledError';
  }
}

type ProgressPatch = Record<string, unknown>;

function progressEta(startedAt: number, current: number, total?: number | null): number | null {
  if (!total || current <= 0) return null;
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  if (elapsedSeconds < 1) return null;
  const rate = current / elapsedSeconds;
  return Math.max(0, Math.round((total - current) / rate));
}

async function patchProgress(job: Job<YouTubeCatalogImportJobData>, patch: ProgressPatch): Promise<void> {
  const previous = typeof job.progress === 'object' && job.progress !== null
    ? job.progress as ProgressPatch
    : {};
  await job.updateProgress({
    ...previous,
    ...patch,
    lastUpdatedAt: new Date().toISOString(),
  });
}

async function patchJobData(
  job: Job<YouTubeCatalogImportJobData>,
  patch: Partial<YouTubeCatalogImportJobData>,
): Promise<void> {
  let current = job.data;
  try {
    const fresh = await youtubeCatalogImportQueue.getJob(String(job.id));
    if (fresh) current = fresh.data as YouTubeCatalogImportJobData;
  } catch (error) {
    logger.warn({ jobId: job.id, err: error }, 'Could not refresh job data before checkpoint — using local data');
  }
  const next = { ...current, ...patch };
  await job.updateData(next);
  job.data = next;
}

function createCancellationChecker(job: Job<YouTubeCatalogImportJobData>): () => Promise<boolean> {
  let lastCheck = 0;
  let cached = false;
  return async () => {
    const now = Date.now();
    if (now - lastCheck < 2000) return cached;
    lastCheck = now;
    if (job.data.cancelRequested || job.data.supersededBy) {
      cached = true;
      return true;
    }
    try {
      const fresh = await youtubeCatalogImportQueue.getJob(String(job.id));
      cached = Boolean(fresh?.data.cancelRequested || fresh?.data.supersededBy);
    } catch (error) {
      logger.warn({ jobId: job.id, err: error }, 'Could not read cancellation flag — continuing current step');
      cached = false;
    }
    return cached;
  };
}

function cancellationMessage(operation: string): string {
  return operation === 'apply'
    ? 'Cancellation requested. Already-imported songs were preserved; the remaining songs were skipped.'
    : 'Cancellation requested. Discovery stopped before any catalog changes were made.';
}

async function recordAbort(
  job: Job<YouTubeCatalogImportJobData>,
  operation: string,
  error: Error,
  stage: string,
  extra: ProgressPatch = {},
): Promise<void> {
  await patchProgress(job, {
    stage,
    cancelled: error instanceof CatalogImportCancelledError,
    cancelRequested: error instanceof CatalogImportCancelledError,
    abortReason: error.message,
    message: error.message,
    ...extra,
  });
}

export async function processYouTubeCatalogImportJob(
  job: Job<YouTubeCatalogImportJobData>,
): Promise<unknown> {
  const { operation, adminId } = job.data;
  if (!adminId) throw new Error('YouTube catalog import job is missing its admin audit identity');
  const startedAt = Date.now();
  const isCancelled = createCancellationChecker(job);

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
    const initialQuota = await assertCatalogImportQuota(100);
    await patchProgress(job, {
      stage: 'starting',
      current: 0,
      total: source.type === 'playlist' ? source.maxPages : source.maxResults,
      percent: 0,
      message: 'Connecting to YouTube…',
      quota: initialQuota,
    });
    if (await isCancelled()) throw new CatalogImportCancelledError(cancellationMessage(operation));

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
      const reportDiscovery = async (
        progress: { pagesRead?: number; videosExamined?: number; maxPages?: number; maxResults?: number; eligibleCandidates?: number },
      ) => {
        if (await isCancelled()) throw new CatalogImportCancelledError(cancellationMessage(operation));
        const current = progress.pagesRead || progress.videosExamined || 0;
        const total = progress.maxPages || (source.type !== 'playlist' ? source.maxResults : undefined);
        const quota = await getCatalogImportQuota();
        await patchProgress(job, {
          stage: 'discovering',
          ...progress,
          current,
          total,
          percent: total ? Math.min(99, Math.round((current / total) * 100)) : undefined,
          etaSeconds: progressEta(startedAt, current, total),
          quota,
          message: progress.pagesRead
            ? `Read ${progress.pagesRead} of ${progress.maxPages ?? '?'} YouTube result pages.`
            : `Examined ${progress.videosExamined ?? 0} videos.`,
        });
      };

      if (source.type === 'playlist' && !complete) {
        const maxPages = source.maxPages;
        if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 80) {
          throw new Error('Page cap must be an integer between 1 and 80');
        }
        const playlistId = source.value;
        const result = await discoverYouTubePlaylist(
          playlistId,
          maxPages,
          reportDiscovery,
          nextPageToken || undefined,
          async (checkpoint) => {
            await patchJobData(job, {
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
          async (progress) => reportDiscovery({ ...progress, maxResults: source.maxResults }),
        );
        candidates = result.candidates;
        complete = result.complete;
        nextPageToken = null;
        discovered = result.discovery;
      }
      const usedUnits = discovered.quotaEstimate.estimatedUnits || 100;
      const quota = await consumeCatalogImportQuota(usedUnits);
      await patchProgress(job, { quota, message: `Used about ${usedUnits} YouTube quota units for discovery.` });
    } catch (error) {
      if (error instanceof CatalogImportCancelledError) {
        await recordAbort(job, operation, error, 'cancelled');
        return { cancelled: true, abortReason: error.message, operation };
      }
      if (error instanceof CatalogQuotaExceededError) {
        await recordAbort(job, operation, error, 'quota-paused', { quota: error.state });
      } else if (error instanceof YouTubeQuotaExceededError) {
        const quota = await getCatalogImportQuota();
        await recordAbort(job, operation, error, 'quota-paused', { quota, quotaMessage: error.message });
      } else if (error instanceof YouTubeRequestTimeoutError) {
        await recordAbort(job, operation, error, 'request-timeout');
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
    await patchProgress(job, {
      stage: 'preview-ready',
      current: preview.summary.candidates,
      total: preview.summary.candidates,
      percent: 100,
      etaSeconds: 0,
      message: `Preview ready: ${preview.summary.candidates} candidates.`,
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
    await patchProgress(job, {
      stage: 'starting',
      current: 0,
      total: preview.items?.length ?? 0,
      percent: 0,
      message: 'Preparing to apply selected songs…',
    });
    try {
      if (await isCancelled()) throw new CatalogImportCancelledError(cancellationMessage(operation));
      const result = await applyYouTubeCatalogPreview(
        preview,
        job.data.expectedPreviewHash,
        async (progress) => {
          const percent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
          await patchProgress(job, {
            stage: progress.cancelled ? 'cancelling' : 'applying',
            ...progress,
            current: progress.completed,
            percent,
            etaSeconds: progressEta(startedAt, progress.completed, progress.total),
            message: progress.cancelled
              ? progress.abortReason || cancellationMessage(operation)
              : `Applying ${progress.completed} of ${progress.total} selected songs.`,
          });
        },
        job.data.selectedVideoIds,
        isCancelled,
      );
      if (result.cancelled) {
        await patchProgress(job, {
          stage: 'cancelled',
          cancelled: true,
          cancelRequested: true,
          percent: result.total ? Math.round((result.completed / result.total) * 100) : 0,
          message: result.abortReason || cancellationMessage(operation),
        });
      } else {
        await patchProgress(job, {
          stage: 'completed',
          percent: 100,
          etaSeconds: 0,
          message: `Applied ${result.completed} selected songs. ${result.created} created, ${result.linked} linked.`,
        });
      }
      logger.info(
        { adminId, jobId: job.id, previewJobId: job.data.previewJobId, ...result },
        'YouTube catalog apply completed',
      );
      return result;
    } catch (error) {
      if (error instanceof CatalogImportCancelledError) {
        await recordAbort(job, operation, error, 'cancelled');
        return { cancelled: true, abortReason: error.message, operation };
      }
      if (error instanceof YouTubeRequestTimeoutError) {
        await recordAbort(job, operation, error, 'request-timeout');
      }
      throw error;
    }
  }

  throw new Error(`Unknown YouTube catalog import operation: ${String(operation)}`);
}
