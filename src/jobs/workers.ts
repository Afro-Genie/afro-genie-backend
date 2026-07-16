import { Worker } from 'bullmq';
import { logger } from '../lib/logger';
import { sharedConnection } from '../lib/queue';
import { processLanguageCategorizationJob } from './languageCategorizationJob';
import { processLyricsEnrichmentJob } from './lyricsEnrichmentJob';
import { processSearchIndexJob } from './searchIndexJob';
import { processTranslationJob } from './translationJob';
import { processViewCountFlushJob, scheduleViewCountFlush } from './viewCountFlushJob';
import { processSyncJob } from './syncWorker';
import { processPopularTracksSyncJob } from './popularTracksSyncJob';
import type { TranslationJobData } from '../types/translation';
import type { SyncJobData } from './syncWorker';

// Reuse the single shared connection from queue.ts (1 Redis connection for all workers)
// Cast needed because project ioredis and BullMQ's bundled ioredis have divergent types,
// but they are identical at runtime (same Redis protocol).
const connection = sharedConnection as any;

export const translationWorker = new Worker<TranslationJobData>(
  'translationQueue',
  async (job) => {
    await processTranslationJob(job);
  },
  { connection, concurrency: 4 }
);

export const notificationWorker = new Worker(
  'notificationQueue',
  async (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Processing notification job');
  },
  { connection }
);

export const searchIndexWorker = new Worker(
  'searchIndexQueue',
  async (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Processing search index job');
    await processSearchIndexJob(job);
  },
  { connection, concurrency: 8 }
);

export const languageCategorizationWorker = new Worker(
  'languageCategorizationQueue',
  async (job) => {
    logger.info({ jobId: job.id, songId: job.data.songId }, 'Processing language categorization job');
    await processLanguageCategorizationJob(job);
  },
  { connection, concurrency: 4 }
);

export const lyricsEnrichmentWorker = new Worker(
  'lyricsEnrichmentQueue',
  async (job) => {
    logger.info({ jobId: job.id, songId: job.data.songId }, 'Processing lyrics enrichment job');
    await processLyricsEnrichmentJob(job);
  },
  { connection, concurrency: 4 }
);

export const viewCountFlushWorker = new Worker(
  'viewCountFlushQueue',
  async () => {
    await processViewCountFlushJob();
  },
  { connection, concurrency: 1 }
);

export const syncWorker = new Worker<SyncJobData>(
  'syncQueue',
  async (job) => {
    logger.info({ jobId: job.id, type: job.data.type }, 'Processing sync job');
    await processSyncJob(job);
  },
  { connection, concurrency: 2 }
);

export const popularTracksSyncWorker = new Worker(
  'syncPopularTracksQueue',
  async (job) => {
    logger.info({ jobId: job.id }, 'Processing popular tracks sync job');
    await processPopularTracksSyncJob(job);
  },
  { connection, concurrency: 1 }
);

void scheduleViewCountFlush();
