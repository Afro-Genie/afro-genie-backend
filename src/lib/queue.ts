import { Queue } from 'bullmq';
// Use BullMQ's bundled ioredis to avoid type mismatch with the project's ioredis
// eslint-disable-next-line @typescript-eslint/no-var-requires
const IORedis = require('bullmq/node_modules/ioredis') as typeof import('ioredis').default;
import { env } from './env';

const redisDisabled = process.env.DISABLE_REDIS === 'true';

// Single shared ioredis connection for ALL BullMQ queues and workers
// This keeps us under Redis Cloud's max connections limit (~10 free tier)
const sharedConnection = redisDisabled
  ? null
  : new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
      enableOfflineQueue: true,
      connectTimeout: 10000,
      commandTimeout: 5000,
      retryStrategy(times: number) {
        if (times > 15) return null;
        return Math.min(times * 300, 10000);
      },
    });

if (sharedConnection) {
  sharedConnection.on('error', (err: Error) => {
    console.error('[Redis-Queue] Connection error:', err.message);
  });
}

export const createQueue = (name: string) => {
  if (redisDisabled) {
    return {
      add: async () => ({ id: undefined }),
      addBulk: async () => [],
      close: async () => undefined,
    } as unknown as Queue;
  }

  try {
    return new Queue(name, { connection: sharedConnection as any });
  } catch {
    return {
      add: async () => ({ id: undefined }),
      addBulk: async () => [],
      close: async () => undefined,
    } as unknown as Queue;
  }
};

export const translationQueue = createQueue('translationQueue');
export const notificationQueue = createQueue('notificationQueue');
export const searchIndexQueue = createQueue('searchIndexQueue');
export const languageCategorizationQueue = createQueue('languageCategorizationQueue');
export const viewCountFlushQueue = createQueue('viewCountFlushQueue');
export const lyricsEnrichmentQueue = createQueue('lyricsEnrichmentQueue');
export const syncQueue = createQueue('syncQueue');
export const syncPopularTracksQueue = createQueue('syncPopularTracksQueue');

// Export shared connection for workers to reuse (1 connection total, not 17)
export { sharedConnection };
