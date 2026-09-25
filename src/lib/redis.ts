import * as dns from 'node:dns';
import IORedis, { type RedisOptions } from 'ioredis';
import { env } from './env';

const globalForRedis = globalThis as unknown as { redis?: IORedis };

const redisDisabled = process.env.DISABLE_REDIS === 'true';

// ─── DNS resilience ─────────────────────────────────────────────────────────
// The managed Redis hostname can intermittently fail to resolve (ENOTFOUND)
// on flaky resolvers, which makes ioredis retry the lookup on every reconnect
// and leaves callers waiting on the offline queue. To avoid that we resolve
// the hostname ONCE at boot and connect directly to the IP (with the original
// hostname passed as the TLS SNI/servername, so Upstash's certificate still
// validates). If resolution fails at boot we fall back to the hostname and
// let ioredis retry in the background as before.
// `dns.lookupSync` exists at runtime (Node ≥ 0.11) but is missing from the
// installed @types/node — resolve it via a narrow typed cast.
const dnsLookupSync = (dns as unknown as {
  lookupSync(hostname: string, options?: { family?: number }): string;
}).lookupSync;

function resolveHostIp(hostname: string, preferFamily = 4): string | null {
  try {
    return dnsLookupSync(hostname, { family: preferFamily });
  } catch {
    try {
      return dnsLookupSync(hostname);
    } catch {
      return null;
    }
  }
}

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

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(env.REDIS_URL);
  } catch {
    return new IORedis(env.REDIS_URL, common);
  }

  const hostname = parsedUrl.hostname;
  const port = parsedUrl.port ? Number(parsedUrl.port) : parsedUrl.protocol === 'rediss:' ? 6380 : 6379;
  const useTls = parsedUrl.protocol === 'rediss:';
  const db = parsedUrl.pathname && parsedUrl.pathname !== '/' ? Number(parsedUrl.pathname.slice(1)) || 0 : 0;

  const resolvedIp = hostname ? resolveHostIp(hostname) : null;
  if (resolvedIp && resolvedIp !== hostname) {
    // Repeat lookups in ioredis' reconnect loop are skipped entirely.
    return new IORedis({
      ...common,
      host: resolvedIp,
      port,
      db,
      username: parsedUrl.username ? decodeURIComponent(parsedUrl.username) : undefined,
      password: parsedUrl.password ? decodeURIComponent(parsedUrl.password) : undefined,
      ...(useTls ? { tls: { servername: hostname } } : {}),
    });
  }

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