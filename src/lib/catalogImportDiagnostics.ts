import type { Job } from 'bullmq';
import { env } from './env';
import { redis } from './redis';

const HEARTBEAT_KEY = 'workers:catalog-import:heartbeat';

export interface CatalogImportWorkerStatus {
  available: boolean;
  lastSeenAt: string | null;
  ageSeconds: number | null;
  message: string;
}

export interface JobStallInfo {
  stalled: boolean;
  ageSeconds: number;
  lastProgressAt: string;
  reason: string;
}

export async function markCatalogImportWorkerAlive(): Promise<void> {
  await redis.set(HEARTBEAT_KEY, new Date().toISOString(), 'EX', 120);
}

export async function getCatalogImportWorkerStatus(): Promise<CatalogImportWorkerStatus> {
  try {
    const lastSeenAt = await redis.get(HEARTBEAT_KEY);
    if (!lastSeenAt) {
      return {
        available: false,
        lastSeenAt: null,
        ageSeconds: null,
        message: 'No catalog import worker has connected yet. Check that the backend is running with ENABLE_WORKERS=true.',
      };
    }
    const timestamp = Date.parse(lastSeenAt);
    const ageSeconds = Number.isFinite(timestamp) ? Math.max(0, Math.round((Date.now() - timestamp) / 1000)) : null;
    const available = ageSeconds !== null && ageSeconds <= 120;
    return {
      available,
      lastSeenAt,
      ageSeconds,
      message: available
        ? 'Catalog import worker is connected.'
        : `Catalog import worker last reported ${ageSeconds ?? 'an unknown number of'} seconds ago. Restart the backend or check its Redis connection.`,
    };
  } catch (error) {
    return {
      available: false,
      lastSeenAt: null,
      ageSeconds: null,
      message: `Import worker status could not be read: ${error instanceof Error ? error.message : 'Redis unavailable'}.`,
    };
  }
}

export function getJobLastProgressAt(job: Job): number {
  const progress = job.progress as { lastUpdatedAt?: string; startedAt?: string } | null | number;
  if (progress && typeof progress === 'object') {
    const timestamp = Date.parse(progress.lastUpdatedAt || progress.startedAt || '');
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return job.processedOn || job.timestamp;
}

export function getJobStallInfo(job: Job, now = Date.now()): JobStallInfo {
  const lastProgress = getJobLastProgressAt(job);
  const ageSeconds = Math.max(0, Math.round((now - lastProgress) / 1000));
  const stalled = ageSeconds * 1000 >= env.YOUTUBE_IMPORT_STALL_MS;
  return {
    stalled,
    ageSeconds,
    lastProgressAt: new Date(lastProgress).toISOString(),
    reason: stalled
      ? `No progress update for ${Math.floor(ageSeconds / 60)} minute(s). The worker may be offline, Redis may be unavailable, or an external API call may be hung.`
      : '',
  };
}
