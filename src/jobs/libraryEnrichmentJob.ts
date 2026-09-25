import type { Job } from 'bullmq';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { syncQueue } from '../lib/queue';
import { redis } from '../lib/redis';
import { youtubeService } from '../services/youtubeService';
import type { SyncJobData } from './syncWorker';

export const LIBRARY_ENRICHMENT_JOB_NAME = 'library-enrichment';

// Phase 4 — Library Enrichment
// -----------------------------
// Crawls songs that have no YouTube match yet (highest-viewed first), resolves
// each via the YouTube Data API, and persists the video id for the playback
// tier. Runs on the shared syncQueue (concurrency 1) so it never competes with
// artist/song syncs.
//
// Guarantees:
//  - Daily cap: at most DAILY_CAP songs are attempted per UTC day. Progress is
//    tracked in Redis so repeated triggers (cron + manual + post-sync hook) are
//    all throttled against the same budget.
//  - Idempotent: already-matched songs are excluded by the query, and queue
//    dedupe (jobId per day) prevents stacking duplicate jobs.
//  - Self-scheduling: anything left unmatched is re-queued for the next day.

const DAILY_CAP = 500;
const MATCH_DELAY_MS = 100; // YouTube free tier: 10,000 units/day
const PROGRESS_LOG_INTERVAL = 50;
const FOLLOWUP_DELAY_MS = 24 * 60 * 60 * 1000;
const COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;

export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const processedCounterKey = (key: string) => `library-enrichment:processed:${key}`;
const playbackSourceCacheKey = (songId: string) => `playback:source:${songId}`;

export interface LibraryEnrichmentResult {
  skipped?: boolean;
  reason?: string;
  dayKey: string;
  dailyProcessed: number;
  remainingBefore: number;
  attempted: number;
  matched: number;
  failed: number;
  dailyCapReached: boolean;
  reQueued: boolean;
}

export type EnqueueLibraryEnrichmentResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: 'flag_disabled' | 'not_configured' | 'error' };

const isConfigured = (): 'ok' | 'flag_disabled' | 'not_configured' => {
  if (!env.FLAG_PLAYBACK_YOUTUBE) return 'flag_disabled';
  if (!env.YOUTUBE_API_KEY) return 'not_configured';
  return 'ok';
};

/**
 * Enqueue a library-enrichment job on the shared syncQueue.
 *
 * Job ids are namespaced by the UTC day (or a caller-provided id) so repeated
 * triggers within the same day collapse to the same BullMQ job.
 */
export const enqueueLibraryEnrichment = async (opts: {
  reason?: string;
  jobId?: string;
  delayMs?: number;
} = {}): Promise<EnqueueLibraryEnrichmentResult> => {
  const status = isConfigured();
  if (status !== 'ok') {
    logger.info({ status, reason: opts.reason }, 'Library enrichment not queued');
    return { ok: false, reason: status };
  }

  const jobId = opts.jobId ?? `library-enrichment-${dayKey()}`;

  try {
    const job = await syncQueue.add(
      LIBRARY_ENRICHMENT_JOB_NAME,
      { type: LIBRARY_ENRICHMENT_JOB_NAME },
      {
        jobId,
        delay: Math.max(0, opts.delayMs ?? 0),
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    );
    logger.info({ jobId: job?.id ?? jobId, reason: opts.reason }, 'Library enrichment job queued');
    return { ok: true, jobId: job?.id ?? jobId };
  } catch (err) {
    logger.warn({ err, reason: opts.reason }, 'Failed to enqueue library enrichment job');
    return { ok: false, reason: 'error' };
  }
};

const readDailyProcessed = async (key: string): Promise<number> => {
  try {
    const raw = await redis.get(processedCounterKey(key));
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch (err) {
    logger.warn({ err, key }, 'Library enrichment daily counter read failed');
    return 0;
  }
};

const bumpDailyProcessed = async (key: string): Promise<void> => {
  try {
    const counterKey = processedCounterKey(key);
    await redis.incrby(counterKey, 1);
    await redis.expire(counterKey, COUNTER_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, key }, 'Library enrichment daily counter increment failed');
  }
};

export const processLibraryEnrichmentJob = async (
  job: Job<SyncJobData>,
): Promise<LibraryEnrichmentResult> => {
  const status = isConfigured();
  const base = {
    dayKey: dayKey(),
    dailyProcessed: 0,
    remainingBefore: 0,
    attempted: 0,
    matched: 0,
    failed: 0,
    dailyCapReached: false,
    reQueued: false,
  };

  if (status !== 'ok') {
    logger.info({ jobId: job.id, status }, 'Library enrichment skipped');
    return { ...base, skipped: true, reason: status };
  }

  const today = dayKey();
  const dailyProcessed = await readDailyProcessed(today);
  const remainingBefore = Math.max(0, DAILY_CAP - dailyProcessed);

  if (remainingBefore <= 0) {
    logger.info(
      { jobId: job.id, dayKey: today, dailyProcessed, dailyCap: DAILY_CAP },
      'Library enrichment daily cap already reached',
    );
    return { ...base, dayKey: today, dailyProcessed, dailyCapReached: true };
  }

  // Popular songs first: most-loved tracks get playable before the long tail.
  const songs = await prisma.song.findMany({
    where: { softDeleted: false, youtubeVideoId: null },
    include: { artist: { select: { name: true } } },
    orderBy: { views: 'desc' },
    take: remainingBefore,
  });

  let attempted = 0;
  let matched = 0;
  let failed = 0;

  for (const song of songs) {
    try {
      const match = await youtubeService.searchMatch(song.title, song.artist?.name ?? 'Unknown Artist');
      if (match) {
        await prisma.song.update({
          where: { id: song.id },
          data: { youtubeVideoId: match.videoId, youtubeMatchedAt: new Date() },
        });
        // The playback source route caches per-song for 1h — invalidate so the
        // freshly matched song resolves to the YouTube tier immediately.
        try {
          await redis.del(playbackSourceCacheKey(song.id));
        } catch (err) {
          logger.warn({ err, songId: song.id }, 'Failed to invalidate playback source cache');
        }
        matched++;
      } else {
        failed++;
      }
    } catch (err) {
      logger.warn({ err, songId: song.id }, 'YouTube match failed during library enrichment');
      failed++;
    }

    attempted++;
    await bumpDailyProcessed(today);

    if (attempted % PROGRESS_LOG_INTERVAL === 0) {
      logger.info(
        { jobId: job.id, attempted, matched, failed, dailyCap: DAILY_CAP },
        `Library enrichment progress — ${attempted} songs processed`,
      );
    }

    // Rate limit: 100ms between YouTube API calls.
    await new Promise((r) => setTimeout(r, MATCH_DELAY_MS));
  }

  // Anything still unmatched is re-queued for the next day (capped run means
  // the top of the queue is processed first each time it runs).
  let reQueued = false;
  try {
    const remainingSongs = await prisma.song.count({
      where: { softDeleted: false, youtubeVideoId: null },
    });
    if (remainingSongs > 0) {
      const tomorrowKey = dayKey(new Date(Date.now() + FOLLOWUP_DELAY_MS));
      const result = await enqueueLibraryEnrichment({
        reason: 'library-enrichment-followup',
        jobId: `library-enrichment-followup-${tomorrowKey}`,
        delayMs: FOLLOWUP_DELAY_MS,
      });
      reQueued = result.ok;
      logger.info(
        { jobId: job.id, remainingSongs, reQueued },
        'Library enrichment re-queued for next day',
      );
    }
  } catch (err) {
    logger.warn({ err, jobId: job.id }, 'Failed to check remaining unmatched songs');
  }

  const summary: LibraryEnrichmentResult = {
    dayKey: today,
    dailyProcessed: dailyProcessed + attempted,
    remainingBefore,
    attempted,
    matched,
    failed,
    dailyCapReached: dailyProcessed + attempted >= DAILY_CAP,
    reQueued,
  };

  logger.info({ jobId: job.id, ...summary }, 'Library enrichment run complete');
  return summary;
};