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

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 3; // keep 3 days of granularity
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
  if (path.startsWith('/api/spotify')) return 'spotify';
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
export async function recordBandwidth(bytes: number, group: string): Promise<void> {
  if (bytes <= 0) return;

  const dailyKey = `${DAILY_PREFIX}${utcDay()}`;
  const hourlyKey = `${HOURLY_PREFIX}${utcHour()}`;
  const groupKey = `${GROUP_PREFIX}${utcDay()}`;

  try {
    await redis.incrby(dailyKey, bytes);
    await redis.expire(dailyKey, CACHE_TTL_SECONDS);
    await redis.incrby(hourlyKey, bytes);
    await redis.expire(hourlyKey, CACHE_TTL_SECONDS);
    await redis.hincrby(groupKey, group, bytes);
    await redis.expire(groupKey, CACHE_TTL_SECONDS);
  } catch {
    // Non-fatal when Redis is unavailable (or stubbed in tests).
  }

  const now = Date.now();
  if (now - lastAlertCheckAt < ALERT_CHECK_INTERVAL_MS) return;
  lastAlertCheckAt = now;

  void checkBandwidthAlerts(dailyKey, hourlyKey);
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