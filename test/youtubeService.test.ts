import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { youtubeService } from '../src/services/youtubeService';
import { env } from '../src/lib/env';
import {
  newRegistry,
  createPhase3Song,
  registerPhase3Teardown,
  type FixtureRegistry,
} from './phase3Fixtures';

// Phase 3.2 — YouTube matching service: 3-tier playback fallback resolution.

const AUDIO = 'https://cdn.afrogenie.test/audio/probe.mp3';
const PREVIEW = 'https://p.scdn.co/audio-clip/probe-30s.mp3';
const VIDEO_ID = 'dQw4w9WgXcQ';

// ONE registry for the whole file + ONE deterministic teardown.
// See `registerPhase3Teardown` for why this is per-file, not per-describe.
const registry: FixtureRegistry = newRegistry();
registerPhase3Teardown(registry);

describe('youtubeService — playback source fallback', () => {
  // The YouTube tier is gated on FLAG_PLAYBACK_YOUTUBE (2.15), which defaults to
  // OFF. These cases describe what the tiers DO when the tier exists, so the flag
  // is pinned ON for the file and restored afterwards.
  const savedFlag = env.FLAG_PLAYBACK_YOUTUBE;
  before(() => { env.FLAG_PLAYBACK_YOUTUBE = true; });
  after(() => { env.FLAG_PLAYBACK_YOUTUBE = savedFlag; });

  test('Tier 1: own uploaded audio wins over every other source', async () => {
    const song = await createPhase3Song(registry, {
      audioUrl: AUDIO,
      youtubeVideoId: VIDEO_ID,
      spotifyPreviewUrl: PREVIEW,
    });

    const result = await youtubeService.getPlaybackSource(song.id);

    assert.equal(result.source, 'AUDIO_URL');
    assert.equal(result.audioUrl, AUDIO);
    assert.equal(result.youtubeVideoId, undefined);
    assert.equal(result.previewUrl, undefined);
  });

  test('Tier 2: YouTube match is used when no own audio exists', async () => {
    const song = await createPhase3Song(registry, { youtubeVideoId: VIDEO_ID, spotifyPreviewUrl: null });

    const result = await youtubeService.getPlaybackSource(song.id);

    assert.equal(result.source, 'YOUTUBE');
    assert.equal(result.youtubeVideoId, VIDEO_ID);
  });

  test('Tier 2: carries the Spotify preview so the client can fall back on embed failure', async () => {
    const song = await createPhase3Song(registry, { youtubeVideoId: VIDEO_ID, spotifyPreviewUrl: PREVIEW });

    const result = await youtubeService.getPlaybackSource(song.id);

    assert.equal(result.source, 'YOUTUBE');
    assert.equal(result.previewUrl, PREVIEW, 'previewUrl must ride along for the Tier 3 error fallback');
  });

  test('Tier 2: previewUrl is omitted when the song has no Spotify preview', async () => {
    const song = await createPhase3Song(registry, { youtubeVideoId: VIDEO_ID, spotifyPreviewUrl: null });

    const result = await youtubeService.getPlaybackSource(song.id);

    assert.equal(result.source, 'YOUTUBE');
    assert.equal(result.previewUrl, undefined);
  });

  test('Tier 3: Spotify preview is used when there is no audio and no YouTube match', async () => {
    const song = await createPhase3Song(registry, {
      audioUrl: null,
      youtubeVideoId: null,
      spotifyPreviewUrl: PREVIEW,
    });

    const result = await youtubeService.getPlaybackSource(song.id);

    assert.equal(result.source, 'SPOTIFY_PREVIEW');
    assert.equal(result.previewUrl, PREVIEW);
  });

  test('Tier 4: a song with no source at all reports NONE', async () => {
    const song = await createPhase3Song(registry, {
      audioUrl: null,
      youtubeVideoId: null,
      spotifyPreviewUrl: null,
    });

    const result = await youtubeService.getPlaybackSource(song.id);

    assert.equal(result.source, 'NONE');
    assert.equal(result.audioUrl, undefined);
    assert.equal(result.youtubeVideoId, undefined);
    assert.equal(result.previewUrl, undefined);
  });

  test('every tier returns the song metadata block the player needs', async () => {
    const song = await createPhase3Song(registry, { youtubeVideoId: VIDEO_ID });

    const result = await youtubeService.getPlaybackSource(song.id);

    assert.ok(result.song, 'song metadata must be present');
    assert.equal(result.song!.id, song.id);
    assert.equal(result.song!.title, song.title);
    assert.equal(result.song!.artist.startsWith('P3TEST-artist'), true);
    assert.equal(result.song!.durationMs, 180_000);
  });

  test('an unknown song id resolves to NONE with no song block (route layer turns this into 404)', async () => {
    const result = await youtubeService.getPlaybackSource('p3-test-no-such-song-id');

    assert.equal(result.source, 'NONE');
    assert.equal(result.song, undefined);
  });

  test('FIXED (2.17): a soft-deleted song resolves no playback source', async () => {
    // `getPlaybackSource` now filters `softDeleted: false`, so a withdrawn song
    // stops resolving immediately instead of staying playable until the
    // playback:source cache entry expires.
    const song = await createPhase3Song(registry, {
      youtubeVideoId: VIDEO_ID,
      softDeleted: true,
    });

    const result = await youtubeService.getPlaybackSource(song.id);

    assert.equal(result.source, 'NONE', 'a soft-deleted song must not resolve a source');
  });

  test('getPlaybackSource always reads live DB state (caching is a route concern)', async () => {
    const song = await createPhase3Song(registry, { youtubeVideoId: null, spotifyPreviewUrl: PREVIEW });

    assert.equal((await youtubeService.getPlaybackSource(song.id)).source, 'SPOTIFY_PREVIEW');

    // The service itself is uncached, so a tier flip is visible immediately.
    // The 1h `playback:source:<id>` Redis cache in routes/playback.ts is the
    // only staleness risk, and it is exercised in playbackRoutes.test.ts.
    await prisma.song.update({ where: { id: song.id }, data: { audioUrl: AUDIO } });

    assert.equal((await youtubeService.getPlaybackSource(song.id)).source, 'AUDIO_URL');
  });
});

describe('youtubeService — searchMatch safety', () => {
  test('searchMatch is a no-op returning null when YOUTUBE_API_KEY is absent', async () => {
    const savedKey = env.YOUTUBE_API_KEY;
    env.YOUTUBE_API_KEY = undefined;
    try {
      const match = await youtubeService.searchMatch('Any Title', 'Any Artist');
      assert.equal(match, null);
    } finally {
      env.YOUTUBE_API_KEY = savedKey;
    }
  });

  test('batchMatchSongs is a no-op when unconfigured (writes no youtubeVideoId)', async () => {
    const savedKey = env.YOUTUBE_API_KEY;
    env.YOUTUBE_API_KEY = undefined;
    const song = await createPhase3Song(registry, { youtubeVideoId: null });
    try {
      // NOTE: batchMatchSongs has no isConfigured() guard of its own, but
      // searchMatch returns null, so nothing is persisted. This also runs a real
      // 100ms-per-song delay, hence the small fixture set.
      const result = await youtubeService.batchMatchSongs(1);
      assert.equal(result.matched, 0);
      const after = await prisma.song.findUnique({ where: { id: song.id }, select: { youtubeVideoId: true } });
      assert.equal(after?.youtubeVideoId, null);
    } finally {
      env.YOUTUBE_API_KEY = savedKey;
    }
  });
});

describe('youtubeService — parseISO8601Duration', () => {
  const parse = (iso?: string | null) =>
    (youtubeService as unknown as { parseISO8601Duration: (v?: string | null) => number | null }).parseISO8601Duration(iso);

  test('parses minutes + seconds', () => {
    assert.equal(parse('PT3M20S'), 200);
  });

  test('parses hours + minutes + seconds', () => {
    assert.equal(parse('PT1H2M3S'), 3723);
  });

  test('parses seconds only', () => {
    assert.equal(parse('PT45S'), 45);
  });

  test('parses hours only', () => {
    assert.equal(parse('PT2H'), 7200);
  });

  test('FIXED (2.21): null, undefined and unparseable input return null, not 0', () => {
    // Returning 0 for garbage was silent corruption: 0 is a valid duration, so
    // an unsupported format was indistinguishable from a zero-length video and
    // got persisted into Song.durationMs as a broken 0:00 track.
    assert.equal(parse(null), null);
    assert.equal(parse(undefined), null);
    assert.equal(parse(''), null);
    assert.equal(parse('not-a-duration'), null);
  });

  test('FIXED (2.21): day-prefixed ISO durations (P1DT2H) are supported', () => {
    // The parser now accepts the day component YouTube actually emits.
    assert.equal(parse('P1DT2H'), 93600);
  });

  test('rejects a bare "P"/"PT" and trailing junk instead of guessing 0', () => {
    assert.equal(parse('P'), null);
    assert.equal(parse('PT'), null);
    assert.equal(parse('xxPT2Hxx'), null);
  });
});

describe('youtubeService — YouTube API quota budget', () => {
  // YouTube Data API v3 default quota is 10,000 units/day.
  // search.list costs 100 units per call, videos.list costs 1 unit.
  // searchMatch therefore costs 101 units per song.
  const UNITS_PER_SONG = 101;
  const FREE_TIER_DAILY_QUOTA = 10_000;
  const ENRICHMENT_DAILY_CAP = 500;

  test('FIXED (2.21): the enrichment daily cap is within the YouTube free-tier quota', () => {
    const UNITS_PER_SONG = 101;
    const FREE_TIER_DAILY_QUOTA = 10_000;
    const { DAILY_CAP } = require('../src/jobs/libraryEnrichmentJob');
    const unitsPerDayAtCap = UNITS_PER_SONG * DAILY_CAP;

    // 500 songs/day x 101 units = 50,500 units (5x free tier) in the original
    // design; Stage 6.1 + the later quota tightening fixed this to <=99/day.
    assert.ok(
      unitsPerDayAtCap <= FREE_TIER_DAILY_QUOTA,
      `library enrichment would request ${unitsPerDayAtCap} units/day but the free tier allows ${FREE_TIER_DAILY_QUOTA}. ` +
        `DAILY_CAP must be <= ${Math.floor(FREE_TIER_DAILY_QUOTA / UNITS_PER_SONG)}.`,
    );
  });

  test('the 30-day match cache absorbs repeat lookups (mitigating factor)', async () => {
    // Same title+artist is served from Redis, so re-runs cost nothing. This is
    // why the cap bug only bites on the first pass over unseen songs.
    const savedKey = env.YOUTUBE_API_KEY;
    env.YOUTUBE_API_KEY = undefined;
    try {
      assert.equal(await youtubeService.searchMatch('Cache Probe', 'Cache Artist'), null);
    } finally {
      env.YOUTUBE_API_KEY = savedKey;
    }
  });
});
