// ---------------------------------------------------------------------------
// Shared (Redis-backed) rate-limit store — Stage 2 / 2.7.
//
// `express-rate-limit`'s default `MemoryStore` keeps its counters in the
// process. With more than one app instance behind a load balancer the effective
// limit is therefore `limit x instanceCount`: a 30/min economy-write limit
// becomes 30/min on one instance and 150/min across five, and nothing in the
// response tells the client that. It also resets on every deploy, so the limit
// is not a real control.
//
// This store moves the counters into Redis, which the app already runs, so no
// new dependency is introduced. `localKeys: false` is the flag that tells
// express-rate-limit the counters are shared — without it the library emits a
// double-counting warning and assumes per-instance behaviour.
//
// Window semantics: fixed window, `EXPIRE` set on the first hit of the window.
// That matches the previous MemoryStore behaviour closely enough that existing
// limits keep their meaning, and is the same model the maintained
// `rate-limit-redis` package uses.
//
// Failure policy: FAIL OPEN. If Redis is unavailable the counter is reported as
// 0 hits. A monitoring outage must not take the admin economy dashboard (or the
// login endpoint) down; the alternative — fail closed — turns a cache outage
// into a total outage. Trade-off is recorded in REMEDIATION-RESULTS.md.
// ---------------------------------------------------------------------------

import type { Store } from 'express-rate-limit';
import { redis } from './redis';
import { logger } from './logger';

const redisDisabled = process.env.DISABLE_REDIS === 'true';

export const createRedisRateLimitStore = (namespace: string, explicitPrefix?: string): Store => {
  let windowMs = 60_000;
  // `explicitPrefix` lets a caller align the Redis keys with the `prefix` it
  // passes to `rateLimit()`. The public `Options` type in express-rate-limit
  // v7.5 does not expose `prefix`, so it cannot be read back from `init()`.
  const keyPrefix = explicitPrefix
    ? explicitPrefix.endsWith(':')
      ? explicitPrefix
      : `${explicitPrefix}:`
    : `ratelimit:${namespace}:`;

  const keyFor = (key: string) => `${keyPrefix}${key}`;

  // PTTL is not on the DISABLE_REDIS stub; treat it as "unknown TTL" rather
  // than throwing, so a stubbed environment degrades to fail-open instead of
  // crashing the request.
  const pttl = async (key: string): Promise<number> => {
    const fn = (redis as unknown as { pttl?: (k: string) => Promise<number> }).pttl;
    if (typeof fn !== 'function') return -1;
    return fn.call(redis, key);
  };

  return {
    // Shared across instances — this is the whole point of the store.
    localKeys: false,
    prefix: keyPrefix,

    init(options) {
      windowMs = options.windowMs;
    },

    async increment(key) {
      if (redisDisabled) {
        return { totalHits: 0, resetTime: new Date(Date.now() + windowMs) };
      }

      const redisKey = keyFor(key);
      try {
        const totalHits = await redis.incr(redisKey);

        // Set the window TTL on the first hit only — re-setting it on every hit
        // would make the window never expire under sustained traffic.
        if (totalHits === 1) {
          await redis.expire(redisKey, Math.ceil(windowMs / 1000));
        }

        const ttlMs = await pttl(redisKey);
        const remaining = ttlMs > 0 ? ttlMs : windowMs;

        return {
          totalHits,
          resetTime: new Date(Date.now() + remaining),
        };
      } catch (err) {
        logger.warn(
          { err, namespace, key },
          'Rate-limit store unavailable — failing open (request allowed)',
        );
        return { totalHits: 0, resetTime: new Date(Date.now() + windowMs) };
      }
    },

    async decrement(key) {
      if (redisDisabled) return;
      try {
        const redisKey = keyFor(key);
        const totalHits = Number((await redis.get(redisKey)) ?? '0');
        if (totalHits > 0) await redis.decrby(redisKey, 1);
      } catch (err) {
        logger.warn({ err, namespace, key }, 'Rate-limit decrement failed — non-fatal');
      }
    },

    async resetKey(key) {
      if (redisDisabled) return;
      try {
        await redis.del(keyFor(key));
      } catch (err) {
        logger.warn({ err, namespace, key }, 'Rate-limit reset failed — non-fatal');
      }
    },
  };
};
