import IORedis, { type RedisOptions } from 'ioredis';
import { env } from './env';

const globalForRedis = globalThis as unknown as { redis?: IORedis };

const redisDisabled = process.env.DISABLE_REDIS === 'true';

// ─── DNS ────────────────────────────────────────────────────────────────────
// An earlier version of this file tried to pin the managed-Redis hostname to a
// resolved IP at boot, to avoid re-resolving on every ioredis reconnect. It
// claimed `dns.lookupSync` existed at runtime while being "missing from
// @types/node" and reached it through a cast — but Node has never exposed a
// synchronous `dns.lookupSync`, so the call always threw, was swallowed by the
// surrounding `try`, and `resolveHostIp()` always returned null. The whole
// block was dead code that read as if a working optimisation were in place.
//
// It is removed rather than ported to the async `dns.resolve*` family because:
//   * resolving here bought nothing — ioredis resolves the hostname itself, and
//     the hostname is stable for a managed instance;
//   * boot-time IP pinning is actively risky with TLS: the certificate must
//     still validate against the original hostname via SNI, so an IP-pinned
//     client can fail TLS in a way hostname-based connection cannot;
//   * `buildRedisClient()` is called synchronously at import time, so a correct
//     `dns.resolve*` implementation would force the whole client construction
//     (and therefore `redis`) to become async.
// Reconnect behaviour is already bounded by the `retryStrategy` below.
function buildRedisClient(): IORedis {
  const common: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    enableOfflineQueue: true,
    connectTimeout: 5000,
    commandTimeout: 5000,
    // Bound total reconnect backoff (~35s max) so a genuinely unreachable Redis
    // ends the connection and flushes queued commands with an error instead of
    // queueing them forever (which previously hung tests and health checks).
    retryStrategy(times: number) {
      if (times > 8) return null;
      return Math.min(times * 400, 4000);
    },
  };

  // Connect by URL. ioredis parses the scheme/host/port/db/credentials itself and
  // resolves the hostname, so no boot-time resolution is needed (see the DNS note
  // above for why the previous IP-pinning path was removed).
  return new IORedis(env.REDIS_URL, common);
}

const stubRedis = {
  get: async () => null,
  set: async () => 'OK',
  del: async () => 0,
  incrby: async () => 0,
  decrby: async () => 0,
  incr: async () => 1,
  expire: async () => 1,
  ping: async () => 'PONG',
  quit: async () => 'OK',
  on: () => undefined,
  scan: async () => ['0', []] as [cursor: string, keys: string[]],
  exists: async () => 0,
  ttl: async () => -2,
  pttl: async () => -1,
  zincrby: async () => 0,
  zrevrange: async () => [],
  zrange: async () => [],
  sadd: async () => 1,
  srem: async () => 1,
  hget: async () => null,
  hset: async () => 'OK',
} as unknown as IORedis;

export const redis =
  globalForRedis.redis ??
  (redisDisabled ? stubRedis : buildRedisClient());

if (!redisDisabled) {
  redis.on('error', (err) => {
    console.error('[Redis] Connection error:', err.message);
  });
}

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
}

// Non-blocking KEYS replacement: SCAN in batches instead of a single O(N) KEYS call.
export async function scanKeys(pattern: string, batchSize = 500): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', batchSize);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}