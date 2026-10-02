import type { Job } from 'bullmq';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { syncQueue } from '../lib/queue';
import { redis } from '../lib/redis';
import { invalidatePlaybackSourceCache } from '../lib/playbackCache';
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

// Daily cap, derived from the YouTube Data API free-tier allowance:
//   search.list = 100 units, videos.list = 1 unit  ->  101 units per song
//   99 songs x 101 = 9,999 units/day, inside the 10,000 unit free-tier cap.
// The previous 500 needed 50,500 units/day — 5x the allowance — so after ~99
// songs every remaining attempt returned `403 quotaExceeded` and was counted as
// `failed`, burning the full day's budget in the first 20% of the run.
// A full 923-song catalog therefore needs ~10 days at free tier, which is
// exactly why the follow-up re-queue exists.
export const DAILY_CAP = 99;
const MATCH_DELAY_MS = 100; // politeness delay between YouTube API calls
const PROGRESS_LOG_INTERVAL = 50;
const FOLLOWUP_DELAY_MS = 24 * 60 * 60 * 1000;
const COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;

/**
 * Stage 6.1 — how many consecutive failed match attempts dead-letter a song.
 *
 * The selection query used to be `youtubeVideoId: null` with no notion of past
 * failures, so a song YouTube will never return (obscure track, non-latin
 * title, no official upload) was retried every single day forever, and each
 * retry cost a real `search.list` call (100 units). Over a 923-song catalog
 * that is the difference between reaching the long tail and never reaching it.
 *
 * 5 attempts is chosen so that a genuinely transient failure — an API blip, a
 * 5xx, a daily quota reset landing mid-run — is absorbed without dead-lettering
 * a matchable song, while a permanently unmatchable one is retired after
 * roughly five days of the budget. Songs that DO match reset the counter, so
 * the budget is only ever spent on songs still failing.
 *
 * The counter is deliberately per-song and not a global failure budget: one
 * bad song must not be able to consume the day's allowance.
 */
export const MAX_MATCH_ATTEMPTS = 5;

/**
 * Fixture sentinel, shared with `test/phase3Fixtures.ts`.
 *
 * Under `NODE_ENV=test` the selection query is restricted to rows carrying this
 * prefix so a budget-driven run can only ever select throwaway fixtures. Before
 * this guard the query was `softDeleted: false, youtubeVideoId: null` ordered by
 * `views desc` — against production that selected the *real* highest-viewed
 * songs and wrote `youtubeVideoId` onto them, which is the §1 incident.
 */
export const TEST_FIXTURE_SENTINEL = 'P3TEST';

const isTestEnv = (): boolean => process.env.NODE_ENV === 'test';

export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const processedCounterKey = (key: string) => `library-enrichment:processed:${key}`;

/**
 * Stage 6.1 — the selection predicate for enrichment candidates.
 *
 * Exported so the dead-letter rule has exactly one definition shared by the
 * selection query, the remaining-count query, and the re-queue decision. If
 * those three disagreed, a dead-lettered song would still keep the job
 * re-queueing itself every day for a match it can never get.
 */
export const enrichmentCandidateWhere = (opts: { testOnly?: boolean } = {}) => ({
  softDeleted: false,
  youtubeVideoId: null,
  // Stage 6.1 — never attempt a song that has already been tried MAX times.
  youtubeMatchAttempts: { lt: MAX_MATCH_ATTEMPTS },
  ...(opts.testOnly ? { title: { startsWith: TEST_FIXTURE_SENTINEL } } : {}),
});

/**
 * Stage 6.1 — the complement of `enrichmentCandidateWhere`: songs that have
 * exhausted their attempt budget and are permanently retired from enrichment.
 *
 * Deliberately a separate predicate rather than a spread of the candidate one.
 * The candidate filter is `attempts < MAX`, so overriding it with
 * `attempts >= MAX` would produce the two contradictory bounds in a single
 * object and match nothing — a dead-letter count that always reads zero.
 */
export const deadLetteredSongWhere = (opts: { testOnly?: boolean } = {}) => ({
  softDeleted: false,
  youtubeVideoId: null,
  youtubeMatchAttempts: { gte: MAX_MATCH_ATTEMPTS },
  ...(opts.testOnly ? { title: { startsWith: TEST_FIXTURE_SENTINEL } } : {}),
});

export interface LibraryEnrichmentResult {
  skipped?: boolean;
  reason?: string;
  dayKey: string;
  dailyProcessed: number;
  remainingBefore: number;
  attempted: number;
  matched: number;
  failed: number;
  deadLettered: number;
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
    deadLettered: 0,
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
  // Under test, ONLY sentinel-tagged fixtures are eligible (2.26) — otherwise a
  // budget-driven run reaches straight into the real catalog. Stage 6.1 adds
  // the dead-letter cutoff to the shared predicate.
  const songs = await prisma.song.findMany({
    where: enrichmentCandidateWhere({ testOnly: isTestEnv() }),
    include: { artist: { select: { name: true } } },
    orderBy: { views: 'desc' },
    take: remainingBefore,
  });

  // Progress reporting (2.20). A run can span minutes; without this the job sat
  // at 0% for its entire life and looked hung in the BullMQ dashboard, so nobody
  // could tell "slow" from "wedged". Failures are swallowed: progress telemetry
  // must never fail the run.
  const reportProgress = async () => {
    try {
      await job.updateProgress({
        attempted,
        matched,
        failed,
        total: songs.length,
        dailyCap: DAILY_CAP,
        dailyProcessed: dailyProcessed + attempted,
        percent: songs.length === 0 ? 100 : Math.round((attempted / songs.length) * 100),
      });
    } catch (err) {
      logger.debug({ err, jobId: job.id }, 'Library enrichment progress update failed');
    }
  };

  let attempted = 0;
  let matched = 0;
  let failed = 0;
  let deadLettered = 0;

  for (const song of songs) {
    try {
      // `lookupMatch`, not `searchMatch`: the attempt counter must only advance on
      // a genuine "no such video", never on a quota/auth/network error.
      const result = await youtubeService.lookupMatch(
        song.title,
        song.artist?.name ?? 'Unknown Artist',
      );

      if (result.status === 'matched') {
        await prisma.song.update({
          where: { id: song.id },
          data: {
            youtubeVideoId: result.match.videoId,
            youtubeMatchedAt: new Date(),
            // Reset the streak: a song that matched is no longer a candidate, and
            // if it is ever unmatched again it deserves a full attempt budget.
            youtubeMatchAttempts: 0,
          },
        });
        // The playback source route caches per-song for 1h — invalidate so the
        // freshly matched song resolves to the YouTube tier immediately.
        await invalidatePlaybackSourceCache(song.id);
        matched++;
      } else if (result.status === 'no_match') {
        // Stage 6.1 — the only outcome that counts against the song.
        await prisma.song.update({
          where: { id: song.id },
          data: { youtubeMatchAttempts: { increment: 1 } },
        });
        failed++;
      } else {
        // The lookup did not complete. Nothing was learned about this song, so
        // the counter is left alone and it stays eligible for the next run.
        // Counting this as a failure is what would let an API outage retire the
        // whole catalog after five bad days.
        logger.warn(
          { songId: song.id, reason: result.reason, retryable: result.retryable },
          'YouTube lookup did not complete — song left eligible for retry',
        );
        failed++;
      }
    } catch (err) {
      // A thrown error is our own failure (DB write, cache invalidation), not a
      // verdict on the song. Do not advance the counter.
      logger.warn({ err, songId: song.id }, 'YouTube match failed during library enrichment');
      failed++;
    }

    attempted++;
    await bumpDailyProcessed(today);

    if (attempted % PROGRESS_LOG_INTERVAL === 0) {
      logger.info(
        { jobId: job.id, attempted, matched, failed, deadLettered, dailyCap: DAILY_CAP },
        `Library enrichment progress — ${attempted} songs processed`,
      );
      await reportProgress();
    }

    // Rate limit: 100ms between YouTube API calls.
    await new Promise((r) => setTimeout(r, MATCH_DELAY_MS));
  }

  // Final progress tick, so a short run still leaves a 100% record behind.
  await reportProgress();

  // How many songs are permanently retired, for the run log. Counted after the
  // loop so it reflects the whole day's effect, not just the tail.
  try {
    deadLettered = await prisma.song.count({
      where: deadLetteredSongWhere({ testOnly: isTestEnv() }),
    });
  } catch (err) {
    logger.warn({ err, jobId: job.id }, 'Failed to count dead-lettered songs');
  }

  // Anything still eligible is re-queued for the next day (capped run means
  // the top of the queue is processed first each time it runs).
  //
  // The count uses the same predicate as the selection query, so dead-lettered
  // songs are excluded. Previously this counted every unmatched song, so a
  // catalog whose remainder was all unmatchable would re-queue itself every
  // single day forever and burn the whole daily budget on songs it had already
  // proven cannot be matched.
  let reQueued = false;
  try {
    const remainingSongs = await prisma.song.count({
      where: enrichmentCandidateWhere({ testOnly: isTestEnv() }),
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
        { jobId: job.id, remainingSongs, reQueued, deadLettered },
        'Library enrichment re-queued for next day',
      );
    } else {
      logger.info(
        { jobId: job.id, deadLettered },
        'Library enrichment complete — no eligible songs remain',
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
    deadLettered,
    dailyCapReached: dailyProcessed + attempted >= DAILY_CAP,
    reQueued,
  };

  logger.info({ jobId: job.id, ...summary }, 'Library enrichment run complete');
  return summary;
};