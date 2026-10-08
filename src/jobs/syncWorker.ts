import type { Job } from 'bullmq';
import { logger } from '../lib/logger';
import {
  backfillMissingLyrics,
  backfillArtistLastFm,
  enrichArtistLastFm,
} from '../services/syncStatusService';
import { processLibraryEnrichmentJob } from './libraryEnrichmentJob';

export type SyncJobType = 'backfill-lyrics' | 'backfill-artists-lastfm' | 'enrich-artist-lastfm' | 'library-enrichment';

export interface SyncJobData {
  type: SyncJobType;
  artistId?: string;
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
    default: {
      throw new Error(`Unknown sync job type: ${String(type)}`);
    }
  }
};