import { describe, test, before, after, beforeEach, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { env } from '../src/lib/env';
import { syncQueue, rewardQueue } from '../src/lib/queue';
import { youtubeService, youtubeMatchCacheKey } from '../src/services/youtubeService';
import { featureFlags } from '../src/config/featureFlags';
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
  createPhase3User,
  registerPhase3Teardown,
  startPhase3Harness,
  cleanupPhase3Fixtures,
  playbackSourceKey,
  viewCounterKey,
  type FixtureRegistry,
  type Harness,
} from './phase3Fixtures';

// ===========================================================================
// Phase 4 — Playback Launch & Library Enrichment: comprehensive rollout test.
//
// SPEC COVERAGE
//   4.1 Library enrichment job — queue wiring, budget, success path, re-queue
//   4.2 Feature flag           — env wiring, backend + frontend defaults, gating
//   4.3 Spotify -> YouTube     — the 10-item migration checklist, measured live
//
// SAFETY CONTRACT
//   * All rows are sentinel-tagged fixtures from `phase3Fixtures`; cleanup is
//     scoped to the captured ids and asserts that nothing leaked.
//   * The shared daily budget counter `library-enrichment:processed:<day>` is
//     snapshotted and restored around every run, so a test can never leave
//     production enrichment budget consumed.
//   * No test needs a real YOUTUBE_API_KEY: `globalThis.fetch` is stubbed for
//     every googleapis.com call, and a real key is never used. Nothing here can
//     write a genuine YouTube video id onto a real song.
//   * Fixture songs use `views = 2_000_000_000` (catalog max is 49,713) so they
//     are always first in the `orderBy: { views: 'desc' }` selection, which keeps
//     `pinBudget(n)` deterministic.
//
// REPO CONVENTION: real defects are pinned with `BUG (documented):` / `FAILS`
// tests that assert CURRENT behaviour and carry the fix in the message.
// ===========================================================================

const execFileAsync = promisify(execFile);
const BACKEND_ROOT = path.resolve(__dirname, '..');
const FRONTEND_ROOT = path.resolve(BACKEND_ROOT, '..', 'afro-genie');

const COUNTER_KEY = () => `library-enrichment:processed:${dayKey()}`;
const SAFE_VIEWS = 2_000_000_000; // Int32 max is 2147483647

// Import-time flag snapshot: `featureFlags` is frozen at module load, whereas
// `env.FLAG_PLAYBACK_YOUTUBE` is mutable. Compare against the snapshot.
const FLAG_AT_IMPORT = featureFlags.PLAYBACK_YOUTUBE;
const ENV_FLAG_AT_IMPORT = env.FLAG_PLAYBACK_YOUTUBE;

// ONE registry for the whole file + ONE deterministic teardown.
const registry: FixtureRegistry = newRegistry();

/**
 * `cleanupPhase3Fixtures` only deletes the exact keys a test remembered to
 * register. The enrichment job, however, selects songs by `orderBy views desc`
 * and caches a match under `youtube:match:<title>:<artist>` for WHATEVER it
 * picked — keys a test cannot know up front. Those leaked into production
 * Redis with the real 30-day TTL.
 *
 * Registered BEFORE `registerPhase3Teardown` on purpose: Node runs `after`
 * hooks FIFO and the shared teardown ends with `redis.quit()`, so a sweep
 * registered after it would run on a closed connection.
 */
const sweepSentinelRedisKeys = async (): Promise<number> => {
  const songScoped = registry.songIds.flatMap((id) => [playbackSourceKey(id), viewCounterKey(id)]);
  // Matches both the pre-Phase-B key format and the versioned v2 one, so a
  // format change cannot strand sentinel keys in production Redis.
  const globs = [
    ...(await redis.keys('youtube:match:p3test-*')),
    ...(await redis.keys('youtube:match:v2:p3test-*')),
  ];
  const all = [...new Set([...songScoped, ...globs])];
  if (all.length > 0) await redis.del(...all);
  return all.length;
};

after(async () => {
  const swept = await sweepSentinelRedisKeys().catch((e) => {
    console.error('[phase4] sentinel sweep failed', e);
    return 0;
  });
  if (swept > 0) console.log(`[phase4] swept ${swept} sentinel Redis key(s) after the run`);
});

registerPhase3Teardown(registry);

// ---------------------------------------------------------------------------
// YouTube fetch stub — installed at module scope so it is live before any test.
// Any non-YouTube URL falls through to the real fetch; any YouTube URL without
// a stub installed is a hard failure, so a test can never silently hit the API.
// ---------------------------------------------------------------------------

interface YouTubeStub {
  search: unknown;
  videos: unknown;
  searchStatus?: number;
  videosStatus?: number;
  /** When true, the stubbed request rejects as if the network dropped. */
  networkError?: boolean;
  /** Phase C — `channels.list` response for the uploads-playlist lookup. */
  channels?: unknown;
  /** Phase C — `playlistItems.list` response for the upload walk. */
  playlistItems?: unknown;
  channelsStatus?: number;
  playlistItemsStatus?: number;
}

/**
 * Build a stub whose result genuinely matches `(songTitle, artistName)`.
 *
 * Phase B means a match now requires the candidate's title and channel to
 * actually correspond to the song, so every "this should match" test has to
 * describe a real match rather than an arbitrary payload. This is the one place
 * that knows how, so the individual tests stay readable.
 *
 * `iso` sets the video duration so the duration-drift gate can be exercised;
 * `omitVideos` simulates a `videos.list` failure.
 */
const matchingStub = (
  videoId: string,
  songTitle: string,
  artistName: string,
  opts: {
    iso?: string | null;
    embeddable?: boolean;
    channelTitle?: string;
    omitVideos?: boolean;
    videosStatus?: number;
  } = {},
) => ({
  search: {
    items: [
      {
        id: { videoId },
        snippet: {
          title: `${songTitle} (Official Video)`,
          channelTitle: opts.channelTitle ?? artistName,
          thumbnails: { high: { url: `https://i.ytimg.com/vi/${videoId}/hq.jpg` } },
        },
      },
    ],
  },
  videos: opts.omitVideos
    ? {}
    : {
        items: [
          {
            id: videoId,
            contentDetails: { duration: opts.iso ?? 'PT3M0S' },
            status: { embeddable: opts.embeddable ?? true },
          },
        ],
      },
  ...(opts.videosStatus !== undefined ? { videosStatus: opts.videosStatus } : {}),
});

let stub: YouTubeStub | null = null;
let youtubeCalls: string[] = [];

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/**
 * A search response whose single result IS the song being searched for.
 *
 * Phase B validates candidates instead of trusting `items[0]`, so a stub whose
 * title is unrelated to the song no longer matches — correctly. Each test that
 * expects a match now passes the song's own title and artist, and keeps full
 * control over the channel title so the `channelTitle` assertions still hold.
 *
 * `durationSeconds` rides on `contentDetails` only when `iso` is supplied;
 * `embeddable` defaults to true because a video the IFrame player cannot embed
 * is rejected before it is ever scored.
 */
/** Duration-only `videos.list` stub body, for tests that only assert the parse. */
const videosBody = (iso: string, videoId = 'ph4detailsvid1') => ({
  items: [{ id: videoId, contentDetails: { duration: iso }, status: { embeddable: true } }],
});

const installYouTubeStub = (next: YouTubeStub) => {
  stub = next;
  youtubeCalls = [];
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith('https://www.googleapis.com/youtube/v3/')) {
    return realFetch(input as RequestInfo, init);
  }
  youtubeCalls.push(url.replace(/key=[^&]*/, 'key=REDACTED'));
  if (!stub) {
    throw new Error(`Phase 4 test: YouTube fetch attempted with no stub installed (${url})`);
  }
  if (stub.networkError) {
    throw new Error('simulated socket failure');
  }
  if (url.includes('/search')) {
    return jsonResponse(stub.search, stub.searchStatus ?? 200) as unknown as Response;
  }
  if (url.includes('/videos')) {
    return jsonResponse(stub.videos, stub.videosStatus ?? 200) as unknown as Response;
  }
  // Phase C — the cheap enumeration path. Checked before `/search` would match
  // "playlistItems" containing neither substring, so order is immaterial here.
  if (url.includes('/channels')) {
    return jsonResponse(stub.channels ?? {}, stub.channelsStatus ?? 200) as unknown as Response;
  }
  if (url.includes('/playlistItems')) {
    return jsonResponse(stub.playlistItems ?? {}, stub.playlistItemsStatus ?? 200) as unknown as Response;
  }
  throw new Error(`Phase 4 test: unexpected YouTube URL ${url}`);
}) as typeof globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// shared daily-budget counter helpers
// ---------------------------------------------------------------------------

// The counter is a LIVE production key, so the snapshot must capture the TTL
// as well as the value: a bare `SET` would silently make the key permanent and
// leave a real daily budget behind forever.
const COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;

type CounterSnapshot = { value: string | null; ttl: number };

const snapshotCounter = async (): Promise<CounterSnapshot> => ({
  value: await redis.get(COUNTER_KEY()),
  ttl: await redis.ttl(COUNTER_KEY()),
});

const restoreCounter = async (saved: CounterSnapshot): Promise<void> => {
  if (saved.value === null) {
    await redis.del(COUNTER_KEY());
    return;
  }
  if (saved.ttl > 0) {
    await redis.set(COUNTER_KEY(), saved.value, 'EX', saved.ttl);
  } else {
    // ttl === -1 => persistent, ttl === -2 => the key did not exist.
    await redis.set(COUNTER_KEY(), saved.value);
  }
};

/** Pin the shared counter so at most `budget` songs can ever be selected. */
const pinBudget = async (budget: number): Promise<void> => {
  await redis.set(COUNTER_KEY(), String(DAILY_CAP - budget), 'EX', COUNTER_TTL_SECONDS);
};

const runJob = (id: string) =>
  processLibraryEnrichmentJob({ id, data: { type: LIBRARY_ENRICHMENT_JOB_NAME } } as never);

/**
 * The production match-cache key.
 *
 * Phase B versioned it to `youtube:match:v2:` so pre-validation entries (which
 * hold an unvalidated `items[0]` result) are retired rather than served. This
 * delegates to the service so the two cannot drift — the previous test-local
 * literal had exactly that problem.
 */
const matchCacheKey = (title: string, artist: string) => youtubeMatchCacheKey(title, artist);

const artistNameOf = async (artistId: string): Promise<string> => {
  const artist = await prisma.artist.findUnique({ where: { id: artistId }, select: { name: true } });
  return artist!.name;
};

const saveFlagState = () => ({ flag: env.FLAG_PLAYBACK_YOUTUBE, key: env.YOUTUBE_API_KEY });

const restoreFlagState = (saved: { flag: boolean; key?: string }) => {
  env.FLAG_PLAYBACK_YOUTUBE = saved.flag;
  env.YOUTUBE_API_KEY = saved.key;
};

const readBackendFile = (...parts: string[]) =>
  readFile(path.join(BACKEND_ROOT, ...parts), 'utf8');

/** Run a snippet in a child process with FLAG_PLAYBACK_YOUTUBE pinned. */
const flagInChildProcess = async (value: string | undefined): Promise<boolean> => {
  const script =
    "import {featureFlags} from './src/config/featureFlags';console.log(String(featureFlags.PLAYBACK_YOUTUBE));";
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
  if (value === undefined) delete childEnv.FLAG_PLAYBACK_YOUTUBE;
  else childEnv.FLAG_PLAYBACK_YOUTUBE = value;

  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: BACKEND_ROOT,
    env: childEnv,
  });
  return stdout.trim() === 'true';
};

// ===========================================================================
// A. Phase 4.2 — Feature flag wiring
// ===========================================================================

describe('Phase 4.2 — feature flag wiring', () => {
  test('the PLAYBACK_YOUTUBE flag mirrors env.FLAG_PLAYBACK_YOUTUBE at import time', () => {
    assert.equal(typeof FLAG_AT_IMPORT, 'boolean');
    assert.equal(FLAG_AT_IMPORT, ENV_FLAG_AT_IMPORT, 'config/featureFlags must read the zod env value');
  });

  test('the rollout flag defaults to OFF when FLAG_PLAYBACK_YOUTUBE is absent', async () => {
    assert.equal(await flagInChildProcess(undefined), false, 'unset FLAG_PLAYBACK_YOUTUBE must resolve to false');
  });

  test('FLAG_PLAYBACK_YOUTUBE=true/1 turns the flag ON (the flag is not hard-wired off)', async () => {
    for (const value of ['true', '1']) {
      assert.equal(await flagInChildProcess(value), true, `FLAG_PLAYBACK_YOUTUBE=${value} must enable the flag`);
    }
  });

  test('garbage values fall back to the schema default (false), never a crash', async () => {
    for (const value of ['yes', 'on', '  ', 'TrUe']) {
      assert.equal(await flagInChildProcess(value), false, `FLAG_PLAYBACK_YOUTUBE="${value}" must stay off`);
    }
  });

  test('.env.example documents both the API key and the flag defaulting to OFF', async () => {
    const raw = await readBackendFile('.env.example');
    assert.match(raw, /YOUTUBE_API_KEY=/, '.env.example must document YOUTUBE_API_KEY');
    assert.match(raw, /FLAG_PLAYBACK_YOUTUBE=false/, '.env.example must ship the flag off');
  });

  test('the frontend ships youtubePlayback OFF by default', async () => {
    const raw = await readFile(path.join(FRONTEND_ROOT, 'config', 'featureFlags.ts'), 'utf8');
    assert.match(raw, /VITE_FLAG_PLAYBACK_YOUTUBE/, 'flag must be readable from the Vite env var');
    const block = raw.slice(raw.indexOf('youtubePlayback'));
    assert.match(
      block.slice(0, 300),
      /false\s*,?\s*\)/,
      'youtubePlayback must default to false so the legacy player stays active',
    );
  });

  test('FIXED (2.15): the backend flag gates the YouTube tier in getPlaybackSource', async () => {
    // The gate is enforced inside `youtubeService.getPlaybackSource()` (the
    // server-side lever that a cached frontend bundle cannot bypass), not via
    // `featureGate('PLAYBACK_YOUTUBE')` in app.ts.
    const serviceRaw = await readBackendFile('src', 'services', 'youtubeService.ts');
    assert.match(
      serviceRaw,
      /youtubePlaybackEnabled\(\)/,
      'getPlaybackSource must consult FLAG_PLAYBACK_YOUTUBE',
    );

    const appRaw = await readBackendFile('src', 'app.ts');
    assert.ok(
      !/featureGate\(\s*['"]PLAYBACK_YOUTUBE['"]/.test(appRaw),
      'the gate lives in the service, so app.ts mounts no featureGate for it',
    );

    const song = await createPhase3Song(registry, { youtubeVideoId: 'flagGateProbe01' });
    const saved = saveFlagState();
    try {
      env.FLAG_PLAYBACK_YOUTUBE = false;
      const off = await youtubeService.getPlaybackSource(song.id);
      assert.notEqual(
        off.source,
        'YOUTUBE',
        'flag OFF must not hand out the YouTube tier — a bad match is recoverable server-side',
      );

      env.FLAG_PLAYBACK_YOUTUBE = true;
      const on = await youtubeService.getPlaybackSource(song.id);
      assert.equal(on.source, 'YOUTUBE', 'flag ON must hand out the YouTube tier');
    } finally {
      restoreFlagState(saved);
    }
  });

  test('the flag gates library enrichment (the one place it is actually enforced)', async () => {
    const saved = saveFlagState();
    try {
      env.FLAG_PLAYBACK_YOUTUBE = false;
      env.YOUTUBE_API_KEY = 'phase4-stub-key';
      const skipped = await runJob('p4-flag-gate');
      assert.equal(skipped.skipped, true);
      assert.equal(skipped.reason, 'flag_disabled');
      assert.equal(skipped.attempted, 0);
    } finally {
      restoreFlagState(saved);
    }
  });
});

// ===========================================================================
// B. Phase 4.1 — Library enrichment job: the success path (stubbed YouTube)
// ===========================================================================

describe('Phase 4.1 — library enrichment success path', () => {
  const saved = saveFlagState();
  let counterBefore: CounterSnapshot | null = null;

  beforeEach(async () => {
    // Isolate the job's candidate set: fixtures share the same sentinel view
    // count, so a leftover song from a sibling test can win the `views desc`
    // tie and be matched instead of this test's song.
    await cleanupPhase3Fixtures(registry);
    counterBefore = await snapshotCounter();
    assert.ok(counterBefore, 'snapshotCounter must return a snapshot');
    env.FLAG_PLAYBACK_YOUTUBE = true;
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
  });

  afterEach(async () => {
    if (counterBefore) await restoreCounter(counterBefore);
  });

  after(() => restoreFlagState(saved));

  test('a successful match persists the video id, stamps it, and evicts the playback cache', async () => {
    const song = await createPhase3Song(registry, { youtubeVideoId: null, views: SAFE_VIEWS });
    // Phase B: the stub must offer a video that is actually this song. The
    // fixture duration is 180_000ms, so PT3M0S sits inside the drift gate.
    installYouTubeStub(matchingStub('ph4successvid1', song.title, await artistNameOf(song.artistId), { iso: 'PT3M0S' }));
    const key = playbackSourceKey(song.id);
    registry.redisKeys.push(key);
      // Seed a stale playback:source answer; a successful match must invalidate it.
      // Seed WITH a TTL: a bare SET leaves a permanent key behind if the run dies.
      await redis.set(key, JSON.stringify({ source: 'AUDIO_URL' }), 'EX', 300);

    await pinBudget(1);
    const result = await runJob('p4-success');

    assert.equal(result.skipped, undefined);
    assert.equal(result.attempted, 1);
    assert.equal(result.matched, 1, 'the stubbed YouTube response must produce a match');
    assert.equal(result.failed, 0);

    const after = await prisma.song.findUnique({
      where: { id: song.id },
      select: { youtubeVideoId: true, youtubeMatchedAt: true },
    });
    assert.equal(after?.youtubeVideoId, 'ph4successvid1');
    assert.ok(after?.youtubeMatchedAt instanceof Date, 'youtubeMatchedAt must be stamped');
    assert.ok(
      Date.now() - after!.youtubeMatchedAt!.getTime() < 120_000,
      'youtubeMatchedAt must be ~now',
    );

    assert.equal(await redis.get(key), null, 'a successful match must evict the stale playback:source entry');
    assert.equal(
      Number((await redis.get(COUNTER_KEY())) ?? '0'),
      DAILY_CAP,
      'a successful attempt must still consume one unit of budget',
    );
  });

  test('the newly matched song immediately resolves to the YOUTUBE tier over HTTP', async () => {
    // End-to-end: the job writes the id, then the playback route serves the new tier.
    const harness = await startPhase3Harness();
    try {
      const song = await createPhase3Song(registry, {
        youtubeVideoId: null,
        spotifyPreviewUrl: 'https://p.scdn.co/p4-e2e.mp3',
        views: SAFE_VIEWS,
      });
      installYouTubeStub(matchingStub('ph4e2evid00001', song.title, await artistNameOf(song.artistId), { iso: 'PT3M0S' }));
      const key = playbackSourceKey(song.id);
      registry.redisKeys.push(key);

      // Warm the cache with the pre-match tier (NONE — no own audio yet), so
      // invalidation is load-bearing.
      const warm = await harness.request('GET', `/api/playback/${song.id}/source`);
      assert.equal(warm.body.source, 'NONE');

      await pinBudget(1);
      const result = await runJob('p4-e2e');
      assert.equal(result.matched, 1);

      const res = await harness.request('GET', `/api/playback/${song.id}/source`);
      assert.equal(res.status, 200);
      assert.equal(res.body.source, 'YOUTUBE', 'cache eviction must let the new tier win');
      assert.equal(res.body.youtubeVideoId, 'ph4e2evid00001');
      assert.ok(!('previewUrl' in res.body), 'no previewUrl field after the Phase 3 removal');
    } finally {
      await harness.close();
    }
  });

  test('a 403 quotaExceeded response counts as failed and is never cached', async () => {
    installYouTubeStub({
      search: { error: { code: 403, message: 'quotaExceeded' } },
      videos: {},
      searchStatus: 403,
    });
    const song = await createPhase3Song(registry, { youtubeVideoId: null, views: SAFE_VIEWS });
    registry.redisKeys.push(matchCacheKey(song.title, await artistNameOf(song.artistId)));

    await pinBudget(1);
    const result = await runJob('p4-quota');

    assert.equal(result.attempted, 1);
    assert.equal(result.matched, 0);
    assert.equal(result.failed, 1, 'a 403 must be counted as a failed match');

    const after = await prisma.song.findUnique({
      where: { id: song.id },
      select: { youtubeVideoId: true },
    });
    assert.equal(after?.youtubeVideoId, null);
    assert.equal(
      await redis.get(matchCacheKey(song.title, await artistNameOf(song.artistId))),
      null,
      'failures must not be cached — otherwise a transient 403 is sticky for 30 days',
    );
  });

  test('a duration-lookup failure still yields a usable match, with duration unknown rather than 0 (2.21)', async () => {
    const song = await createPhase3Song(registry, { youtubeVideoId: null, views: SAFE_VIEWS });
    const artist = await artistNameOf(song.artistId);
    installYouTubeStub(matchingStub('ph4noduration1', song.title, artist, { omitVideos: true, videosStatus: 500 }));
    registry.redisKeys.push(matchCacheKey(song.title, artist));

    await pinBudget(1);
    const result = await runJob('p4-noduration');

    assert.equal(result.matched, 1, 'a videos.list failure must not lose the match');
    const after = await prisma.song.findUnique({
      where: { id: song.id },
      select: { youtubeVideoId: true },
    });
    assert.equal(after?.youtubeVideoId, 'ph4noduration1');

    // "Unknown" must not be represented as 0. A 0 is a real value here: YouTube
    // reports `PT0S` for a live stream.
    const match = await youtubeService.searchMatch(song.title, artist);
    assert.equal(match?.durationSeconds, null,
      'an unusable duration must stay null, not collapse to 0');
  });

  test('each attempt is rate limited (~100ms) so the YouTube quota is not bursted', async () => {
    for (const views of [SAFE_VIEWS, SAFE_VIEWS - 1, SAFE_VIEWS - 2]) {
      const song = await createPhase3Song(registry, { youtubeVideoId: null, views });
      installYouTubeStub(
        matchingStub('ph4ratelimit01', song.title, await artistNameOf(song.artistId), { iso: 'PT3M0S' }),
      );
    }

    await pinBudget(3);
    const started = Date.now();
    const result = await runJob('p4-ratelimit');
    const elapsed = Date.now() - started;

    assert.equal(result.attempted, 3);
    // 3 attempts => 3 trailing 100ms sleeps (the plan's "100ms between calls").
    assert.ok(elapsed >= 250, `expected >=250ms of rate limiting, got ${elapsed}ms`);
  });

  test('a matched song is excluded from the next run (idempotent, no re-work)', async () => {
    const song = await createPhase3Song(registry, { youtubeVideoId: null, views: SAFE_VIEWS });
    installYouTubeStub(
      matchingStub('ph4idempotent1', song.title, await artistNameOf(song.artistId), { iso: 'PT3M0S' }),
    );

    await pinBudget(1);
    const first = await runJob('p4-idem-1');
    assert.equal(first.matched, 1);

    // Second run must not re-select the now-matched song, even inside budget.
    await pinBudget(1);
    await runJob('p4-idem-2');
    const after = await prisma.song.findUnique({
      where: { id: song.id },
      select: { youtubeVideoId: true },
    });
    assert.equal(after?.youtubeVideoId, 'ph4idempotent1', 'the match must be left intact');
  });
});

// ===========================================================================
// C. Phase 4.1 — searchMatch unit behaviour against the stub
// ===========================================================================

describe('Phase 4.1 — youtubeService.searchMatch against the stub', () => {
  const saved = saveFlagState();
  after(() => restoreFlagState(saved));

  test('returns a fully populated match and caches it for 30 days', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    const title = `Stub Song ${Date.now()}`;
    installYouTubeStub(matchingStub('ph4unitvid001', title, 'Stub Artist', { iso: 'PT1H2M3S' }));
    const key = matchCacheKey(title, 'Stub Artist');
    registry.redisKeys.push(key);

    const match = await youtubeService.searchMatch(title, 'Stub Artist');

    assert.ok(match, 'a stubbed search + videos response must produce a match');
    assert.equal(match!.videoId, 'ph4unitvid001');
    assert.equal(match!.durationSeconds, 3723);
    assert.equal(match!.channelTitle, 'Stub Artist');
    assert.equal(match!.thumbnailUrl, 'https://i.ytimg.com/vi/ph4unitvid001/hq.jpg');

    const cached = await redis.get(key);
    assert.ok(cached, 'the match must be cached');
    const ttl = await redis.ttl(key);
    assert.ok(ttl > 29 * 24 * 3600 && ttl <= 30 * 24 * 3600, `expected ~30d TTL, got ${ttl}s`);
    assert.equal(JSON.parse(cached!).videoId, 'ph4unitvid001');
  });

  test('a cached match short-circuits the API (the second call issues no HTTP request)', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    const title = `Cache Probe ${Date.now()}`;
    const key = matchCacheKey(title, 'Stub Artist');
    registry.redisKeys.push(key);
    // channelTitle must name the artist: Phase B re-validates cache hits, so an
    // entry with an unrelated channel would (correctly) be discarded and refetched.
    await redis.set(
      key,
      JSON.stringify({ videoId: 'cachedvid0001', title, channelTitle: 'Stub Artist', thumbnailUrl: null, durationSeconds: 10 }),
      'EX',
      600,
    );

    installYouTubeStub(matchingStub('shouldnotbeused', title, 'Stub Artist', { iso: 'PT1M' }));
    const match = await youtubeService.searchMatch(title, 'Stub Artist');

    assert.equal(match!.videoId, 'cachedvid0001');
    assert.equal(youtubeCalls.length, 0, `no HTTP call expected, got ${youtubeCalls.join(', ')}`);
  });

  test('a search response with no items returns null and caches nothing', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub({ search: { items: [] }, videos: {} });
    const title = `Empty Probe ${Date.now()}`;
    const key = matchCacheKey(title, 'Stub Artist');
    registry.redisKeys.push(key);

    const match = await youtubeService.searchMatch(title, 'Stub Artist');

    assert.equal(match, null);
    assert.equal(await redis.get(key), null);
  });

  test('a snippet with no thumbnails still matches (thumbnailUrl = null)', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    const title = `NoThumb Probe ${Date.now()}`;
    installYouTubeStub({
      // A snippet with no `channelTitle` at all: the resolver falls back to the
      // artist it searched for, which is what makes the channel gate pass.
      search: {
        items: [
          {
            id: { videoId: 'nothumb00001' },
            snippet: { title: `${title} (Official Audio)` },
          },
        ],
      },
      videos: videosBody('PT1M', 'nothumb00001'),
    });
    registry.redisKeys.push(matchCacheKey(title, 'Stub Artist'));

    const match = await youtubeService.searchMatch(title, 'Stub Artist');

    assert.equal(match!.videoId, 'nothumb00001');
    assert.equal(match!.thumbnailUrl, null);
    assert.equal(match!.channelTitle, 'Stub Artist', 'a missing channel falls back to the artist name');
  });

  test('a thrown network error is swallowed and returns null instead of crashing the job', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub({ search: null, videos: null, networkError: true });
    const title = `Error Probe ${Date.now()}`;

    const match = await youtubeService.searchMatch(title, 'Stub Artist');

    assert.equal(match, null);
    assert.ok(youtubeCalls.length >= 1, 'the stub must actually have been hit');
  });

  test('the search request targets the music category and asks for a validation-sized window', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    const title = `Req Shape ${Date.now()}`;
    installYouTubeStub(matchingStub('reqshape00001', title, 'Stub Artist', { iso: 'PT1M' }));
    registry.redisKeys.push(matchCacheKey(title, 'Stub Artist'));

    await youtubeService.searchMatch(title, 'Stub Artist');

    const searchCall = youtubeCalls.find((u) => u.includes('/search'));
    assert.ok(searchCall, `expected a /search call, got ${youtubeCalls.join(' | ')}`);
    assert.match(searchCall!, /videoCategoryId=10/);
    // Phase B widened the window from 3 to 8 so validation has candidates to
    // choose from when the top hit is a remix. `maxResults` does not change the
    // per-call quota cost, so this stays free.
    assert.match(searchCall!, /maxResults=8/);
    assert.match(searchCall!, /part=snippet/);
    assert.match(searchCall!, /type=video/);
    assert.match(searchCall!, /key=REDACTED/, 'the key must be sent, but never logged in the clear');
  });

  test('matchSong writes the match for a specific song and returns it', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    const song = await createPhase3Song(registry, { youtubeVideoId: null });
    installYouTubeStub(
      matchingStub('ph4matchsong01', song.title, await artistNameOf(song.artistId), { iso: 'PT3M0S' }),
    );
    registry.redisKeys.push(matchCacheKey(song.title, await artistNameOf(song.artistId)));

    const match = await youtubeService.matchSong(song.id);

    assert.equal(match!.videoId, 'ph4matchsong01');
    const after = await prisma.song.findUnique({
      where: { id: song.id },
      select: { youtubeVideoId: true, youtubeMatchedAt: true },
    });
    assert.equal(after?.youtubeVideoId, 'ph4matchsong01');
    assert.ok(after?.youtubeMatchedAt instanceof Date);
  });

  test('matchSong returns null for an unknown song id and writes nothing', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub({
      search: { items: [] },
      videos: videosBody('PT1M'),
    });

    const match = await youtubeService.matchSong('p4-no-such-song-id');

    assert.equal(match, null);
    assert.equal(youtubeCalls.length, 0, 'no YouTube call may be made for a missing song');
  });
});

// ===========================================================================
// E. Phase C — channel-upload enumeration (the cheap, search-free path)
// ===========================================================================

describe('Phase C — youtubeService.listArtistUploads', () => {
  const saved = saveFlagState();
  after(() => restoreFlagState(saved));

  /**
   * `channels` always answers for EVERY handle spelling.
   *
   * Resolution now probes all spellings and dedupes by uploads playlist id, so a
   * stub that returned a channel for each one still yields a single walk. That
   * also means the stub cannot key off the handle the way the old single-handle
   * stub did.
   *
   * `nextPageToken` is one-shot. A stub that kept returning the same token would
   * make the pagination loop never terminate, since the repeated items dedupe to
   * zero new candidates — the run would spin until the heap died rather than fail.
   */
  const uploadsStub = (items: unknown[], nextPageToken?: string) => {
    let pagesServed = 0;
    return {
      search: {},
      channels: {
        items: [
          {
            snippet: { title: 'Stub Channel' },
            statistics: { subscriberCount: '1000', videoCount: String(items.length) },
            contentDetails: { relatedPlaylists: { uploads: 'UU_phasec_uploads' } },
          },
        ],
      },
      playlistItems: {
        items,
        ...(nextPageToken && pagesServed++ === 0 ? { nextPageToken } : {}),
      },
      videos: {},
    };
  };

  test('resolves the uploads playlist and returns candidates without a search', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub(
      uploadsStub([
        {
          snippet: {
            title: 'Essence (Official Video)',
            channelTitle: 'WizkidVEVO',
            resourceId: { videoId: 'phasecupl001' },
          },
        },
      ]),
    );

    const candidates = await youtubeService.listArtistUploads('Wizkid', 50);

    assert.equal(candidates?.length, 1);
    assert.equal(candidates![0].videoId, 'phasecupl001');
    assert.equal(candidates![0].title, 'Essence (Official Video)');
    assert.equal(candidates![0].channelTitle, 'WizkidVEVO');

    // The whole point of the path: no search.list unit was spent.
    assert.equal(
      youtubeCalls.some((u) => u.includes('/search')),
      false,
      `enumeration must not call search, got ${youtubeCalls.join(' | ')}`,
    );
    assert.ok(
      youtubeCalls.some((u) => u.includes('/channels') && u.includes('forHandle=')),
      `expected a forHandle lookup, got ${youtubeCalls.join(' | ')}`,
    );
    assert.ok(
      youtubeCalls.some((u) => u.includes('/playlistItems') && u.includes('UU_phasec_uploads')),
      `expected a playlistItems walk, got ${youtubeCalls.join(' | ')}`,
    );
  });

  // playlistItems.list carries title but not `status.embeddable`, so the
  // enumeration path can never satisfy that gate on its own. It has to be
  // "unknown", not "false" — a false would reject every candidate and the whole
  // cheap path would silently match nothing.
  test('leaves embeddable null rather than false, so the gate is not silently failed', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub(
      uploadsStub([
        { snippet: { title: 'Any Title', channelTitle: 'X', resourceId: { videoId: 'phasecembed01' } } },
      ]),
    );

    const candidates = await youtubeService.listArtistUploads('X', 10);

    assert.equal(candidates![0].embeddable, null);
    assert.equal(candidates![0].durationSeconds, null);
  });

  test('follows nextPageToken until the walk completes', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub(
      uploadsStub(
        [{ snippet: { title: 'One', channelTitle: 'X', resourceId: { videoId: 'page1vid001' } } }],
        'NEXT_PAGE_TOKEN',
      ),
    );

    await youtubeService.listArtistUploads('X', 100);

    const pageCalls = youtubeCalls.filter((u) => u.includes('/playlistItems'));
    assert.ok(pageCalls.length >= 2, `expected a second page, got ${pageCalls.join(' | ')}`);
    assert.ok(
      pageCalls.some((u) => u.includes('pageToken=NEXT_PAGE_TOKEN')),
      `expected the token to be forwarded, got ${pageCalls.join(' | ')}`,
    );
  });

  // Regression: a server that keeps handing back the same nextPageToken made the
  // walk loop forever. Every repeated page dedupes to zero new candidates, so the
  // `fetched < maxItems` guard never trips and the process spins until the heap
  // dies. This asserts the walk gives up instead.
  test('a repeated nextPageToken terminates the walk instead of looping', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub({
      search: {},
      channels: {
        items: [
          {
            snippet: { title: 'Stuck Channel' },
            statistics: { subscriberCount: '10', videoCount: '1' },
            contentDetails: { relatedPlaylists: { uploads: 'UU_phasec_stuck' } },
          },
        ],
      },
      // Always the same token, always the same item.
      playlistItems: {
        items: [{ snippet: { title: 'Loop', channelTitle: 'X', resourceId: { videoId: 'loopvid00001' } } }],
        nextPageToken: 'SAME_TOKEN_FOREVER',
      },
      videos: {},
    });

    const candidates = await youtubeService.listArtistUploads('X', 200);

    assert.equal(candidates?.length, 1, 'the single distinct video is kept');
    const pageCalls = youtubeCalls.filter((u) => u.includes('/playlistItems'));
    assert.ok(pageCalls.length <= 3, `walk must stop early, issued ${pageCalls.length} page calls`);
  });

  test('respects maxItems', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub(
      uploadsStub(
        Array.from({ length: 50 }, (_, i) => ({
          snippet: { title: `T${i}`, channelTitle: 'X', resourceId: { videoId: `cap${String(i).padStart(6, '0')}` } },
        })),
      ),
    );

    const candidates = await youtubeService.listArtistUploads('X', 5);

    assert.equal(candidates!.length, 5);
  });

  // Regression: a name resolves to several real channels, and stopping at the
// first resolved the wrong one. "@Asake" is a Fortnite streamer with 130 subs;
// "@AsakeMusic" is ASAKE with 2.18M and 153 uploads. Both resolve, so the walk
// must union them rather than trust the first hit.
  test('unions every candidate handle, not just the first that resolves', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub({
      search: {},
      channels: {
        items: [
          {
            id: 'UC_wrong_channel',
            snippet: { title: 'Asake (gamer)' },
            statistics: { subscriberCount: '130', videoCount: '5' },
            contentDetails: { relatedPlaylists: { uploads: 'UU_wrong' } },
          },
          {
            id: 'UC_right_channel',
            snippet: { title: 'ASAKE' },
            statistics: { subscriberCount: '2180000', videoCount: '153' },
            contentDetails: { relatedPlaylists: { uploads: 'UU_right' } },
          },
        ],
      },
      playlistItems: {
        items: [
          { snippet: { title: 'Live Fortnite', channelTitle: 'Asake', resourceId: { videoId: 'wrongvid001' } } },
          { snippet: { title: '2:30', channelTitle: 'ASAKE', resourceId: { videoId: 'rightvid0001' } } },
        ],
      },
      videos: {},
    });

    const candidates = await youtubeService.listArtistUploads('Asake', 50);

    const ids = (candidates ?? []).map((c) => c.videoId).sort();
    assert.deepEqual(ids, ['rightvid0001', 'wrongvid001'], 'both channels must be walked');
  });

  test('dedupes a video that appears on more than one channel', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub({
      search: {},
      channels: {
        items: [
          {
            id: 'UC_a',
            snippet: { title: 'A' },
            statistics: { subscriberCount: '2000', videoCount: '2' },
            contentDetails: { relatedPlaylists: { uploads: 'UU_a' } },
          },
          {
            id: 'UC_b',
            snippet: { title: 'B' },
            statistics: { subscriberCount: '1000', videoCount: '2' },
            contentDetails: { relatedPlaylists: { uploads: 'UU_b' } },
          },
        ],
      },
      // Same video id from both playlists, as a VEVO mirror would produce.
      playlistItems: {
        items: [{ snippet: { title: 'Shared', channelTitle: 'A', resourceId: { videoId: 'sharedvid01' } } }],
      },
      videos: {},
    });

    const candidates = await youtubeService.listArtistUploads('Shared', 50);

    assert.equal(candidates?.length, 1, 'a mirrored upload must not be counted twice');
  });

  test('returns null when no handle spelling resolves to a channel', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub({ search: {}, channels: { items: [] }, videos: {} });

    const candidates = await youtubeService.listArtistUploads('Nobody At All', 50);

    assert.equal(candidates, null);
  });

  test('an API error on channels.list degrades to null instead of throwing', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub({ search: {}, channels: {}, channelsStatus: 403, videos: {} });

    const candidates = await youtubeService.listArtistUploads('Some Artist', 50);

    assert.equal(candidates, null, 'the caller falls back to search, so this must not throw');
  });

  test('fetchCandidateDetails batches at 50 ids and reports embeddability', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub({
      search: { items: [] },
      videos: {
        items: [
          { id: 'batchvid0001', contentDetails: { duration: 'PT2M30S' }, status: { embeddable: true } },
          { id: 'batchvid0002', contentDetails: { duration: 'PT3M' }, status: { embeddable: false } },
        ],
      },
    });

    const ids = Array.from({ length: 120 }, (_, i) => `batchvid${String(i).padStart(4, '0')}`);
    const details = await youtubeService.fetchCandidateDetails(ids);

    assert.equal(details.size, 120, 'every requested id must have an entry');
    // Unknown for ids the stub did not describe: absent is "not checked".
    assert.equal(details.get('batchvid0001')!.durationSeconds, 150);
    assert.equal(details.get('batchvid0001')!.embeddable, true);
    assert.equal(details.get('batchvid0002')!.embeddable, false);
    assert.equal(details.get('batchvid0100')!.embeddable, null);

    const videoCalls = youtubeCalls.filter((u) => u.includes('/videos'));
    assert.equal(videoCalls.length, 3, `120 ids at 50 per call is 3 units, got ${videoCalls.length}`);
  });

  test('fetchCandidateDetails never throws when the API fails', async () => {
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub({ search: { items: [] }, videos: {}, videosStatus: 500 });

    const details = await youtubeService.fetchCandidateDetails(['failingvid1']);

    assert.equal(details.get('failingvid1')!.durationSeconds, null);
    assert.equal(details.get('failingvid1')!.embeddable, null);
  });
});

// ===========================================================================
// D. Phase 4.1 — Re-queue / self-scheduling
// ===========================================================================

describe('Phase 4.1 — enrichment re-queue', () => {
  const saved = saveFlagState();
  let counterBefore: CounterSnapshot | null = null;

  beforeEach(async () => {
    // See the success-path describe: the job's `views desc` tie-break across
    // leftover fixtures makes selection nondeterministic without this purge.
    await cleanupPhase3Fixtures(registry);
    counterBefore = await snapshotCounter();
    assert.ok(counterBefore, 'snapshotCounter must return a snapshot');
    env.FLAG_PLAYBACK_YOUTUBE = true;
    env.YOUTUBE_API_KEY = 'phase4-stub-key';
    installYouTubeStub({ search: { items: [] }, videos: {} });
  });

  afterEach(async () => {
    if (counterBefore) await restoreCounter(counterBefore);
  });

  after(() => restoreFlagState(saved));

  test('a run that leaves songs unmatched self-schedules a 24h follow-up', async () => {
    // A fixture song that the stub cannot match, so it stays eligible.
    await createPhase3Song(registry, { youtubeVideoId: null, views: SAFE_VIEWS });
    await pinBudget(1);
    const result = await runJob('p4-requeue');

    assert.equal(result.reQueued, true, 'unmatched songs must schedule a follow-up');

    const tomorrow = dayKey(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const id = `library-enrichment-followup-${tomorrow}`;
    registry.jobIds.push({ queue: 'sync', id });

    const job = await syncQueue.getJob(id);
    assert.ok(job, `expected a delayed follow-up job with id ${id}`);
    assert.equal(job!.name, LIBRARY_ENRICHMENT_JOB_NAME);
    assert.equal(job!.data.type, LIBRARY_ENRICHMENT_JOB_NAME);
  });

  test('the follow-up is deduplicated by day-scoped job id across repeated runs', async () => {
    await createPhase3Song(registry, { youtubeVideoId: null, views: SAFE_VIEWS });
    await pinBudget(1);
    await runJob('p4-requeue-a');
    const before = (await syncQueue.getJobs(['waiting', 'delayed', 'active'])).length;

    await pinBudget(1);
    const second = await runJob('p4-requeue-b');
    const after = (await syncQueue.getJobs(['waiting', 'delayed', 'active'])).length;

    assert.equal(second.reQueued, true, 'the second run still reports it scheduled');
    assert.equal(after, before, 'a second run on the same day must not stack another follow-up');
  });

  test('a capped no-op run neither attempts a song nor re-schedules a follow-up', async () => {
    await redis.set(COUNTER_KEY(), String(DAILY_CAP));
    const result = await runJob('p4-requeue-capped');
    assert.equal(result.dailyCapReached, true);
    assert.equal(result.attempted, 0);
    assert.equal(result.reQueued, false, 'a capped no-op run must not schedule a follow-up');
  });

  test('enqueue is refused while the flag is off and adds no job', async () => {
    env.FLAG_PLAYBACK_YOUTUBE = false;
    const before = (await syncQueue.getJobs(['waiting', 'delayed'])).length;

    const result = await enqueueLibraryEnrichment({ reason: 'p4-flag-off' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'flag_disabled');
    assert.equal((await syncQueue.getJobs(['waiting', 'delayed'])).length, before);
  });

  test('enqueue is refused when the flag is on but no API key is configured', async () => {
    env.FLAG_PLAYBACK_YOUTUBE = true;
    env.YOUTUBE_API_KEY = undefined;
    const before = (await syncQueue.getJobs(['waiting', 'delayed'])).length;

    const result = await enqueueLibraryEnrichment({ reason: 'p4-no-key' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'not_configured');
    assert.equal((await syncQueue.getJobs(['waiting', 'delayed'])).length, before);
  });

  test('FIXED (Stage 6.1): unmatchable songs retire instead of retrying forever', async () => {
    // This test previously asserted the BUG:
    //   assert.ok(!/youtubeMatchAttempts/.test(jobRaw), 'expected: no per-song
    //   attempt tracking exists in the job')
    // The original comment read: "The job has no attempt counter, backoff list,
    // or dead-letter. A song that YouTube can never resolve is re-queued by
    // every run, burning quota every single day. Fix: add youtubeMatchAttempts
    // to Song, skip past a threshold, and stop re-queueing once the remaining
    // set is exhausted."
    //
    // Stage 6.1 implemented exactly that prescribed fix, so the assertion is
    // inverted. The dead-letter is now part of the contract and is re-asserted
    // positively, so a future regression that removes the counter fails here.
    const jobRaw = await readBackendFile('src', 'jobs', 'libraryEnrichmentJob.ts');
    assert.match(jobRaw, /youtubeMatchAttempts/);
    assert.match(jobRaw, /MAX_MATCH_ATTEMPTS/);

    const schema = await readBackendFile('prisma', 'schema.prisma');
    assert.match(
      schema,
      /youtubeMatchAttempts\s+Int\s+@default\(0\)/,
      'the Song model should carry a match-attempt column defaulting to 0',
    );

    // A song that reached the cap must be excluded from the candidate set, and
    // the re-queue must stop once only dead-lettered songs remain.
    const { MAX_MATCH_ATTEMPTS, enrichmentCandidateWhere, deadLetteredSongWhere } =
      await import('../src/jobs/libraryEnrichmentJob.js');
    assert.equal(enrichmentCandidateWhere().youtubeMatchAttempts.lt, MAX_MATCH_ATTEMPTS);
    assert.equal(deadLetteredSongWhere().youtubeMatchAttempts.gte, MAX_MATCH_ATTEMPTS);
  });
});

// ===========================================================================
// E. Phase 4.1 — Queue + cron registration (static wiring assertions)
// ===========================================================================

describe('Phase 4.1 — queue and cron wiring', () => {
  test('the library-enrichment job type is dispatched by the sync worker', async () => {
    const raw = await readBackendFile('src', 'jobs', 'syncWorker.ts');
    assert.match(raw, /case 'library-enrichment':/);
    assert.match(raw, /processLibraryEnrichmentJob\(job\)/);
    assert.match(raw, /\| 'library-enrichment'/);
  });

  test('syncCron.ts schedules the Tue/Thu 3am enrichment cron (started by index.ts)', async () => {
    const raw = await readBackendFile('src', 'jobs', 'syncCron.ts');
    assert.match(raw, /LIBRARY_ENRICHMENT_JOB_NAME/);
    assert.match(raw, /0 3 \* \* 2,4/, 'expected the Tue/Thu 3am cron pattern from the plan');
    assert.match(raw, /library-enrichment-tue-thu/);

    const indexRaw = await readBackendFile('src', 'index.ts');
    assert.match(indexRaw, /scheduleSyncJobs\(\)/, 'index.ts must start the sync crons');
  });

  test('selfHeal re-registers the enrichment cron if Redis loses it', async () => {
    // Repeatable-job self-heal (2.6) lives in selfHeal.ts. The sync crons are
    // re-registered as one idempotent group, so the enrichment cron is covered.
    const raw = await readBackendFile('src', 'jobs', 'selfHeal.ts');
    assert.match(raw, /scheduleSyncJobs/);
    assert.match(raw, /library-enrichment-tue-thu/);

    const indexRaw = await readBackendFile('src', 'index.ts');
    assert.match(indexRaw, /startSelfHeal\(\)/, 'index.ts must start the self-heal loop');
  });

  test('Phase 4: the Spotify catalog pipeline no longer enqueues enrichment triggers', async () => {
    // The Spotify popular-tracks sync (and its post-sync enrichment hook) was
    // removed with the catalog pipeline. Library enrichment is now triggered
    // only by its own Tue/Thu cron.
    const cron = await readBackendFile('src', 'jobs', 'syncCron.ts');
    assert.ok(!/enqueueLibraryEnrichment/.test(cron),
      'no Spotify-driven enrichment enqueue may remain in the cron module');
    const queue = await readBackendFile('src', 'lib', 'queue.ts');
    assert.ok(!/syncPopularTracksQueue/.test(queue),
      'the syncPopularTracksQueue must be gone from queue.ts');
  });

  test('the playback and admin-YouTube routers are mounted in app.ts', async () => {
    const raw = await readBackendFile('src', 'app.ts');
    assert.match(raw, /app\.use\('\/api\/admin', adminYoutubeRouter\)/);
    assert.match(raw, /app\.use\('\/api', playbackRouter\)/);
  });

  test('the admin YouTube router requires ADMIN on every route', async () => {
    const raw = await readBackendFile('src', 'routes', 'admin', 'youtube.ts');
    assert.match(raw, /adminYoutubeRouter\.use\(authenticate, requireRole\('ADMIN'\)\)/);
  });

  test('all four admin YouTube endpoints from the plan are present', async () => {
    const raw = await readBackendFile('src', 'routes', 'admin', 'youtube.ts');
    assert.match(raw, /'\/youtube\/match-all'/);
    assert.match(raw, /'\/youtube\/status'/);
    assert.match(raw, /'\/youtube\/match'/);
    assert.match(raw, /'\/youtube\/match\/:songId'/);
  });

  test('FIXED (2.20): the enrichment job reports BullMQ progress', async () => {
    // A run can span minutes; without progress telemetry the job sat at 0% and
    // looked wedged in the BullMQ dashboard.
    const jobRaw = await readBackendFile('src', 'jobs', 'libraryEnrichmentJob.ts');
    assert.match(
      jobRaw,
      /job\.updateProgress\(/,
      'processLibraryEnrichmentJob must call job.updateProgress()',
    );
  });
});

// ===========================================================================
// F. Phase 4.3 — Spotify -> YouTube migration checklist, measured against the
//    live catalog. These are REPORT + GATE tests: they print real coverage and
//    fail loudly while the checklist is unproven.
// ===========================================================================

describe('Phase 4.3 — migration checklist coverage (live catalog)', () => {
  // `live` deliberately EXCLUDES the P3TEST fixtures this file created, so the
  // coverage numbers reported below are the real catalog, not this test run.
  const live = { softDeleted: false, NOT: { title: { startsWith: 'P3TEST' } } };

  // These are gates on production DATA, not on code. A disposable test database
  // is created empty (fixtures are sentinel-tagged and excluded above), so with
  // no real catalog there is nothing to measure and the coverage assertions
  // below would fail for an environmental reason, not a real regression. Skip
  // with an explicit reason instead of pretending the checklist is unmet.
  const skipIfNoLiveCatalog = (t: TestContext, total: number): boolean => {
    if (total > 0) return false;
    t.skip('live catalog is empty in this environment — coverage gate is not measurable here');
    return true;
  };

  test('the playback source tiers partition the live catalog exactly', async (t) => {
    const [total, ownAudio, youtube, none] = await Promise.all([
      prisma.song.count({ where: live }),
      prisma.song.count({ where: { ...live, audioUrl: { not: null } } }),
      prisma.song.count({ where: { ...live, youtubeVideoId: { not: null } } }),
      prisma.song.count({
        where: { ...live, audioUrl: null, youtubeVideoId: null },
      }),
    ]);

    if (skipIfNoLiveCatalog(t, total)) return;
    assert.equal(
      ownAudio + youtube + none,
      total,
      'the source tiers must partition the live catalog exactly',
    );
  });

  test('FAILS: only a small share of the catalog is playable on any tier', async (t) => {
    const [total, ownAudio, youtube] = await Promise.all([
      prisma.song.count({ where: live }),
      prisma.song.count({ where: { ...live, audioUrl: { not: null } } }),
      prisma.song.count({ where: { ...live, youtubeVideoId: { not: null } } }),
    ]);
    if (skipIfNoLiveCatalog(t, total)) return;

    const playable = ownAudio + youtube;
    const pct = total === 0 ? 0 : Math.round((playable / total) * 1000) / 10;
    console.log(
      `[phase4.3] catalog=${total} ownAudio=${ownAudio} youtube=${youtube} ` +
        `playable=${playable} (${pct}%)`,
    );

    assert.ok(
      pct >= 90,
      `FAILS: only ${playable}/${total} songs (${pct}%) are playable on any tier. Checklist items ` +
        '1-2 ("all songs with youtubeVideoId play via YouTube", "songs with audioUrl play own audio") ' +
        'cannot pass while library enrichment has never matched anything. ' +
        'Songs with neither resolve to NONE since the Spotify preview tier was removed.',
    );
  });

  test('FAILS: the library enrichment job has never matched a single catalog song', async (t) => {
    const matched = await prisma.song.count({ where: { ...live, youtubeVideoId: { not: null } } });
    const total = await prisma.song.count({ where: live });
    if (skipIfNoLiveCatalog(t, total)) return;
    console.log(`[phase4.3] youtubeVideoId coverage = ${matched}/${total}`);
    assert.ok(
      matched > 0,
      'FAILS: 0 songs carry a youtubeVideoId. FLAG_PLAYBACK_YOUTUBE defaults to false, so the ' +
        'cron and the post-sync hook both no-op, and YOUTUBE_API_KEY is absent from .env. ' +
        'Checklist item 1 ("all songs with youtubeVideoId play via YouTube") is unmet because ' +
        'there is no enrichment data at all.',
    );
  });

  test('no song exposes a Spotify Premium requirement in the player UI', async () => {
    const files = ['components/PlaybackManager.tsx', 'components/YouTubePlayer.tsx'];
    for (const rel of files) {
      const raw = await readFile(path.join(FRONTEND_ROOT, ...rel.split('/')), 'utf8');
      assert.ok(
        !/Premium required/i.test(raw),
        `${rel} must not gate playback behind a Spotify Premium requirement`,
      );
    }
  });

  test('DAILY_LISTEN reward config exists and is positive (the reward fires on complete)', async () => {
    const { getRewardConfig } = await import('../src/config/rewards.js');
    const config = await getRewardConfig();
    assert.ok(
      typeof config.DAILY_LISTEN_AMOUNT === 'number' && config.DAILY_LISTEN_AMOUNT > 0,
      `DAILY_LISTEN_AMOUNT must be a positive number, got ${String(config.DAILY_LISTEN_AMOUNT)}`,
    );
  });

  test('the view-count flush worker exists so Redis view counters reach the DB', async () => {
    const raw = await readBackendFile('src', 'jobs', 'viewCountFlushJob.ts');
    assert.match(raw, /song:views:/);
    assert.match(raw, /views:\s*\{\s*increment: count/);
    // The worker + its repeat schedule are wired in jobs/workers.ts (the
    // bootstrap that index.ts imports), not in index.ts itself.
    const workers = await readBackendFile('src', 'jobs', 'workers.ts');
    assert.match(workers, /processViewCountFlushJob, scheduleViewCountFlush/);
    assert.match(workers, /await scheduleViewCountFlush\(\)/);
    assert.match(workers, /viewCountFlushQueue/);
  });

  test('the flush worker drains the counters the report route writes', async () => {
    // Cross-file contract: routes/playback.ts increments `song:views:<id>`;
    // viewCountFlushJob must parse the exact same prefix.
    const route = await readBackendFile('src', 'routes', 'playback.ts');
    const job = await readBackendFile('src', 'jobs', 'viewCountFlushJob.ts');
    const routePrefix = route.match(/song:views:\$\{songId\}/);
    assert.ok(routePrefix, 'the report route must write the song:views:<id> key');
    assert.match(job, /VIEW_KEY_PREFIX = 'song:views:'/);
  });
});

// ===========================================================================
// G. Phase 4.3 — playback report side effects across every tier
// ===========================================================================

describe('Phase 4.3 — playback reporting across tiers', () => {
  let harness: Harness;
  let listenerToken: string;
  const saved = saveFlagState();

  before(async () => {
    harness = await startPhase3Harness();
    const listener = await createPhase3User(registry, 'USER');
    listenerToken = jwt.sign(
      { userId: listener.id, email: listener.email, role: 'USER' },
      env.JWT_SECRET,
      { expiresIn: '5m' },
    );
  });

  after(async () => {
    await harness.close();
    restoreFlagState(saved);
  });

  test('every documented source value is accepted by the report endpoint', async () => {
    // 2.16: on 'play' the reported source must match what the server actually
    // served, so each source value needs a song that genuinely resolves to it.
    // The YouTube tier is flag-gated, so the flag is pinned ON for this test.
    const savedFlag = saveFlagState();
    try {
      env.FLAG_PLAYBACK_YOUTUBE = true;
      for (const source of ['AUDIO_URL', 'YOUTUBE', 'NONE'] as const) {
        const song = await createPhase3Song(registry, {
          audioUrl: source === 'AUDIO_URL' ? 'https://cdn.example/a.mp3' : null,
          youtubeVideoId: source === 'YOUTUBE' ? 'ph4reportvid1' : null,
        });
        registry.redisKeys.push(viewCounterKey(song.id));

        const res = await harness.request('POST', '/api/playback/report', {
          body: { songId: song.id, source, eventType: 'play' },
          token: listenerToken,
        });
        assert.equal(res.status, 200, `source ${source} must be accepted`);
      }
    } finally {
      restoreFlagState(savedFlag);
    }
  });

  test('a play reported against the wrong tier is rejected (2.16)', async (t) => {
    // A song with only a (now inert) Spotify preview resolves to NONE, so
    // claiming AUDIO_URL is a misattribution and must not be recorded.
    const song = await createPhase3Song(registry, {
      spotifyPreviewUrl: 'https://p.scdn.co/mismatch.mp3',
    });
    registry.redisKeys.push(viewCounterKey(song.id));

    const res = await harness.request('POST', '/api/playback/report', {
      body: { songId: song.id, source: 'AUDIO_URL', eventType: 'play' },
      token: listenerToken,
    });
    assert.equal(res.status, 409, 'a mismatched source must be rejected');
    assert.equal(res.body.code, 'SOURCE_MISMATCH');
  });

  test('a complete event enqueues a DAILY_LISTEN reward for the YOUTUBE tier too', async () => {
    const song = await createPhase3Song(registry, { youtubeVideoId: 'ph4rewardvid1' });
    const userId = registry.userIds[0];
    const key = `daily-listen:${userId}:${dayKey()}`;

    const matchingJobs = async () => {
      const jobs = await rewardQueue.getJobs(['waiting', 'delayed', 'active']);
      return jobs.filter((j) => (j.data as Record<string, unknown>)?.idempotencyKey === key);
    };

    const before = (await matchingJobs()).length;
    const res = await harness.request('POST', '/api/playback/report', {
      body: { songId: song.id, source: 'YOUTUBE', eventType: 'complete' },
      token: listenerToken,
    });
    assert.equal(res.status, 200);

    let after = before;
    for (let i = 0; i < 25 && after === before; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      after = (await matchingJobs()).length;
    }
    assert.equal(after, before + 1, 'the YouTube tier must grant the daily-listen reward too');

    for (const job of await matchingJobs()) {
      if (!registry.jobIds.some((e) => e.id === String(job.id))) {
        registry.jobIds.push({ queue: 'reward', id: String(job.id) });
      }
    }
  });

  test('the daily-listen idempotency key is per-user-per-UTC-day and reuses across tiers', async () => {
    const userId = registry.userIds[0];
    const key = `daily-listen:${userId}:${dayKey()}`;
    assert.match(key, /^daily-listen:[^:]+:\d{4}-\d{2}-\d{2}$/);

    // A second event reporting the same day must reuse the same key, which is
    // what makes the ledger's unique constraint collapse the duplicates.
    const song = await createPhase3Song(registry, { youtubeVideoId: 'ph4dupvid1' });
    await harness.request('POST', '/api/playback/report', {
      body: { songId: song.id, source: 'YOUTUBE', eventType: 'complete' },
      token: listenerToken,
    });

    const jobs = await rewardQueue.getJobs(['waiting', 'delayed', 'active']);
    const payloads = jobs
      .map((j) => j.data as Record<string, unknown>)
      .filter((d) => d.idempotencyKey === key);
    for (const p of payloads) {
      assert.equal(p.event, 'DAILY_LISTEN', 'every duplicate must still be a DAILY_LISTEN event');
    }
    for (const job of jobs) {
      if ((job.data as Record<string, unknown>)?.idempotencyKey === key) {
        if (!registry.jobIds.some((e) => e.id === String(job.id))) {
          registry.jobIds.push({ queue: 'reward', id: String(job.id) });
        }
      }
    }
  });

  test('BUG (documented): a report can inflate a view count without any limit', async () => {
    // Tier 1 audio so the accepted report does not depend on the YouTube flag.
    const song = await createPhase3Song(registry, { audioUrl: 'https://cdn.example/a.mp3' });
    const key = viewCounterKey(song.id);
    registry.redisKeys.push(key);
    await redis.del(key);

    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const res = await harness.request('POST', '/api/playback/report', {
        body: { songId: song.id, source: 'AUDIO_URL', eventType: 'play' },
        token: listenerToken,
      });
      statuses.push(res.status);
    }
    assert.ok(
      statuses.every((s) => s === 200),
      'currently unlimited — /playback/report has no rate limit, unlike the admin YouTube routes',
    );
    assert.equal(await redis.get(key), '10', 'ten identical reports inflate the counter to ten');
  });

  test('BUG (documented): one real play is counted twice in the view counter', async () => {
    // Two independent write paths both increment `song:views:<id>`:
    //   1. GET /api/songs/:id -> getSongById() defaults
    //      `incrementViewCount` to true (services/songService.ts). The frontend
    //      calls this on every song page render (components/LyricContent.tsx
    //      -> lib/apiClient.getSongById), i.e. BEFORE the user presses play.
    //   2. POST /api/playback/report { eventType: 'play' } -> increments the same
    //      key again for the same listening session.
    // So a single play is worth 2+ views, and merely opening a song page is
    // worth 1+ views. Phase 4.3's "view counts increment correctly" is unmet.
    // Fix: make /api/playback/report the single source of truth — drop the
    // SongPlay + view write from routes/songs.ts, and/or have the player fetch
    // the song with `incrementViewCount: false`.
    const { getSongById } = await import('../src/services/songService.js');

    // Preview-only song: audioUrl is null (so isSongActive passes), yet it
    // resolves to NONE — a valid report source that needs no YouTube flag.
    const song = await createPhase3Song(registry, { spotifyPreviewUrl: 'https://p.scdn.co/dbl.mp3' });
    const key = viewCounterKey(song.id);
    registry.redisKeys.push(key);
    await redis.del(key);

    // Step 1: the song detail fetch the player performs before playing.
    // getSongById() defaults `incrementViewCount` to true, and the wrapping
    // GET /api/songs/:id handler additionally fires an anonymous SongPlay.
    await getSongById(song.id);
    const afterDetail = await redis.get(key);

    // Step 2: the Phase 4 playback report for the same play.
    const res = await harness.request('POST', '/api/playback/report', {
      body: { songId: song.id, source: 'NONE', eventType: 'play' },
      token: listenerToken,
    });
    assert.equal(res.status, 200);

    const afterBoth = await redis.get(key);
    const playsFromReport = await prisma.songPlay.count({ where: { songId: song.id } });

    assert.equal(afterDetail, '1', 'the detail fetch already counted a view');
    assert.equal(
      afterBoth,
      '2',
      'currently: one real play increments the same `song:views:<id>` counter twice',
    );
    assert.equal(
      playsFromReport,
      1,
      'the authenticated report route is the only path that attributes a play to a user',
    );
  });

  test('BUG (documented): the song detail route records anonymous SongPlay rows', async () => {
    // routes/songs.ts writes `userId: req.user?.id ?? null` on an
    // unauthenticated GET, so the SongPlay table accumulates userId:null rows
    // that cannot be attributed, deduped, or rewarded. This is the row shape
    // seen in production (`userId: null`, real song ids).
    const raw = await readBackendFile('src', 'routes', 'songs.ts');
    assert.match(raw, /req as any\)\.user\?\.id \?\? null/, 'expected: an anonymous fallback userId');
    assert.match(raw, /prisma\.songPlay\.create\(\{/, 'expected: the detail route writes SongPlay');

    const anonymous = await prisma.songPlay.count({ where: { userId: null } });
    console.log(`[phase4.3] SongPlay rows with userId = null: ${anonymous}`);
    assert.ok(
      anonymous === 0,
      `currently ${anonymous} unattributable SongPlay rows exist. The detail route must stop ` +
        'recording plays, or accept an authenticated user and skip anonymous traffic.',
    );
  });
});
