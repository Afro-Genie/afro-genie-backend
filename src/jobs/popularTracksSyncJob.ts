import type { Job } from 'bullmq';
import { logger } from '../lib/logger';
import { syncPopularTracks } from '../services/syncEngine';

export const processPopularTracksSyncJob = async (job: Job): Promise<unknown> => {
  logger.info({ jobId: job.id }, 'Processing popular tracks sync job');

  const result = await syncPopularTracks((completed, total) => {
    void job.updateProgress({ stage: 'sync-popular-tracks', current: completed, total });
  });

  return result;
};
