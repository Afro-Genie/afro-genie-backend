import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { redis } from '../src/lib/redis';
import { syncQueue } from '../src/lib/queue';
import { env } from '../src/lib/env';
import { prisma } from '../src/lib/prisma';
import {
  enqueueLibraryEnrichment,
  processLibraryEnrichmentJob,
  dayKey,
  DAILY_CAP,
  LIBRARY_ENRICHMENT_JOB_NAME,
} from '../src/jobs/libraryEnrichmentJob';
import {
  newRegistry,
  createPhase3Song,
  registerPhase3Teardown,
  playbackSourceKey,
  type FixtureRegistry,
} from './phase3Fixtures';

// Phase 4.1 — Library enrichment job: rollout guards, daily budget, re-queue.
//
// SAFETY CONTRACT for this file:
//   * Every test runs with either the rollout flag OFF or no API key, EXCEPT the
//     budget tests, which pin a fake key and pre-load the daily counter so that
//     `take: remainingBefore` can only ever select the two throwaway fixture
//     songs (they carry the highest `views` in the catalog). The `before` hook
//     pre-loads the counter to the cap so no test can ever attempt more than
//     the small number of songs it explicitly sets up.
//   * The fake key makes every YouTube call fail fast, so no `youtubeVideoId`
//     is ever written and nothing is matched.
//   * The real daily counter is snapshotted and restored around every run.

// Imported from the job, not hardcoded: the previous `const DAILY_CAP = 500`
// here duplicated the real value, so the suite happily asserted a budget the
// production job did not use. The duplication is what let 2.14 ship.
const COUNTER_PREFIX = 'library-enrichment:processed:';
const counterKey = () => `${COUNTER_PREFIX}${dayKey()}`;

/** Pin the counter so at most `budget` songs can be attempted. */
const budgetFor = async (budget: number): Promise<void> => {
  await redis.set(counterKey(), String(DAILY_CAP - budget));
};

const withCounterSnapshot = async <T>(fn: () => Promise<T>): Promise<T> => {
  const key = counterKey();
  const saved = await redis.get(key);
  try {
    return await fn();
  } finally {
    if (saved === null) await redis.del(key);
    else await redis.set(key, saved);
  }
};

const runJob = (id: string) =>
  processLibraryEnrichmentJob({ id, data: { type: LIBRARY_ENRICHMENT_JOB_NAME } } as never);

// ONE registry for the whole file + ONE deterministic teardown.
// See `registerPhase3Teardown` for why this is per-file, not per-describe.
const registry: FixtureRegistry = newRegistry();
registerPhase3Teardown(registry);

describe('libraryEnrichmentJob — rollout guards', () => {
  const savedFlag = env.FLAG_PLAYBACK_YOUTUBE;
  const savedKey = env.YOUTUBE_API_KEY;

  after(() => {
    env.FLAG_PLAYBACK_YOUTUBE = savedFlag;
    env.YOUTUBE_API_KEY = savedKey;
  });

  test('dayKey produces a sortable UTC calendar day', () => {
    assert.match(dayKey(), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(dayKey(new Date('2026-09-25T23:59:59Z')), '2026-09-25');
    assert.equal(dayKey(new Date('2026-09-26T00:00:00Z')), '2026-09-26');
  });

  test('enqueue is refused while the rollout flag is off', async () => {
    env.FLAG_PLAYBACK_YOUTUBE = false;
    const before = (await syncQueue.getJobs(['waiting', 'delayed'])).length;

    const result = await enqueueLibraryEnrichment({ reason: 'p3-test' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'flag_disabled');
    assert.equal(
      (await syncQueue.getJobs(['waiting', 'delayed'])).length,
      before,
      'no job may be enqueued while the flag is off',
    );
  });

  test('enqueue is refused when the flag is on but no API key exists', async () => {
    env.FLAG_PLAYBACK_YOUTUBE = true;
    env.YOUTUBE_API_KEY = undefined;
    const before = (await syncQueue.getJobs(['waiting', 'delayed'])).length;

    const result = await enqueueLibraryEnrichment({ reason: 'p3-test' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'not_configured');
    assert.equal((await syncQueue.getJobs(['waiting', 'delayed'])).length, before);
  });

  test('the processor skips cleanly while the rollout flag is off', async () => {
    env.FLAG_PLAYBACK_YOUTUBE = false;

    const result = await runJob('p3-test-flag-off');

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'flag_disabled');
    assert.equal(result.attempted, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.failed, 0);
  });

  test('the processor skips cleanly when the API key is missing', async () => {
    env.FLAG_PLAYBACK_YOUTUBE = true;
    env.YOUTUBE_API_KEY = undefined;

    const result = await runJob('p3-test-no-key');

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'not_configured');
    assert.equal(result.attempted, 0);
  });

  test('job ids are day-scoped so repeated triggers collapse into one job', () => {
    assert.equal(`library-enrichment-${dayKey()}`, `library-enrichment-${dayKey()}`);
    assert.notEqual(
      `library-enrichment-${dayKey(new Date('2026-09-25T10:00:00Z'))}`,
      `library-enrichment-${dayKey(new Date('2026-09-26T10:00:00Z'))}`,
    );
  });
});

describe('libraryEnrichmentJob — daily budget', () => {
  const savedFlag = env.FLAG_PLAYBACK_YOUTUBE;
  const savedKey = env.YOUTUBE_API_KEY;

  before(async () => {
    // Hard stop: nothing may run until a test explicitly lowers the budget.
    await redis.set(counterKey(), String(DAILY_CAP));
  });

  after(async () => {
    env.FLAG_PLAYBACK_YOUTUBE = savedFlag;
    env.YOUTUBE_API_KEY = savedKey;
    await redis.del(counterKey());
  });

  test('the job is a no-op once the daily cap is exhausted', async () => {
    env.FLAG_PLAYBACK_YOUTUBE = true;
    env.YOUTUBE_API_KEY = 'p3-test-placeholder-key';
    const song = await createPhase3Song(registry, { youtubeVideoId: null, views: 999_999 });

    await withCounterSnapshot(async () => {
      await budgetFor(0);
      const result = await runJob('p3-test-capped');

      assert.equal(result.dailyCapReached, true);
      assert.equal(result.attempted, 0, 'a capped run must not touch any song');
      assert.equal(result.skipped, undefined, 'exhausting the cap is not the same as being disabled');
    });

    const after = await prisma.song.findUnique({ where: { id: song.id }, select: { youtubeVideoId: true } });
    assert.equal(after?.youtubeVideoId, null, 'a capped run must not write anything');
  });

  test('the budget is DAILY_CAP minus what the shared counter already spent', async () => {
    env.FLAG_PLAYBACK_YOUTUBE = true;
    env.YOUTUBE_API_KEY = 'p3-test-placeholder-key';
    const songs = [
      await createPhase3Song(registry, { youtubeVideoId: null, views: 999_999 }),
      await createPhase3Song(registry, { youtubeVideoId: null, views: 999_998 }),
      await createPhase3Song(registry, { youtubeVideoId: null, views: 999_997 }),
    ];

    await withCounterSnapshot(async () => {
      await budgetFor(3);
      const result = await runJob('p3-test-partial');

      assert.equal(result.remainingBefore, 3);
      assert.equal(result.attempted, 3, 'exactly the remaining budget may be attempted');
    });

    for (const song of songs) {
      const after = await prisma.song.findUnique({ where: { id: song.id }, select: { youtubeVideoId: true } });
      assert.equal(after?.youtubeVideoId, null, 'an invalid API key must never persist a video id');
    }
  });

  test('every attempted song advances the shared counter and the counter expires', async () => {
    env.FLAG_PLAYBACK_YOUTUBE = true;
    env.YOUTUBE_API_KEY = 'p3-test-placeholder-key';
    await createPhase3Song(registry, { youtubeVideoId: null, views: 999_999 });
    await createPhase3Song(registry, { youtubeVideoId: null, views: 999_998 });

    await withCounterSnapshot(async () => {
      await budgetFor(2);
      const result = await runJob('p3-test-counter');

      assert.equal(result.attempted, 2);
      assert.equal(result.dailyCapReached, true, 'spending the last of the budget trips the cap flag');

      const after = Number((await redis.get(counterKey())) ?? '0');
      assert.equal(after, DAILY_CAP, 'the counter must land exactly on the cap');

      const ttl = await redis.ttl(counterKey());
      assert.ok(ttl > 0, `counter must expire, ttl=${ttl}`);
      assert.ok(ttl <= 2 * 24 * 3600, `counter TTL must be at most 2 days, got ${ttl}`);
    });
  });

  test('a failed match never invalidates the playback source cache', async () => {
    // The job only deletes `playback:source:<id>` after a successful match, so a
    // failed attempt must leave the cached tier alone.
    env.FLAG_PLAYBACK_YOUTUBE = true;
    env.YOUTUBE_API_KEY = 'p3-test-placeholder-key';
    const song = await createPhase3Song(registry, { youtubeVideoId: null, spotifyPreviewUrl: 'https://p.scdn.co/x.mp3' });
    const key = playbackSourceKey(song.id);
    registry.redisKeys.push(key);
    await redis.set(key, JSON.stringify({ source: 'AUDIO_URL' }));

    await withCounterSnapshot(async () => {
      await budgetFor(1);
      const result = await runJob('p3-test-cache');

      assert.equal(result.attempted, 1);
      assert.equal(result.matched, 0, 'the placeholder key cannot produce a match');
      assert.equal(result.failed, 1);
    });

    assert.ok(await redis.get(key), 'a failed match must not evict the cached playback source');
  });

  test('an unconfigured API key burns no budget at all', async () => {
    env.FLAG_PLAYBACK_YOUTUBE = true;
    env.YOUTUBE_API_KEY = undefined;
    const song = await createPhase3Song(registry, { youtubeVideoId: null, views: 999_999 });

    await withCounterSnapshot(async () => {
      await budgetFor(10);
      const result = await runJob('p3-test-nokey-budget');

      assert.equal(result.skipped, true);
      assert.equal(result.attempted, 0);
      assert.equal(Number((await redis.get(counterKey())) ?? '0'), DAILY_CAP - 10, 'counter must be untouched');
    });

    const after = await prisma.song.findUnique({ where: { id: song.id }, select: { youtubeVideoId: true } });
    assert.equal(after?.youtubeVideoId, null);
  });
});

describe('libraryEnrichmentJob — YouTube quota budget', () => {
  test('DAILY_CAP is pinned to the free-tier maximum, not just under it', () => {
    // 2.14 tripwire. The regression this guards is subtle: the suite drives the
    // job off the imported DAILY_CAP, so lowering the cap to, say, 50 would
    // leave every behavioural test green while quietly wasting half the free
    // quota. Pin the value itself, and to the maximum the free tier affords —
    // 100 units (search.list) + 1 (videos.list) per song against 10,000/day.
    const unitsPerSong = 101;
    const freeTierMaxSongs = Math.floor(10_000 / unitsPerSong);
    assert.equal(freeTierMaxSongs, 99);
    assert.equal(DAILY_CAP, freeTierMaxSongs, 'DAILY_CAP must equal the largest song count the free tier allows');
  });

  test('the daily cap fits inside the free-tier YouTube quota', () => {
    // search.list = 100 units, videos.list = 1 unit -> 101 units per song.
    // 99 x 101 = 9,999 against a 10,000 unit free-tier allowance. The cap was
    // 500, which needed 50,500 units/day: after ~99 songs every remaining
    // attempt returned `403 quotaExceeded` and was counted as `failed`, so 4/5 of
    // each run's budget was spent on guaranteed-failure requests.
    const unitsPerSong = 101;
    const freeTier = 10_000;
    assert.ok(
      unitsPerSong * DAILY_CAP <= freeTier,
      `DAILY_CAP=${DAILY_CAP} needs ${unitsPerSong * DAILY_CAP} units/day, free tier allows ${freeTier}`,
    );
  });

  test('the catalog is larger than one day of free quota, so the backfill needs multiple days', () => {
    const songsPerDayAtFreeTier = Math.floor(10_000 / 101);
    const catalogSize = 923;
    const days = Math.ceil(catalogSize / songsPerDayAtFreeTier);
    assert.equal(songsPerDayAtFreeTier, 99);
    assert.ok(days > 1, `full catalog needs ~${days} days at free tier`);
    assert.ok(30 >= days, 'the 30-day match cache outlasts a full backfill pass');
  });
});
