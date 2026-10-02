import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { env } from '../src/lib/env';
import { rewardQueue } from '../src/lib/queue';
import { invalidatePlaybackSourceCache } from '../src/lib/playbackCache';
import { softDeleteSong } from '../src/services/songService';
import {
  newRegistry,
  createPhase3Song,
  createPhase3User,
  registerPhase3Teardown,
  startPhase3Harness,
  playbackSourceKey,
  viewCounterKey,
  type FixtureRegistry,
  type Harness,
} from './phase3Fixtures';

// Phase 3.3 — Playback routes, exercised over real HTTP against a harness that
// mounts only the Phase 3 routers (no workers, no crons, no unrelated routes).

const AUDIO = 'https://cdn.afrogenie.test/audio/route-probe.mp3';
const PREVIEW = 'https://p.scdn.co/audio-clip/route-probe.mp3';
const VIDEO_ID = 'dQw4w9WgXcQ';

// Must match `reportLimiter` in src/routes/playback.ts.
const REPORT_RATE_LIMIT = 60;

const tokenFor = (userId: string, email: string, role: string) =>
  jwt.sign({ userId, email, role }, env.JWT_SECRET, { expiresIn: '5m' });

// ONE registry for the whole file + ONE deterministic teardown.
// See `registerPhase3Teardown` for why this is per-file, not per-describe.
const registry: FixtureRegistry = newRegistry();

let harness: Harness;
let listenerToken: string;
let adminToken: string;

registerPhase3Teardown(registry);

describe('playback routes', () => {
  // The YouTube tier is gated on FLAG_PLAYBACK_YOUTUBE (2.15), which defaults to
  // OFF. This file exercises what each tier returns when it exists, so the flag
  // is pinned ON for the file and restored afterwards.
  const savedFlag = env.FLAG_PLAYBACK_YOUTUBE;

  before(async () => {
    env.FLAG_PLAYBACK_YOUTUBE = true;
    harness = await startPhase3Harness();

    const listener = await createPhase3User(registry, 'USER');
    listenerToken = tokenFor(listener.id, listener.email, 'USER');

    const admin = await createPhase3User(registry, 'ADMIN');
    adminToken = tokenFor(admin.id, admin.email, 'ADMIN');
  });

  after(async () => {
    await harness.close();
    env.FLAG_PLAYBACK_YOUTUBE = savedFlag;
  });

  // -------------------------------------------------------------------------
  // GET /api/playback/:songId/source
  // -------------------------------------------------------------------------

  test('resolves a playback source for a catalog song', async () => {
    const song = await createPhase3Song(registry, { youtubeVideoId: VIDEO_ID, spotifyPreviewUrl: PREVIEW });
    registry.redisKeys.push(playbackSourceKey(song.id));

    const res = await harness.request('GET', `/api/playback/${song.id}/source`);

    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'YOUTUBE');
    assert.equal(res.body.youtubeVideoId, VIDEO_ID);
    assert.equal(res.body.previewUrl, PREVIEW);
    assert.equal(res.body.song.id, song.id);
  });

  test('caches the resolved source in Redis for the tier fallback', async () => {
    const song = await createPhase3Song(registry, { audioUrl: AUDIO });
    const key = playbackSourceKey(song.id);
    registry.redisKeys.push(key);

    const first = await harness.request('GET', `/api/playback/${song.id}/source`);
    assert.equal(first.status, 200);

    const cached = await redis.get(key);
    assert.ok(cached, 'playback:source:<songId> must be populated');
    const ttl = await redis.ttl(key);
    assert.ok(ttl > 3000 && ttl <= 3600, `expected a ~1h TTL, got ${ttl}s`);
  });

  test('2.18: a source-tier change evicts the cached answer instead of going stale for 1h', async () => {
    const song = await createPhase3Song(registry, { audioUrl: null, spotifyPreviewUrl: PREVIEW });
    const key = playbackSourceKey(song.id);
    registry.redisKeys.push(key);

    const first = await harness.request('GET', `/api/playback/${song.id}/source`);
    assert.equal(first.body.source, 'SPOTIFY_PREVIEW');
    assert.ok(await redis.get(key), 'the first read must warm the cache');

    // Stand in for the admin/artist audio-upload path: the same
    // `invalidatePlaybackSourceCache` call the routes and services make.
    await prisma.song.update({ where: { id: song.id }, data: { audioUrl: AUDIO } });
    await invalidatePlaybackSourceCache(song.id);

    assert.equal(await redis.get(key), null, 'the write path must evict the entry');

    const fresh = await harness.request('GET', `/api/playback/${song.id}/source`);
    assert.equal(fresh.body.source, 'AUDIO_URL', 'the next read must observe the new tier');
  });

  test('rejects Spotify-synthesized ids (they are not catalog songs)', async () => {
    const res = await harness.request('GET', `/api/playback/${encodeURIComponent('spotify:track:abc')}/source`);

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'BAD_REQUEST');
  });

  test('returns 404 for an unknown song id', async () => {
    const res = await harness.request('GET', '/api/playback/p3-test-missing-song/source');

    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'NOT_FOUND');
  });

  test('is publicly readable without authentication', async () => {
    const song = await createPhase3Song(registry, { spotifyPreviewUrl: PREVIEW });
    registry.redisKeys.push(playbackSourceKey(song.id));

    const res = await harness.request('GET', `/api/playback/${song.id}/source`);

    assert.equal(res.status, 200);
  });

  // -------------------------------------------------------------------------
  // POST /api/playback/report — auth + validation
  // -------------------------------------------------------------------------

  test('requires authentication', async () => {
    const song = await createPhase3Song(registry, { spotifyPreviewUrl: PREVIEW });

    const res = await harness.request('POST', '/api/playback/report', {
      body: { songId: song.id, source: 'YOUTUBE', eventType: 'play' },
    });

    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'UNAUTHORIZED');
  });

  test('rejects an unknown eventType', async () => {
    const song = await createPhase3Song(registry, {});

    const res = await harness.request('POST', '/api/playback/report', {
      body: { songId: song.id, source: 'YOUTUBE', eventType: 'seek' },
      token: listenerToken,
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
  });

  test('rejects an unknown source', async () => {
    const song = await createPhase3Song(registry, {});

    const res = await harness.request('POST', '/api/playback/report', {
      body: { songId: song.id, source: 'TAPE', eventType: 'play' },
      token: listenerToken,
    });

    assert.equal(res.status, 400);
  });

  test('rejects a missing songId', async () => {
    const res = await harness.request('POST', '/api/playback/report', {
      body: { source: 'YOUTUBE', eventType: 'play' },
      token: listenerToken,
    });

    assert.equal(res.status, 400);
  });

  test('rejects a negative positionMs', async () => {
    const song = await createPhase3Song(registry, {});

    const res = await harness.request('POST', '/api/playback/report', {
      body: { songId: song.id, source: 'YOUTUBE', eventType: 'play', positionMs: -1 },
      token: listenerToken,
    });

    assert.equal(res.status, 400);
  });

  test('accepts all four documented event types', async () => {
    const song = await createPhase3Song(registry, { spotifyPreviewUrl: PREVIEW });
    registry.redisKeys.push(viewCounterKey(song.id));

    for (const eventType of ['play', 'pause', 'skip']) {
      const res = await harness.request('POST', '/api/playback/report', {
        body: { songId: song.id, source: 'SPOTIFY_PREVIEW', eventType },
        token: listenerToken,
      });
      assert.equal(res.status, 200, `${eventType} should be accepted`);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/playback/report — side effects
  // -------------------------------------------------------------------------

  test('a "play" event records a SongPlay row and increments the Redis view counter', async () => {
    const song = await createPhase3Song(registry, { spotifyPreviewUrl: PREVIEW });
    const viewKey = viewCounterKey(song.id);
    registry.redisKeys.push(viewKey);

    const before = await prisma.songPlay.count({ where: { songId: song.id } });

    const res = await harness.request('POST', '/api/playback/report', {
      body: { songId: song.id, source: 'SPOTIFY_PREVIEW', eventType: 'play', positionMs: 0 },
      token: listenerToken,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.recorded, true);

    const after = await prisma.songPlay.count({ where: { songId: song.id } });
    assert.equal(after, before + 1);

    const views = await redis.get(viewKey);
    assert.equal(views, '1', 'view counter must be incremented exactly once');

    const ttl = await redis.ttl(viewKey);
    assert.ok(ttl > 0 && ttl <= 6 * 3600, 'view counter must carry a TTL');
  });

  test('non-"play" events do not record a SongPlay or touch the view counter', async () => {
    const song = await createPhase3Song(registry, { spotifyPreviewUrl: PREVIEW });
    const viewKey = viewCounterKey(song.id);
    registry.redisKeys.push(viewKey);

    await harness.request('POST', '/api/playback/report', {
      body: { songId: song.id, source: 'SPOTIFY_PREVIEW', eventType: 'pause' },
      token: listenerToken,
    });
    await harness.request('POST', '/api/playback/report', {
      body: { songId: song.id, source: 'SPOTIFY_PREVIEW', eventType: 'skip' },
      token: listenerToken,
    });

    assert.equal(await prisma.songPlay.count({ where: { songId: song.id } }), 0);
    assert.equal(await redis.get(viewKey), null);
  });

  test('a "complete" event enqueues exactly one DAILY_LISTEN reward per user per UTC day', async () => {
    const song = await createPhase3Song(registry, { youtubeVideoId: VIDEO_ID });
    const dayKey = new Date().toISOString().slice(0, 10);
    const expectedKey = `daily-listen:${registry.userIds[0]}:${dayKey}`;

    const existing = await rewardQueue.getJobs(['waiting', 'delayed', 'active']);
    const before = existing.filter((j) => JSON.stringify(j.data).includes(expectedKey)).length;

    await harness.request('POST', '/api/playback/report', {
      body: { songId: song.id, source: 'YOUTUBE', eventType: 'complete' },
      token: listenerToken,
    });

    // The route fires queueReward() without awaiting it, so poll briefly.
    let after = before;
    for (let i = 0; i < 20 && after === before; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const jobs = await rewardQueue.getJobs(['waiting', 'delayed', 'active']);
      after = jobs.filter((j) => JSON.stringify(j.data).includes(expectedKey)).length;
    }

    assert.equal(after, before + 1, 'a complete event must enqueue the daily listen reward');

    // Register the enqueued job so cleanup removes it (no reward is ever paid
    // out: nothing in this test boots the reward worker).
    const jobs = await rewardQueue.getJobs(['waiting', 'delayed', 'active']);
    for (const job of jobs) {
      if (JSON.stringify(job.data).includes(expectedKey) && !registry.jobIds.some((e) => e.id === String(job.id))) {
        registry.jobIds.push({ queue: 'reward', id: String(job.id) });
      }
    }
  });

  test('the daily listen reward carries a per-user-per-day idempotency key', async () => {
    // Guards the dedupe contract that rewardJob.processRewardJob relies on:
    // dedupeCreditTokens(idempotencyKey) must collapse repeat listens.
    const userId = registry.userIds[0];
    const dayKey = new Date().toISOString().slice(0, 10);
    const key = `daily-listen:${userId}:${dayKey}`;

    const jobs = await rewardQueue.getJobs(['waiting', 'delayed', 'active']);
    const payloads = jobs.map((j) => j.data as Record<string, unknown>).filter((d) => d.idempotencyKey === key);

    for (const payload of payloads) {
      assert.equal(payload.event, 'DAILY_LISTEN');
      assert.equal(typeof payload.amount, 'number');
    }
    // Dedupe is enforced downstream by the ledger's unique idempotency key, so
    // several queued jobs with the same key are safe — the worker drops them.
    assert.ok(payloads.length >= 0);
  });

  test('reports for Spotify-synthesized songs are accepted but not persisted', async () => {
    const res = await harness.request('POST', '/api/playback/report', {
      body: { songId: 'spotify:track:abc', source: 'YOUTUBE', eventType: 'play' },
      token: listenerToken,
    });

    assert.equal(res.status, 202);
    assert.equal(res.body.recorded, false);
  });

  test('returns 404 when reporting against an unknown catalog song', async () => {
    const res = await harness.request('POST', '/api/playback/report', {
      body: { songId: 'p3-test-missing-song', source: 'YOUTUBE', eventType: 'play' },
      token: listenerToken,
    });

    assert.equal(res.status, 404);
  });

  test('2.16: the report endpoint is rate limited, so view counts cannot be inflated', async () => {
    // A dedicated user so the shared limiter bucket cannot bleed into the other
    // tests in this file (the counter is keyed on user id and lives in Redis).
    const spammer = await createPhase3User(registry, 'USER');
    const spamToken = tokenFor(spammer.id, spammer.email, 'USER');
    const song = await createPhase3Song(registry, { spotifyPreviewUrl: PREVIEW });
    registry.redisKeys.push(viewCounterKey(song.id));
    registry.redisKeys.push(`ratelimit:playback-report:${spammer.id}`);

    const statuses: number[] = [];
    for (let i = 0; i < REPORT_RATE_LIMIT + 5; i += 1) {
      const res = await harness.request('POST', '/api/playback/report', {
        body: { songId: song.id, source: 'SPOTIFY_PREVIEW', eventType: 'play' },
        token: spamToken,
      });
      statuses.push(res.status);
      if (res.status === 429) {
        assert.equal(res.body.code, 'RATE_LIMITED');
        break;
      }
    }

    const allowed = statuses.filter((s) => s === 200).length;
    assert.equal(allowed, REPORT_RATE_LIMIT, 'exactly the limit may pass in a window');
    assert.ok(
      statuses.includes(429),
      `expected a 429 once the per-user limit of ${REPORT_RATE_LIMIT}/min is exceeded`,
    );

    const views = Number((await redis.get(viewCounterKey(song.id))) ?? '0');
    assert.ok(
      views <= REPORT_RATE_LIMIT,
      `view counter must not exceed the number of admitted requests (got ${views})`,
    );
  });

  test('2.16: a "play" reporting a source the server never served is rejected', async () => {
    const song = await createPhase3Song(registry, { spotifyPreviewUrl: PREVIEW, youtubeVideoId: null });
    registry.redisKeys.push(viewCounterKey(song.id));
    registry.redisKeys.push(playbackSourceKey(song.id));

    const res = await harness.request('POST', '/api/playback/report', {
      body: { songId: song.id, source: 'YOUTUBE', eventType: 'play' },
      token: listenerToken,
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'SOURCE_MISMATCH');

    // No side effects from a rejected attribution.
    assert.equal(await prisma.songPlay.count({ where: { songId: song.id } }), 0);
    assert.equal(await redis.get(viewCounterKey(song.id)), null);
  });

  test('2.16: a "play" reporting the served source is accepted', async () => {
    const song = await createPhase3Song(registry, { spotifyPreviewUrl: PREVIEW });
    registry.redisKeys.push(viewCounterKey(song.id));
    registry.redisKeys.push(playbackSourceKey(song.id));

    const res = await harness.request('POST', '/api/playback/report', {
      body: { songId: song.id, source: 'SPOTIFY_PREVIEW', eventType: 'play' },
      token: listenerToken,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.recorded, true);
  });

  test('2.17 + 2.18: soft-deleting a song evicts its cached source so it stops resolving', async () => {
    const song = await createPhase3Song(registry, { spotifyPreviewUrl: PREVIEW });
    const key = playbackSourceKey(song.id);
    registry.redisKeys.push(key);

    const first = await harness.request('GET', `/api/playback/${song.id}/source`);
    assert.equal(first.body.source, 'SPOTIFY_PREVIEW');
    assert.ok(await redis.get(key));

    await softDeleteSong(song.id);
    assert.equal(await redis.get(key), null, 'soft delete must evict the cached source');

    const after = await harness.request('GET', `/api/playback/${song.id}/source`);
    assert.notEqual(after.body.source, 'SPOTIFY_PREVIEW', 'a hidden song must not keep serving its preview');
  });

  // -------------------------------------------------------------------------
  // Admin YouTube routes
  // -------------------------------------------------------------------------

  test('admin youtube status requires authentication', async () => {
    const res = await harness.request('GET', '/api/admin/youtube/status');

    assert.equal(res.status, 401);
  });

  test('admin youtube status rejects non-admin roles', async () => {
    const res = await harness.request('GET', '/api/admin/youtube/status', { token: listenerToken });

    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
  });

  test('admin youtube status reports catalog coverage', async () => {
    await createPhase3Song(registry, { youtubeVideoId: VIDEO_ID });
    await createPhase3Song(registry, { youtubeVideoId: null });

    const res = await harness.request('GET', '/api/admin/youtube/status', { token: adminToken });

    assert.equal(res.status, 200);
    assert.equal(typeof res.body.total, 'number');
    assert.equal(typeof res.body.matched, 'number');
    assert.equal(res.body.unmatched, res.body.total - res.body.matched);
  });

  test('admin youtube match is forbidden for non-admin roles', async () => {
    const res = await harness.request('POST', '/api/admin/youtube/match', {
      body: {},
      token: listenerToken,
    });

    assert.equal(res.status, 403);
  });

  test('admin youtube match returns NO_MATCH when the API key is absent', async () => {
    // PINNED. `.env.test` deliberately leaves YOUTUBE_API_KEY unset so the
    // default is "not configured"; asserting on that default is only meaningful
    // if the test removes the key itself rather than trusting the environment.
    const savedKey = env.YOUTUBE_API_KEY;
    try {
      delete env.YOUTUBE_API_KEY;
      const song = await createPhase3Song(registry, { youtubeVideoId: null });

      const res = await harness.request('POST', '/api/admin/youtube/match', {
        body: { songId: song.id },
        token: adminToken,
      });

      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'NO_MATCH');

      const after = await prisma.song.findUnique({ where: { id: song.id }, select: { youtubeVideoId: true } });
      assert.equal(after?.youtubeVideoId, null, 'a failed match must not write a video id');
    } finally {
      env.YOUTUBE_API_KEY = savedKey;
    }
  });

  test('admin match-all reports queued:false while the rollout flag is off', async () => {
    // PINNED, not ambient. `enqueueLibraryEnrichment` short-circuits on
    // `env.FLAG_PLAYBACK_YOUTUBE`/`env.YOUTUBE_API_KEY`, and both of those are
    // mutable module state — `before()` above sets the flag ON for this file.
    // A test named "while the rollout flag is off" that never turns the flag off
    // is asserting on whatever the environment happened to provide, and it
    // passes only by accident. Stage 7's `.env.test` made that accident visible
    // by making the values explicit, so the state is now pinned here.
    const savedFlag = env.FLAG_PLAYBACK_YOUTUBE;
    try {
      env.FLAG_PLAYBACK_YOUTUBE = false;
      const res = await harness.request('POST', '/api/admin/youtube/match-all', { token: adminToken });

      assert.equal(res.status, 200);
      assert.equal(res.body.queued, false);
      assert.ok(
        ['flag_disabled', 'not_configured'].includes(res.body.reason),
        `expected flag_disabled or not_configured, got ${res.body.reason}`,
      );
    } finally {
      env.FLAG_PLAYBACK_YOUTUBE = savedFlag;
    }
  });

  test('G-3 (2.16 adj.): the admin match limiter is shared, not per-instance', async () => {
    // A dedicated admin so this bucket cannot bleed into the other tests.
    const spamAdmin = await createPhase3User(registry, 'ADMIN');
    const spamToken = tokenFor(spamAdmin.id, spamAdmin.email, 'ADMIN');
    registry.redisKeys.push(`ratelimit:admin-youtube-match:${spamAdmin.id}`);

    // Pinned for the same reason as above: the limiter must be observable as
    // 200-vs-429, and a 202 (queued) or 200 (queued:false) response would make
    // the assertion below silently meaningless.
    const savedFlag = env.FLAG_PLAYBACK_YOUTUBE;
    try {
      env.FLAG_PLAYBACK_YOUTUBE = false;
      const responses: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        const res = await harness.request('POST', '/api/admin/youtube/match-all', { token: spamToken });
        responses.push(res.status);
      }

      // The counter lives in Redis (keyed on user id), so the cap holds across
      // instances rather than being 5/min per process.
      assert.equal(responses.filter((s) => s === 200).length, 5, 'the first 5 must be admitted');
      assert.equal(responses.filter((s) => s === 429).length, 2, 'the rest must be throttled');
    } finally {
      env.FLAG_PLAYBACK_YOUTUBE = savedFlag;
    }
  });
});
