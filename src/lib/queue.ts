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
    return new Queue(name, {
      connection: sharedConnection as any,
      defaultJobOptions: {
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      },
    });
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
export const modPoolDistributionQueue = createQueue('modPoolDistributionQueue');
export const seasonSnapshotQueue = createQueue('seasonSnapshotQueue');
// 2.6 — the weekly challenge rotation, the hourly abuse sweep and the hourly
// wallet reconciliation used to share ONE queue served by ONE worker at
// concurrency 1, with the job type multiplexed on `job.name`. Three unrelated
// schedules at the same head-of-line: a slow reconciliation pass (or a stuck
// abuse sweep) blocked the weekly rotation completely, which is the most
// plausible explanation for a challenge rotation that "never ran" — the
// listeners were never missing, they were starved. Each schedule now owns a
// queue so a stall can only affect its own job.
export const reconciliationQueue = createQueue('reconciliationQueue');
export const challengeRotationQueue = createQueue('challengeRotationQueue');
export const abuseDetectionQueue = createQueue('abuseDetectionQueue');
export const overturnRateAlertQueue = createQueue('overturnRateAlertQueue');
export const passRevocationQueue = createQueue('passRevocationQueue');

// Export shared connection for workers to reuse (1 connection total, not 17)
export { sharedConnection };
