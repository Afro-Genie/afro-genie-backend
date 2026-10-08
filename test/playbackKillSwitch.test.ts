import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { env } from '../src/lib/env';
import {
  newRegistry,
  createPhase3Song,
  createPhase3User,
  registerPhase3Teardown,
  startPhase3Harness,
  playbackSourceKey,
  type FixtureRegistry,
  type Harness,
} from './phase3Fixtures';

// Phase 2 task 2.3 — the playback kill switch, proved AT THE ROUTE.
//
// Task 2.2 (done previously) made `FLAG_PLAYBACK_YOUTUBE` gate the YouTube tier
// inside `youtubeService.getPlaybackSource`. That was verified at the JOB layer
// (`libraryEnrichmentJob.test.ts` asserts `flag_disabled`) and for the admin
// match-all endpoint — but `playbackRoutes.test.ts` pins the flag ON for its whole
// run so the tier tests can exercise each tier. So nothing proved the thing Phase 2
// exists to guarantee: that flipping one env var stops YouTube playback being
// SERVED. This file is that proof, in its own file so it can control the flag.
//
// WHY A SEPARATE FILE, AND WHY IT MATTERS
//
// `GET /api/playback/:songId/source` caches its resolved tier in Redis for an hour.
// The route consults that cache BEFORE calling the resolver, and the cache key
// carries no flag state. So with the flag ON, a song caches `{source:'YOUTUBE'}` —
// and turning the flag off still served that cached answer for up to an hour.
//
// That defeats the flag's entire purpose. `youtubeService`'s own comment says the
// point is that a bad `youtubeVideoId` must be recoverable *in place*, without a
// direct DB write; an env change that takes up to an hour to bite is not the
// in-place lever it claims to be. `resolvePlaybackSource` now treats a cached
// YOUTUBE answer as a miss while the flag is off. These tests pin that.
//
// SCOPE, STATED HONESTLY: the flag gates the YOUTUBE TIER only. Own-uploaded
// audio (Tier 1) is not flag-gated and keeps working — that is deliberate, and
// asserted below. "Flag off" means "no YouTube tier", not "no playback at all".
// The Spotify 30s preview (old Tier 3) was removed in Phase 3, so a song with no
// own audio and no (gated) YouTube match resolves to NONE.

const PREVIEW = 'https://p.scdn.co/audio-clip/killswitch.mp3';
const VIDEO_ID = 'k1llSw1tchV1d';
const AUDIO = 'https://cdn.afrogenie.test/audio/killswitch.mp3';

const tokenFor = (userId: string, email: string, role: string) =>
  jwt.sign({ userId, email, role }, env.JWT_SECRET, { expiresIn: '5m' });

const registry: FixtureRegistry = newRegistry();
registerPhase3Teardown(registry);

let harness: Harness;
let savedFlag: boolean;
let listenerToken: string;

const setFlag = (value: boolean) => {
  env.FLAG_PLAYBACK_YOUTUBE = value;
};

describe('playback kill switch (2.3) — flag off stops the YouTube tier over HTTP', () => {
  before(async () => {
    savedFlag = env.FLAG_PLAYBACK_YOUTUBE;
    harness = await startPhase3Harness();

    const listener = await createPhase3User(registry, 'USER');
    listenerToken = tokenFor(listener.id, listener.email, 'USER');
  });

  after(async () => {
    env.FLAG_PLAYBACK_YOUTUBE = savedFlag;
    await harness.close();
  });

  beforeEach(() => {
    setFlag(true);
  });

  // -------------------------------------------------------------------------
  // Baseline: with the flag on, the YouTube tier is served.
  // -------------------------------------------------------------------------

  test('flag ON serves the YouTube tier over HTTP', async () => {
    const song = await createPhase3Song(registry, {
      youtubeVideoId: VIDEO_ID,
      spotifyPreviewUrl: PREVIEW,
    });
    registry.redisKeys.push(playbackSourceKey(song.id));

    const res = await harness.request('GET', `/api/playback/${song.id}/source`);

    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'YOUTUBE');
    assert.equal(res.body.youtubeVideoId, VIDEO_ID);
  });

  test('the YouTube answer is actually cached, so a flag flip has something to defeat', async () => {
    // Guards the test below from passing for the wrong reason. If the resolver
    // stopped caching, "flag off ignores the cache" would be trivially true and
    // prove nothing about the kill switch.
    const song = await createPhase3Song(registry, {
      youtubeVideoId: VIDEO_ID,
      spotifyPreviewUrl: PREVIEW,
    });
    const key = playbackSourceKey(song.id);
    registry.redisKeys.push(key);

    const res = await harness.request('GET', `/api/playback/${song.id}/source`);
    assert.equal(res.body.source, 'YOUTUBE');

    const cached = await redis.get(key);
    assert.ok(cached, 'the YouTube answer must be cached for this file to mean anything');
    const entry = JSON.parse(cached) as { flagPlaybackYoutube: boolean; value: { source: string } };
    assert.equal(entry.value.source, 'YOUTUBE');
    assert.equal(entry.flagPlaybackYoutube, true, 'the entry records the flag state it was built under');
  });

  // -------------------------------------------------------------------------
  // The regression: a warm cache must not outlive the kill switch.
  // -------------------------------------------------------------------------

  test('flag OFF stops serving YouTube even when the YouTube answer is cached', async () => {
    const song = await createPhase3Song(registry, {
      youtubeVideoId: VIDEO_ID,
      spotifyPreviewUrl: PREVIEW,
    });
    const key = playbackSourceKey(song.id);
    registry.redisKeys.push(key);

    // Warm the cache with the flag ON, exactly as production traffic would.
    const warm = await harness.request('GET', `/api/playback/${song.id}/source`);
    assert.equal(warm.body.source, 'YOUTUBE');
    assert.ok(await redis.get(key), 'the cache must be warm going into the flip');

    // The single env change. No restart, no cache flush, no DB write.
    setFlag(false);

    const after = await harness.request('GET', `/api/playback/${song.id}/source`);

    assert.equal(after.status, 200);
    assert.notEqual(
      after.body.source,
      'YOUTUBE',
      'a cached YouTube answer must not survive the kill switch',
    );
    assert.equal(after.body.source, 'NONE', 'it must fall through to no source');
    assert.equal(after.body.youtubeVideoId, undefined, 'no video id may leak in the response');
  });

  test('flag OFF on a cold cache never serves YouTube', async () => {
    const song = await createPhase3Song(registry, {
      youtubeVideoId: VIDEO_ID,
      spotifyPreviewUrl: PREVIEW,
    });
    registry.redisKeys.push(playbackSourceKey(song.id));

    setFlag(false);

    const res = await harness.request('GET', `/api/playback/${song.id}/source`);

    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'NONE');
  });

  test('a song with no fallback resolves to NONE, not YOUTUBE, with the flag off', async () => {
    // No own audio: the only source that could exist is YouTube. Turning the
    // flag off must remove playback, not misreport it.
    const song = await createPhase3Song(registry, {
      audioUrl: null,
      youtubeVideoId: VIDEO_ID,
      spotifyPreviewUrl: null,
    });
    registry.redisKeys.push(playbackSourceKey(song.id));

    setFlag(false);

    const res = await harness.request('GET', `/api/playback/${song.id}/source`);

    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'NONE');
  });

  // -------------------------------------------------------------------------
  // The switch is reversible, and it does not over-reach.
  // -------------------------------------------------------------------------

  test('turning the flag back ON serves YouTube again (the switch is not one-way)', async () => {
    const song = await createPhase3Song(registry, {
      youtubeVideoId: VIDEO_ID,
      spotifyPreviewUrl: PREVIEW,
    });
    const key = playbackSourceKey(song.id);
    registry.redisKeys.push(key);

    setFlag(false);
    const off = await harness.request('GET', `/api/playback/${song.id}/source`);
    assert.equal(off.body.source, 'NONE');

    setFlag(true);
    const on = await harness.request('GET', `/api/playback/${song.id}/source`);

    assert.equal(on.body.source, 'YOUTUBE', 'the rollout must be resumable without a cache flush');
  });

  test('flag OFF does not touch own-uploaded audio (Tier 1 is not flag-gated)', async () => {
    // First-party content the artist uploaded. Gating it would break paying
    // artists' songs on a flag that exists to disable YouTube, so the kill switch
    // must be scoped to the tier it names.
    const song = await createPhase3Song(registry, {
      audioUrl: AUDIO,
      youtubeVideoId: VIDEO_ID,
    });
    registry.redisKeys.push(playbackSourceKey(song.id));

    setFlag(false);

    const res = await harness.request('GET', `/api/playback/${song.id}/source`);

    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'AUDIO_URL');
    assert.equal(res.body.audioUrl, AUDIO);
  });

  test('a non-YouTube song keeps working from cache with the flag off, after one re-resolve', async () => {
    // The fix must not have degraded into "never use the cache while the flag is
    // off", which would send every dark-mode request to the database. Only a
    // flag transition costs a re-resolve — steady state must still be a cache hit.
    const song = await createPhase3Song(registry, { audioUrl: AUDIO });
    const key = playbackSourceKey(song.id);
    registry.redisKeys.push(key);

    const warm = await harness.request('GET', `/api/playback/${song.id}/source`);
    assert.equal(warm.body.source, 'AUDIO_URL');

    setFlag(false);

    // First request after the transition: the entry was written with the old flag
    // state, so it is a miss and re-resolves. The answer is unchanged — only the
    // recorded flag state moves.
    const afterFlip = await harness.request('GET', `/api/playback/${song.id}/source`);
    assert.equal(afterFlip.body.source, 'AUDIO_URL');
    const reResolved = await redis.get(key);
    assert.equal(
      JSON.parse(reResolved as string).flagPlaybackYoutube,
      false,
      'the rewritten entry records the flag state it was computed under',
    );

    // Second request, flag unchanged: a true cache hit, so the entry is untouched.
    const steady = await harness.request('GET', `/api/playback/${song.id}/source`);
    assert.equal(steady.body.source, 'AUDIO_URL');
    assert.equal(
      await redis.get(key),
      reResolved,
      'in steady state the cache must be reused, not rewritten on every request',
    );
  });

  // -------------------------------------------------------------------------
  // The kill switch has to reach the write path too, or the client can keep
  // recording plays against a tier the server has stopped serving.
  // -------------------------------------------------------------------------

  test('flag OFF makes a YOUTUBE play report a 409, while the served tier is accepted', async () => {
    const song = await createPhase3Song(registry, {
      audioUrl: null,
      youtubeVideoId: VIDEO_ID,
      spotifyPreviewUrl: PREVIEW,
    });
    registry.redisKeys.push(playbackSourceKey(song.id));

    setFlag(false);

    const stale = await harness.request('POST', '/api/playback/report', {
      token: listenerToken,
      body: { songId: song.id, source: 'YOUTUBE', eventType: 'play' },
    });

    assert.equal(stale.status, 409, 'a client still reporting YouTube must be rejected');
    assert.equal(stale.body.code, 'SOURCE_MISMATCH');

    const current = await harness.request('POST', '/api/playback/report', {
      token: listenerToken,
      body: { songId: song.id, source: 'NONE', eventType: 'play' },
    });

    assert.equal(current.status, 200, 'the source actually served must be accepted');
    assert.equal(await prisma.songPlay.count({ where: { songId: song.id } }), 1);
  });
});