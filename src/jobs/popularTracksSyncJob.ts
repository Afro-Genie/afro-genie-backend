import type { Job } from 'bullmq';
import { logger } from '../lib/logger';
import { syncPopularTracks } from '../services/syncEngine';
import { enqueueLibraryEnrichment } from './libraryEnrichmentJob';

export const processPopularTracksSyncJob = async (job: Job): Promise<unknown> => {
  logger.info({ jobId: job.id }, 'Processing popular tracks sync job');

  const result = await syncPopularTracks((completed, total) => {
    void job.updateProgress({ stage: 'sync-popular-tracks', current: completed, total });
  });

  // Fresh tracks may have no YouTube match yet — kick off enrichment so the
  // just-synced popular songs become playable without waiting for the cron.
  await enqueueLibraryEnrichment({ reason: 'post-popular-tracks-sync' });

  return result;
};
