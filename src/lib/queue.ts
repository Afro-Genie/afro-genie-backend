import { Queue } from 'bullmq';
import { redis } from './redis';

const redisDisabled = process.env.DISABLE_REDIS === 'true';

// Single shared ioredis connection for ALL BullMQ queues and workers.
// Reuses the redis instance from lib/redis to avoid a second TCP connection.
const sharedConnection = redisDisabled ? null : (redis as any);

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
export const rewardQueue = createQueue('rewardQueue');

// Export shared connection for workers to reuse (1 connection total, not 17)
export { sharedConnection };
