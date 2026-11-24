import type { Job } from 'bullmq';
import { logger } from '../lib/logger';
import {
  backfillMissingLyrics,
  backfillArtistLastFm,
  enrichArtistLastFm,
} from '../services/syncStatusService';
import { processLibraryEnrichmentJob } from './libraryEnrichmentJob';
import { enrichSongLyrics } from './lyricsEnrichmentJob';
import { getSongsNeedingLyrics } from '../services/lyricsBackfillService';

export type SyncJobType =
  | 'backfill-lyrics'
  | 'backfill-artists-lastfm'
  | 'enrich-artist-lastfm'
  | 'library-enrichment'
  | 'admin-lyrics-backfill';

export interface SyncJobData {
  type: SyncJobType;
  artistId?: string;
  adminId?: string;
  previewHash?: string;
  requestId?: string;
  songIds?: string[];
  scope?: 'new' | 'missed';
}

export const processSyncJob = async (job: Job<SyncJobData>): Promise<unknown> => {
  const { type, artistId } = job.data;

  logger.info({ jobId: job.id, type, artistId }, 'Processing sync job');

  switch (type) {
    case 'backfill-lyrics': {
      return backfillMissingLyrics((completed, total) => {
        void job.updateProgress({ stage: 'backfill-lyrics', current: completed, total });
      });
    }
    case 'backfill-artists-lastfm': {
      return backfillArtistLastFm((completed, total) => {
        void job.updateProgress({ stage: 'backfill-artists-lastfm', current: completed, total });
      });
    }
    case 'enrich-artist-lastfm': {
      if (!artistId) {
        throw new Error('artistId is required for enrich-artist-lastfm job');
      }
      await job.updateProgress({ stage: 'enrich-artist-lastfm', current: 0, total: 1 });
      const result = await enrichArtistLastFm(artistId);
      await job.updateProgress({ stage: 'enrich-artist-lastfm', current: 1, total: 1 });
      return result;
    }
    case 'library-enrichment': {
      return processLibraryEnrichmentJob(job);
    }
    case 'admin-lyrics-backfill': {
      if (!job.data.adminId || !job.data.previewHash || !job.data.requestId || !Array.isArray(job.data.songIds)) {
        throw new Error('Admin lyrics backfill job is missing its attribution or reviewed candidate list');
      }

      const result = {
        total: job.data.songIds.length,
        completed: 0,
        providerHits: 0,
        providerMisses: 0,
        failed: 0,
        populated: 0,
        skipped: 0,
        remaining: 0,
        scope: job.data.scope ?? 'new',
        failures: [] as Array<{ songId: string; title: string; message: string }>,
      };

      const songTitles = new Map((await getSongsNeedingLyrics()).map((song) => [song.id, song.title]));
      for (const songId of job.data.songIds) {
        try {
          const outcome = await enrichSongLyrics(songId);
          if (outcome === 'populated') {
            result.providerHits += 1;
            result.populated += 1;
          } else if (outcome === 'miss') {
            result.providerMisses += 1;
          } else {
            result.skipped += 1;
          }
        } catch (error) {
          result.failed += 1;
          if (result.failures.length < 100) {
            result.failures.push({
              songId,
              title: songTitles.get(songId) || songId,
              message: error instanceof Error ? error.message : 'Lyrics provider or persistence failed.',
            });
          }
          logger.error({ err: error, songId, jobId: job.id }, 'Lyrics backfill candidate failed');
        }

        result.completed += 1;
        await job.updateProgress({
          stage: 'lyrics-backfill',
          ...result,
        });
      }

      result.remaining = (await getSongsNeedingLyrics(job.data.scope ?? 'new')).length;
      await job.updateProgress({
        stage: 'lyrics-backfill',
        ...result,
      });
      return result;
    }
    default: {
      throw new Error(`Unknown sync job type: ${String(type)}`);
    }
  }
};