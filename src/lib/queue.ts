import { Queue } from 'bullmq';
import { env } from './env';

const connection = {
  url: env.REDIS_URL
};

export const translationQueue = new Queue('translationQueue', { connection });
export const notificationQueue = new Queue('notificationQueue', { connection });
export const searchIndexQueue = new Queue('searchIndexQueue', { connection });
