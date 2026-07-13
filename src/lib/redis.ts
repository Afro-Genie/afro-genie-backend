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
        enableOfflineQueue: false,
        connectTimeout: 5000,
        commandTimeout: 3000,
        retryStrategy(times: number) {
          if (times > 10) return null;
          return Math.min(times * 200, 5000);
        }
      }));

if (!redisDisabled) {
  redis.on('error', () => {
    // Redis is used as a cache/queue backend. Keep API process alive on transient outages.
  });
}

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
}
