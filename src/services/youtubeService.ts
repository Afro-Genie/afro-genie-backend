import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { env } from '../lib/env';

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';

const SEARCH_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MATCH_DELAY_MS = 100; // YouTube free tier: 10,000 units/day

/**
 * The YouTube playback rollout kill switch (2.15).
 *
 * Read from `env` rather than the `featureFlags` module so it is re-evaluated
 * per call and testable without importing the flag registry. The UI flag
 * (`featureFlags.PLAYBACK_YOUTUBE`) gates the *frontend* component; this gates
 * the *server's* decision about which source to hand out, which is the lever
 * that actually matters — a cached frontend bundle cannot be trusted to honour
 * the rollout.
 */
export const youtubePlaybackEnabled = (): boolean => env.FLAG_PLAYBACK_YOUTUBE;

export interface YouTubeMatch {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string | null;
  /**
   * `null` means UNKNOWN, and is distinct from `0`.
   *
   * YouTube's `contentDetails.duration` is an ISO-8601 string that the API can
   * emit in forms our parser does not accept, and a live stream reports
   * `PT0S` — a genuine zero. Collapsing the two made an unparseable duration
   * indistinguishable from a zero-length video (2.21).
   *
   * Nothing currently persists this field — neither `matchSong()` nor
   * `processLibraryEnrichmentJob()` writes `durationMs` from a match. It is
   * nullable so that whoever eventually does cannot reintroduce the bug by
   * arithmetic on a sentinel.
   */
  durationSeconds: number | null;
}

export type PlaybackSourceKind = 'AUDIO_URL' | 'YOUTUBE' | 'SPOTIFY_PREVIEW' | 'NONE';

/**
 * Stage 6.1 — the outcome of a YouTube lookup, with the failure modes kept apart.
 *
 * `searchMatch()` returns `YouTubeMatch | null`, and that collapse is safe for
 * its original callers but NOT for the enrichment job, which now keeps a
 * per-song attempt counter. The three outcomes below demand different
 * treatment, and `null` cannot express the difference:
 *
 *   - `no_match`  YouTube answered and there is no video for this song. The
 *                 song is genuinely unmatchable. This is the ONLY outcome that
 *                 may dead-letter a song.
 *   - `error`     The lookup did not complete: 403 quotaExceeded, a 5xx, a
 *                 network fault, a missing API key. Nothing was learned about
 *                 the song. Counting this as a failed attempt would let an
 *                 API outage dead-letter the entire catalog — five exhausted
 *                 quota days in a row would retire all 924 songs and the
 *                 catalog could never be matched again.
 *   - `matched`   A usable video id.
 *
 * `retryable` is advisory: it separates "try again tomorrow" from "this request
 * will never work" for logging. Neither is ever treated as a song-level failure.
 */
export type YouTubeLookupResult =
  | { status: 'matched'; match: YouTubeMatch }
  | { status: 'no_match' }
  | { status: 'error'; reason: string; retryable: boolean };

export interface PlaybackSource {
  source: PlaybackSourceKind;
  audioUrl?: string;
  youtubeVideoId?: string;
  previewUrl?: string;
  song?: {
    id: string;
    title: string;
    artist: string;
    coverImageUrl: string | null;
    durationMs: number | null;
  };
}

class YouTubeService {
  private isConfigured(): boolean {
    return Boolean(env.YOUTUBE_API_KEY);
  }

  /**
   * Stage 6.1 — the outcome-preserving form of `searchMatch`.
   *
   * This is the primitive; `searchMatch()` is a thin wrapper over it so the
   * pre-existing callers keep their `YouTubeMatch | null` contract unchanged.
   */
  async lookupMatch(songTitle: string, artistName: string): Promise<YouTubeLookupResult> {
    if (!this.isConfigured()) {
      logger.debug('YouTube search skipped — YOUTUBE_API_KEY is not configured');
      // Not a song-level failure: nothing was asked of YouTube at all.
      return { status: 'error', reason: 'not_configured', retryable: false };
    }

    const cacheKey = `youtube:match:${songTitle.toLowerCase()}:${artistName.toLowerCase()}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return { status: 'matched', match: JSON.parse(cached) as YouTubeMatch };
    } catch (err) {
      logger.warn({ err }, 'YouTube cache read failed');
    }

    const query = `${songTitle} ${artistName} official audio`;
    let best: { id?: { videoId?: string }; snippet?: Record<string, any> } | undefined;

    try {
      const res = await fetch(
        `${YOUTUBE_API}/search?part=snippet&q=${encodeURIComponent(query)}&type=video&videoCategoryId=10&maxResults=3&key=${env.YOUTUBE_API_KEY}`,
      );
      if (!res.ok) {
        logger.warn({ status: res.status }, 'YouTube search failed');
        // 403/429 are quota/rate limits: transient and song-independent.
        // Anything else is likely a bad key or a request we got wrong, which
        // retrying tomorrow will not fix. Neither says anything about the song,
        // so neither may dead-letter it.
        const retryable = res.status === 403 || res.status === 429 || res.status >= 500;
        return { status: 'error', reason: `http_${res.status}`, retryable };
      }
      const data = (await res.json()) as { items?: Array<{ id?: { videoId?: string }; snippet?: Record<string, any> }> };
      best = data.items?.[0];
    } catch (err) {
      logger.warn({ err }, 'YouTube search request errored');
      return { status: 'error', reason: 'network', retryable: true };
    }

    const videoId = best?.id?.videoId;
    // YouTube answered successfully and offered no usable video. This is the one
    // outcome that is a statement about the song rather than about the request.
    if (!videoId || !best?.snippet) return { status: 'no_match' };

    const thumbnails = (best.snippet.thumbnails ?? {}) as Record<string, { url?: string }>;
    const match: YouTubeMatch = {
      videoId,
      title: best.snippet.title ?? songTitle,
      channelTitle: best.snippet.channelTitle ?? artistName,
      thumbnailUrl: thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null,
      // Unknown until proven. Not 0 — see YouTubeMatch.durationSeconds.
      durationSeconds: null,
    };

    try {
      const detailsRes = await fetch(
        `${YOUTUBE_API}/videos?part=contentDetails&id=${videoId}&key=${env.YOUTUBE_API_KEY}`,
      );
      if (detailsRes.ok) {
        const details = (await detailsRes.json()) as {
          items?: Array<{ contentDetails?: { duration?: string } }>;
        };
        const rawDuration = details.items?.[0]?.contentDetails?.duration;
        const duration = this.parseISO8601Duration(rawDuration);
        if (duration === null) {
          // Signal, do not fabricate. The match still stands — the video id and
          // thumbnails are usable — but the duration stays unknown rather than
          // becoming a plausible-looking 0.
          logger.warn(
            { videoId, duration: rawDuration },
            'Unparseable ISO-8601 duration from YouTube - durationSeconds left unknown',
          );
        } else {
          match.durationSeconds = duration;
        }
      }
    } catch (err) {
      logger.warn({ err, videoId }, 'YouTube duration lookup failed');
    }

    try {
      await redis.set(cacheKey, JSON.stringify(match), 'EX', SEARCH_CACHE_TTL_SECONDS);
    } catch (err) {
      logger.warn({ err }, 'YouTube cache write failed');
    }

    return { status: 'matched', match };
  }

  /** Search YouTube for the best match for a song title + artist. */
  async searchMatch(songTitle: string, artistName: string): Promise<YouTubeMatch | null> {
    const result = await this.lookupMatch(songTitle, artistName);
    return result.status === 'matched' ? result.match : null;
  }

  /** Batch match up to `limit` unmatched songs, highest-viewed first. */
  async batchMatchSongs(limit = 50): Promise<{ matched: number; failed: number }> {
    const songs = await prisma.song.findMany({
      where: { softDeleted: false, youtubeVideoId: null },
      include: { artist: { select: { name: true } } },
      orderBy: { views: 'desc' },
      take: limit,
    });

    let matched = 0;
    let failed = 0;

    for (const song of songs) {
      try {
        // Stage 6.1 — share the job's accounting so the two paths cannot drift:
        // reset on match, increment on a genuine no-match, leave the counter
        // alone when the lookup itself failed.
        const result = await this.lookupMatch(song.title, song.artist.name);
        if (result.status === 'matched') {
          await prisma.song.update({
            where: { id: song.id },
            data: {
              youtubeVideoId: result.match.videoId,
              youtubeMatchedAt: new Date(),
              youtubeMatchAttempts: 0,
            },
          });
          matched++;
        } else if (result.status === 'no_match') {
          await prisma.song.update({
            where: { id: song.id },
            data: { youtubeMatchAttempts: { increment: 1 } },
          });
          failed++;
        } else {
          failed++;
        }
      } catch (err) {
        logger.warn({ songId: song.id, err }, 'YouTube match failed for song');
        failed++;
      }
      await new Promise((r) => setTimeout(r, MATCH_DELAY_MS));
    }

    return { matched, failed };
  }

  /** Match a single song by id. */
  async matchSong(songId: string): Promise<YouTubeMatch | null> {
    const song = await prisma.song.findUnique({
      where: { id: songId },
      include: { artist: { select: { name: true } } },
    });
    if (!song) return null;

    const result = await this.lookupMatch(song.title, song.artist.name);
    if (result.status !== 'matched') return null;

    await prisma.song.update({
      where: { id: song.id },
      // Stage 6.1 — an operator-forced match clears any accumulated failures.
      data: {
        youtubeVideoId: result.match.videoId,
        youtubeMatchedAt: new Date(),
        youtubeMatchAttempts: 0,
      },
    });
    return result.match;
  }

  /**
   * Resolve the best available playback source for a song using the 3-tier
   * fallback: own uploaded audio → YouTube → Spotify preview → none.
   *
   * Two guards live here, both closing a production-defect lever:
   *
   *  - `FLAG_PLAYBACK_YOUTUBE` is the kill switch (2.15). When it is off the
   *    YouTube tier is skipped entirely and the caller falls through to the
   *    Spotify preview, i.e. the pre-YouTube behaviour. This is what makes a bad
   *    match recoverable *in place*: previously the only way to stop serving a
   *    bad `youtubeVideoId` was a direct DB write, which is exactly what made
   *    the §1 incident unrecoverable.
   *  - `softDeleted: false` (2.17). A bare `findUnique({ where: { id } })`
   *    happily resolved soft-deleted songs, so a hidden song stayed playable
   *    for as long as its `playback:source:*` cache entry survived.
   */
  async getPlaybackSource(songId: string): Promise<PlaybackSource> {
    const song = await prisma.song.findFirst({
      where: { id: songId, softDeleted: false },
      include: { artist: { select: { name: true } } },
    });
    if (!song) return { source: 'NONE' };

    const songInfo = {
      id: song.id,
      title: song.title,
      artist: song.artist?.name ?? 'Unknown Artist',
      coverImageUrl: song.imageUrl ?? null,
      durationMs: song.durationMs ?? null,
    };

    // Tier 1: own uploaded audio — first-party content, never flag-gated.
    if (song.audioUrl) {
      return { source: 'AUDIO_URL', audioUrl: song.audioUrl, song: songInfo };
    }

    // Tier 2: matched YouTube video. Carry the Spotify preview URL so the
    // frontend can fall back to Tier 3 if the embed is blocked or errors.
    // Gated on the rollout flag: with the flag off this tier does not exist and
    // the resolver degrades to Tier 3.
    if (song.youtubeVideoId && youtubePlaybackEnabled()) {
      return {
        source: 'YOUTUBE',
        youtubeVideoId: song.youtubeVideoId,
        previewUrl: song.spotifyPreviewUrl ?? undefined,
        song: songInfo,
      };
    }

    // Tier 3: Spotify 30s preview
    if (song.spotifyPreviewUrl) {
      return { source: 'SPOTIFY_PREVIEW', previewUrl: song.spotifyPreviewUrl, song: songInfo };
    }

    return { source: 'NONE', song: songInfo };
  }

  /**
   * Parse an ISO-8601 duration into whole seconds, or `null` when the value is
   * absent/unparseable.
   *
   * Returning `0` for garbage was a silent-corruption bug: `0` is a *valid*
   * duration, so an unsupported format was indistinguishable from a genuine
   * zero-length video and got persisted into `Song.durationMs` — where it then
   * displayed as a broken `0:00` track. `null` is the honest "unknown" signal and
   * the caller now logs it.
   *
   * The previous regex was unanchored and all-optional, so it accepted a bare
   * `PT` (→ 0) and happily matched a valid-looking substring inside garbage
   * (`"xxPT2Hxx"` → 7200). This one is anchored, requires at least one component,
   * supports the day component YouTube actually emits (`P1DT2H3M4S`) and
   * fractional seconds, and rejects anything with trailing junk.
   */
  private parseISO8601Duration(iso?: string | null): number | null {
    if (!iso) return null;

    const ISO_8601_DURATION =
      /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

    const match = ISO_8601_DURATION.exec(iso.trim());
    if (!match) return null;

    const [, days, hours, minutes, seconds] = match;
    // "P" and "PT" alone match the grammar but carry no duration.
    if (!days && !hours && !minutes && !seconds) return null;

    return (
      Math.round(
        Number(days ?? 0) * 86400 +
          Number(hours ?? 0) * 3600 +
          Number(minutes ?? 0) * 60 +
          Number(seconds ?? 0),
      ) || 0
    );
  }
}

export const youtubeService = new YouTubeService();
