import { Worker } from 'bullmq';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { processSearchIndexJob } from './searchIndexJob';

const connection = { url: env.REDIS_URL };

export const translationWorker = new Worker(
  'translationQueue',
  async (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Processing translation job');
  },
  { connection }
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
