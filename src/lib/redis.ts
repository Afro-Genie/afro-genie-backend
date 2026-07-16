import IORedis from 'ioredis';
import { env } from './env';

const globalForRedis = globalThis as unknown as { redis?: IORedis };

const redisDisabled = process.env.DISABLE_REDIS === 'true';

export const redis =
  globalForRedis.redis ??
  (redisDisabled
    ? ({
        get: async () => null,
        set: async () => 'OK',
        del: async () => 0,
        quit: async () => 'OK',
        on: () => undefined,
      } as unknown as IORedis)
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
        }
      }));

if (!redisDisabled) {
  redis.on('error', (err) => {
    console.error('[Redis] Connection error:', err.message);
  });
}

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
}
