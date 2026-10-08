// ---------------------------------------------------------------------------
// Bandwidth monitoring (Phase 6 / 7.4)
//
// Counts outbound response bytes per HTTP request and rolls them up into Redis
// counters so admins can see egress by day and by route group, and get alerted
// when daily/hourly traffic exceeds configured thresholds.
//
// Keys:
//   bandwidth:daily:<YYYY-MM-DD>          → total outbound bytes for the day
//   bandwidth:hourly:<YYYY-MM-DDTHH>      → bytes for a given UTC hour
//   bandwidth:group:<YYYY-MM-DD>          → hash: routeGroup → bytes
//   bandwidth:alerts                      → list of recent breach alerts
// ---------------------------------------------------------------------------

import type { NextFunction, Request, Response } from 'express';
import { NotificationType, UserRole } from '@prisma/client';
import { redis, scanKeys } from './redis';
import { prisma } from './prisma';
import { logger } from './logger';

export const DAILY_PREFIX = 'bandwidth:daily:';
const HOURLY_PREFIX = 'bandwidth:hourly:';
const GROUP_PREFIX = 'bandwidth:group:';
const ALERT_LIST_KEY = 'bandwidth:alerts';
const ALERT_COOLDOWN_PREFIX = 'bandwidth:alert:cooldown:';

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

export const BANDWIDTH_THRESHOLDS = {
  dailyWarningBytes: 200 * GB,
  dailyCriticalBytes: 500 * GB,
  hourlySpikeBytes: 50 * GB,
} as const;

/**
 * Maximum query window the admin bandwidth endpoints accept.
 * MUST match the `isInt({ min: 1, max: 90 })` validator in `routes/admin/bandwidth.ts`.
 */
export const BANDWIDTH_MAX_QUERY_DAYS = 90;

/**
 * Counter retention.
 *
 * Was `60 * 60 * 24 * 3` (3 days) while the daily endpoint defaults to a 30-day
 * window (and allows up to 90). Every bucket older than 3 days was therefore
 * already gone, so the "last 30 days" chart could only ever contain the last 3
 * days and silently rendered 27 days of zeroes — the admin could not see the
 * trend the alert thresholds are defined against.
 *
 * Derived from the max query window (+1 day of slack) so the TTL can never
 * silently fall below the range the UI asks for.
 */
const CACHE_TTL_SECONDS = 60 * 60 * 24 * (BANDWIDTH_MAX_QUERY_DAYS + 1);

/**
 * Counter flush interval (2.10).
 *
 * Previously every single response performed 6 Redis round-trips
 * (3x INCRBY/HINCRBY + 3x EXPIRE) inline on the response path, all awaited
 * inside `res.end`. At any real request rate that is the dominant per-request
 * cost of the whole app and it added latency to every response just to keep an
 * admin chart current. Bytes are now accumulated in-process and flushed on an
 * interval: 6 ops per *interval* instead of 6 ops per *request*.
 */
export const BANDWIDTH_FLUSH_INTERVAL_MS = 10_000;

const ALERT_COOLDOWN_SECONDS = 60 * 60; // one alert per bucket per hour
const ALERT_LIST_MAX = 100;
const ALERT_CHECK_INTERVAL_MS = 5 * 60 * 1000;

let lastAlertCheckAt = 0;

const utcDay = (d = new Date()): string => d.toISOString().slice(0, 10);
const utcHour = (d = new Date()): string => d.toISOString().slice(0, 13);

const bytesAt = async (key: string): Promise<number> => {
  try {
    const raw = await redis.get(key);
    return raw ? parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
};

// ---------------------------------------------------------------------------
// Route grouping — coarse buckets used for per-endpoint-family attribution
// ---------------------------------------------------------------------------
export function classifyRoute(path: string): string {
  if (path.startsWith('/uploads')) return 'uploads';
  if (path.startsWith('/api/playback')) return 'playback';
  if (path.startsWith('/api/lyrics')) return 'lyrics';
  if (path.startsWith('/api/search')) return 'search';
  if (path.startsWith('/api/songs')) return 'songs';
  if (path.startsWith('/api/catalog')) return 'catalog';
  if (path.startsWith('/api/admin')) return 'admin';
  if (path.startsWith('/api/auth')) return 'auth';
  if (path.startsWith('/api/community')) return 'community';
  if (path.startsWith('/api/translations')) return 'translations';
  if (path.startsWith('/api')) return 'api-other';
  if (path.startsWith('/robots.txt') || path.startsWith('/favicon.ico')) return 'static-other';
  return 'static-other';
}

// ---------------------------------------------------------------------------
// Inbound measurement middleware
// ---------------------------------------------------------------------------
export const bandwidthTrackingMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Use any-typed bindings so Express/Node overloads don't fight the wrapper.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalWrite = res.write.bind(res) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalEnd = res.end.bind(res) as any;

  let outBytes = 0;

  const sizeOf = (chunk: unknown): number => {
    if (!chunk) return 0;
    if (Buffer.isBuffer(chunk)) return chunk.length;
    return Buffer.byteLength(String(chunk));
  };

  res.write = ((chunk: Buffer | Uint8Array | string, encoding?: BufferEncoding, callback?: () => void) => {
    outBytes += sizeOf(chunk);
    return originalWrite(chunk, encoding, callback);
  }) as typeof res.write;

  res.end = ((chunk: Buffer | Uint8Array | string, encoding?: BufferEncoding, callback?: () => void) => {
    outBytes += sizeOf(chunk);
    const result = originalEnd(chunk, encoding, callback);
    if (outBytes > 0) {
      void recordBandwidth(outBytes, classifyRoute(req.path));
    }
    return result;
  }) as typeof res.end;

  next();
};

// ---------------------------------------------------------------------------
// Counter writes + throttled alert evaluation
// ---------------------------------------------------------------------------

// In-process accumulators (2.10). Keyed by the full Redis key so a UTC day/hour
// rollover naturally starts a new bucket. `pendingGroup` is two-level because
// the group counters are hashes, not strings.
const pendingDaily = new Map<string, number>();
const pendingHourly = new Map<string, number>();
const pendingGroup = new Map<string, Map<string, number>>();

let flushTimer: NodeJS.Timeout | null = null;
let flushInFlight: Promise<void> | null = null;

const addToPending = (map: Map<string, number>, key: string, bytes: number): void => {
  map.set(key, (map.get(key) ?? 0) + bytes);
};

const ensureFlushTimer = (): void => {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushBandwidthCounters();
  }, BANDWIDTH_FLUSH_INTERVAL_MS);
  // Never hold the process open just to flush a counter.
  flushTimer.unref?.();
};

/**
 * Drain the in-process accumulators into Redis.
 *
 * The buffer is swapped out *before* any await, so bytes recorded while the
 * flush is in flight land in the next batch rather than being lost or counted
 * twice. Safe to call concurrently — overlapping calls share one flush.
 * Exported so tests and shutdown can force a synchronous flush.
 */
export function flushBandwidthCounters(): Promise<void> {
  if (flushInFlight) return flushInFlight;

  const daily = new Map(pendingDaily);
  const hourly = new Map(pendingHourly);
  const group = new Map(pendingGroup);
  pendingDaily.clear();
  pendingHourly.clear();
  pendingGroup.clear();

  if (daily.size === 0 && hourly.size === 0 && group.size === 0) {
    return Promise.resolve();
  }

  flushInFlight = (async () => {
    const touched = new Set<string>();

    for (const [key, bytes] of daily) {
      try {
        await redis.incrby(key, bytes);
        touched.add(key);
      } catch {
        // Non-fatal when Redis is unavailable (or stubbed in tests).
      }
    }

    for (const [key, bytes] of hourly) {
      try {
        await redis.incrby(key, bytes);
        touched.add(key);
      } catch {
        // Non-fatal.
      }
    }

    for (const [key, groups] of group) {
      try {
        for (const [group, bytes] of groups) {
          await redis.hincrby(key, group, bytes);
        }
        touched.add(key);
      } catch {
        // Non-fatal.
      }
    }

    // One EXPIRE per key per flush rather than one per request.
    for (const key of touched) {
      try {
        await redis.expire(key, CACHE_TTL_SECONDS);
      } catch {
        // Non-fatal.
      }
    }
  })().finally(() => {
    flushInFlight = null;
  });

  return flushInFlight;
}

/** Stop the interval flush and drain whatever is buffered. */
export async function shutdownBandwidthMonitor(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushBandwidthCounters();
}

export function recordBandwidth(bytes: number, group: string): void {
  if (bytes <= 0) return;

  const dailyKey = `${DAILY_PREFIX}${utcDay()}`;
  const hourlyKey = `${HOURLY_PREFIX}${utcHour()}`;
  const groupKey = `${GROUP_PREFIX}${utcDay()}`;

  addToPending(pendingDaily, dailyKey, bytes);
  addToPending(pendingHourly, hourlyKey, bytes);

  let groups = pendingGroup.get(groupKey);
  if (!groups) {
    groups = new Map<string, number>();
    pendingGroup.set(groupKey, groups);
  }
  groups.set(group, (groups.get(group) ?? 0) + bytes);

  ensureFlushTimer();

  const now = Date.now();
  if (now - lastAlertCheckAt < ALERT_CHECK_INTERVAL_MS) return;
  lastAlertCheckAt = now;

  // Flush first so the alert evaluates against counters that include the bytes
  // from this response; the flush interval (10s) is far shorter than the alert
  // cadence (5m) so the buffer is normally empty by now anyway.
  void flushBandwidthCounters().then(() => checkBandwidthAlerts(dailyKey, hourlyKey));
}

async function checkBandwidthAlerts(dailyKey: string, hourlyKey: string): Promise<void> {
  const [dailyBytes, hourlyBytes] = await Promise.all([bytesAt(dailyKey), bytesAt(hourlyKey)]);

  if (dailyBytes >= BANDWIDTH_THRESHOLDS.dailyCriticalBytes) {
    await recordBandwidthAlert('daily-critical', utcDay(), dailyBytes, BANDWIDTH_THRESHOLDS.dailyCriticalBytes);
  } else if (dailyBytes >= BANDWIDTH_THRESHOLDS.dailyWarningBytes) {
    await recordBandwidthAlert('daily-warning', utcDay(), dailyBytes, BANDWIDTH_THRESHOLDS.dailyWarningBytes);
  }

  if (hourlyBytes >= BANDWIDTH_THRESHOLDS.hourlySpikeBytes) {
    await recordBandwidthAlert('hourly-spike', utcHour(), hourlyBytes, BANDWIDTH_THRESHOLDS.hourlySpikeBytes);
  }
}

async function recordBandwidthAlert(
  kind: string,
  bucket: string,
  bytes: number,
  thresholdBytes: number
): Promise<void> {
  const cooldownKey = `${ALERT_COOLDOWN_PREFIX}${kind}:${bucket}`;
  try {
    const alreadyAlerted = await redis.get(cooldownKey);
    if (alreadyAlerted) return;
    await redis.set(cooldownKey, '1', 'EX', ALERT_COOLDOWN_SECONDS);
  } catch {
    // Cooldown unavailable — proceed with alert delivery anyway.
  }

  const gb = (bytes / GB).toFixed(2);
  const alert = {
    kind,
    bucket,
    bytes,
    thresholdBytes,
    gb: parseFloat(gb),
    at: new Date().toISOString(),
  };

  logger.warn({ kind, bucket, gb }, 'Bandwidth threshold breached');

  try {
    await redis.lpush(ALERT_LIST_KEY, JSON.stringify(alert));
    await redis.ltrim(ALERT_LIST_KEY, 0, ALERT_LIST_MAX - 1);
  } catch {
    // Non-fatal.
  }

  try {
    const adminUser = await prisma.user.findFirst({ where: { role: UserRole.ADMIN }, select: { id: true } });
    if (adminUser) {
      await prisma.notification.create({
        data: {
          userId: adminUser.id,
          title: `Bandwidth alert: ${kind}`,
          message: `Bucket "${bucket}" hit ${gb} GB (threshold ${(thresholdBytes / GB).toFixed(0)} GB).`,
          type: NotificationType.SYSTEM,
        },
      });
    }
  } catch {
    // Non-fatal — alert delivery failure shouldn't crash the monitor
  }
}

// ---------------------------------------------------------------------------
// Read endpoints used by the admin routes
// ---------------------------------------------------------------------------
export interface BandwidthDayPoint {
  day: string;
  bytes: number;
}

export const getBandwidthDaily = async (days: number): Promise<BandwidthDayPoint[]> => {
  const from = Date.now() - days * 24 * 60 * 60 * 1000;
  let keys: string[] = [];
  try {
    keys = await scanKeys(`${DAILY_PREFIX}*`);
  } catch {
    keys = [];
  }

  const points: BandwidthDayPoint[] = [];
  for (const key of keys) {
    const day = key.slice(DAILY_PREFIX.length);
    if (new Date(`${day}T00:00:00.000Z`).getTime() < from) continue;
    const bytes = await bytesAt(key);
    points.push({ day, bytes });
  }

  points.sort((a, b) => a.day.localeCompare(b.day));
  return points;
};

export interface BandwidthGroupRow {
  group: string;
  bytes: number;
  pct: number;
}

export const getBandwidthByGroup = async (days: number): Promise<BandwidthGroupRow[]> => {
  const from = Date.now() - days * 24 * 60 * 60 * 1000;
  let keys: string[] = [];
  try {
    keys = await scanKeys(`${GROUP_PREFIX}*`);
  } catch {
    keys = [];
  }

  const totals = new Map<string, number>();
  for (const key of keys) {
    const day = key.slice(GROUP_PREFIX.length);
    if (new Date(`${day}T00:00:00.000Z`).getTime() < from) continue;

    let entries: Record<string, string> = {};
    try {
      entries = await redis.hgetall(key);
    } catch {
      // Skip this bucket on Redis failure.
    }

    for (const [group, rawBytes] of Object.entries(entries)) {
      const bytes = parseInt(rawBytes, 10) || 0;
      totals.set(group, (totals.get(group) ?? 0) + bytes);
    }
  }

  const rows: BandwidthGroupRow[] = [...totals.entries()]
    .map(([group, bytes]) => ({ group, bytes, pct: 0 }))
    .sort((a, b) => b.bytes - a.bytes);

  const grandTotal = rows.reduce((sum, row) => sum + row.bytes, 0);
  for (const row of rows) {
    row.pct = grandTotal > 0 ? parseFloat(((row.bytes / grandTotal) * 100).toFixed(2)) : 0;
  }

  return rows;
};

export interface BandwidthAlert {
  kind: string;
  bucket: string;
  bytes: number;
  thresholdBytes: number;
  gb: number;
  at: string;
}

export const getBandwidthAlerts = async (limit: number): Promise<BandwidthAlert[]> => {
  try {
    const raw = await redis.lrange(ALERT_LIST_KEY, 0, Math.max(1, limit) - 1);
    return raw
      .map((entry) => {
        try {
          return JSON.parse(entry) as BandwidthAlert;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is BandwidthAlert => entry !== null);
  } catch {
    return [];
  }
};

// Attach the middleware to any express app
export const registerBandwidthTracking = (app: { use: (mw: (req: Request, res: Response, next: NextFunction) => void) => void }): void => {
  app.use(bandwidthTrackingMiddleware);
};