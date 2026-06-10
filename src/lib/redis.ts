import IORedis from 'ioredis';
import { env } from './env';

const globalForRedis = globalThis as unknown as { redis?: IORedis };

export const redis =
  globalForRedis.redis ??
  new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false
  });

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
}
