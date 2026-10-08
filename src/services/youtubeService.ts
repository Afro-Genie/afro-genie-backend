import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { env } from '../lib/env';
import {
  selectBestCandidate,
  STRICT_THRESHOLDS,
  LOOSE_THRESHOLDS,
  type MatchCandidate,
  type Strictness,
  type ValidationThresholds,
  type CandidateSignals,
} from './youtubeMatchValidation';

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';

const SEARCH_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MATCH_DELAY_MS = 100; // politeness delay between YouTube calls
const DETAIL_BATCH_SIZE = 50; // videos.list accepts up to 50 ids per call

/**
 * Phase B — how many search results to pull and score.
 *
 * `maxResults` does not change the cost of a `search.list` call (it is billed
 * per call, not per result), so a wider window is free and gives validation more
 * to choose from. 8 is a deliberate compromise: enough that a correct video is
 * usually present even when the top hit is a remix, without dragging in
 * unrelated uploads that widen the operator review surface.
 */
const SEARCH_CANDIDATES = 8;

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

/** The Redis key prefix for cached matches. */
const MATCH_CACHE_PREFIX = 'youtube:match:v2';

/** Build the cache key for one (title, artist) pair. */
const toCacheKey = (songTitle: string, artistName: string): string =>
  `${MATCH_CACHE_PREFIX}:${songTitle.toLowerCase()}:${artistName.toLowerCase()}`;

/**
 * Phase B — the Redis key a resolved match is cached under.
 *
 * Exported so the backfill script and the tests can target the real key instead
 * of re-typing the format. The `v2` segment retires entries written before
 * candidate validation existed; those hold an unvalidated `items[0]` result,
 * and serving one would reintroduce the exact defect validation prevents.
 */
export const youtubeMatchCacheKey = (songTitle: string, artistName: string): string =>
  toCacheKey(songTitle, artistName);

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

/**
 * Phase C — one channel that may hold an artist's uploads.
 *
 * `subscriberCount` is the ranking signal, not the handle spelling: an artist's
 * name resolves to several real channels and only one of them is the label.
 */
export interface ResolvedChannel {
  handle: string;
  channelId: string | null;
  channelTitle: string | null;
  uploadsPlaylistId: string;
  subscriberCount: number;
  videoCount: number;
}

export type PlaybackSourceKind = 'AUDIO_URL' | 'YOUTUBE' | 'NONE';

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
  song?: {
    id: string;
    title: string;
    artist: string;
    coverImageUrl: string | null;
    durationMs: number | null;
  };
}

class YouTubeService {
  /**
   * Phase B — validation thresholds. Swapped at runtime by the backfill script
   * (`--strictness loose`) so coverage can be measured without a code change.
   * Defaults to strict; the shipping path never loosens it.
   */
  thresholds: ValidationThresholds = STRICT_THRESHOLDS;

  /**
   * Phase C — `channels.list` calls made by the most recent enumeration.
   *
   * The backfill script reports quota consumption, and a per-artist estimate was
   * wrong: resolving an artist costs one call PER HANDLE SPELLING (up to 6), not
   * one per artist, because a name resolves to several channels and stopping at
   * the first is unreliable. Exposed so the reported number is counted rather than
   * guessed.
   */
lastEnumerationChannelsListCalls = 0;

  /**
   * Phase C — `playlistItems.list` calls made by the most recent enumeration.
   *
   * One per 50 items, per channel walked. Reported rather than estimated so the
   * dry run's quota figure is the real one.
   */
  lastEnumerationPlaylistItemsCalls = 0;

  /** Apply the current thresholds and return the winning candidate. */
  private selectValidated(
    song: { title: string; artist: string; durationMs: number | null },
    candidates: MatchCandidate[],
  ): { match: MatchCandidate | null; signals: ReturnType<typeof selectBestCandidate>['signals'] } {
    return selectBestCandidate(song, candidates, this.thresholds);
  }

  private isConfigured(): boolean {
    return Boolean(env.YOUTUBE_API_KEY);
  }

  /**
   * Stage 6.1 — the outcome-preserving form of `searchMatch`.
   *
   * This is the primitive; `searchMatch()` is a thin wrapper over it so the
   * pre-existing callers keep their `YouTubeMatch | null` contract unchanged.
   *
   * Phase B: the catalog duration is now a parameter. It cannot be looked up
   * from here — only the caller holds the `Song` row — and it is the single
   * strongest signal available for separating a track from a remix of it.
   * Callers that do not have it pass `null`, which validation treats as
   * "unknown", not as a mismatch.
   */
  async lookupMatch(
    songTitle: string,
    artistName: string,
    catalogDurationMs: number | null = null,
  ): Promise<YouTubeLookupResult> {
    if (!this.isConfigured()) {
      logger.debug('YouTube search skipped — YOUTUBE_API_KEY is not configured');
      // Not a song-level failure: nothing was asked of YouTube at all.
      return { status: 'error', reason: 'not_configured', retryable: false };
    }

    // Phase B — see `youtubeMatchCacheKey`: versioned so pre-validation entries
    // (an unvalidated `items[0]`, e.g. the Soweto remix) are never served.
    const cacheKey = toCacheKey(songTitle, artistName);

    let cachedMatch: YouTubeMatch | null = null;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) cachedMatch = JSON.parse(cached) as YouTubeMatch;
    } catch (err) {
      logger.warn({ err }, 'YouTube cache read failed');
    }

    // A cached match is still validated on the way out. Validation is cheap,
    // pure, and it means a threshold change takes effect immediately instead of
    // waiting 30 days for stale entries to age out.
    if (cachedMatch) {
      const { match, signals } = this.selectValidated(
        { title: songTitle, artist: artistName, durationMs: catalogDurationMs },
        [this.toCandidate(cachedMatch)],
      );
      // `toCandidate` is a round-trip, so re-narrow rather than widening the
      // candidate type to tolerate an optional thumbnail.
      if (match) return { status: 'matched', match: this.toMatch(match) };
      logger.info(
        { songTitle, artistName, signals },
        'Cached YouTube match no longer passes validation - refetching',
      );
    }

    const query = `${songTitle} ${artistName} official audio`;
    let items: Array<{ id?: { videoId?: string }; snippet?: Record<string, any> }>;

    try {
      const res = await fetch(
        `${YOUTUBE_API}/search?part=snippet&q=${encodeURIComponent(query)}&type=video&videoCategoryId=10&maxResults=${SEARCH_CANDIDATES}&key=${env.YOUTUBE_API_KEY}`,
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
      const data = (await res.json()) as { items?: typeof items };
      items = data.items ?? [];
    } catch (err) {
      logger.warn({ err }, 'YouTube search request errored');
      return { status: 'error', reason: 'network', retryable: true };
    }

    const videoIds = items
      .map((i) => i.id?.videoId)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);

    // YouTube answered successfully but offered nothing. This is the one outcome
    // that is a statement about the song rather than about the request.
    if (videoIds.length === 0) return { status: 'no_match' };

    // One `videos.list` call covers every candidate (ids accepts up to 50), so
    // enriching all of them costs the same single unit as enriching `items[0]`
    // did. This is what buys duration + embeddable for the scoring step.
    const details = await this.fetchVideoDetails(videoIds);

    const candidates: MatchCandidate[] = items
      .filter((i) => typeof i.id?.videoId === 'string')
      .map((i) => {
        const videoId = i.id!.videoId!;
        const snippet = i.snippet ?? {};
        const thumbnails = (snippet.thumbnails ?? {}) as Record<string, { url?: string }>;
        const detail = details.get(videoId);
        return {
          videoId,
          title: (snippet.title ?? songTitle) as string,
          // Falls back to the artist we searched for, as before: a snippet with no
          // channelTitle still identifies *whose* catalog we are matching into.
          channelTitle: (snippet.channelTitle ?? artistName) as string,
          thumbnailUrl: thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null,
          durationSeconds: detail?.durationSeconds ?? null,
          embeddable: detail?.embeddable ?? null,
        } satisfies MatchCandidate;
      });

    const { match, signals } = this.selectValidated(
      { title: songTitle, artist: artistName, durationMs: catalogDurationMs },
      candidates,
    );

    if (!match) {
      // No candidate survived validation. This IS a statement about the song —
      // YouTube answered, and nothing it offered is the track — so it is the
      // only outcome that may advance `youtubeMatchAttempts`.
      logger.info(
        { songTitle, artistName, candidates: candidates.length, signals },
        'No YouTube candidate passed match validation',
      );
      return { status: 'no_match' };
    }

    const persisted = this.toMatch(match);

    try {
      await redis.set(cacheKey, JSON.stringify(persisted), 'EX', SEARCH_CACHE_TTL_SECONDS);
    } catch (err) {
      logger.warn({ err }, 'YouTube cache write failed');
    }

    return { status: 'matched', match: persisted };
  }

  /** Narrow a validation candidate back to the persisted `YouTubeMatch` shape. */
  private toMatch(candidate: MatchCandidate): YouTubeMatch {
    return {
      videoId: candidate.videoId,
      title: candidate.title,
      channelTitle: candidate.channelTitle,
      thumbnailUrl: candidate.thumbnailUrl ?? null,
      durationSeconds: candidate.durationSeconds ?? null,
    };
  }

  /**
   * Adapt a `YouTubeMatch` back into a validation candidate.
   *
   * `embeddable` is deliberately `null` rather than `true`: a cache hit has not
   * re-checked the field, and asserting `true` would silently skip the gate on
   * exactly the songs that were matched first.
   */
  private toCandidate(match: YouTubeMatch): MatchCandidate {
    return {
      videoId: match.videoId,
      title: match.title,
      channelTitle: match.channelTitle,
      durationSeconds: match.durationSeconds,
      embeddable: null,
      thumbnailUrl: match.thumbnailUrl,
    };
  }

  /**
   * Fetch duration + embeddability for up to 50 video ids in one call (1 unit).
   *
   * Never throws: a failed lookup degrades candidates to `durationSeconds: null`
   * and `embeddable: null`, which validation treats as "unknown" rather than as
   * a mismatch. Losing the check is recoverable; failing the whole match is not.
   */
  private async fetchVideoDetails(
    videoIds: string[],
  ): Promise<Map<string, { durationSeconds: number | null; embeddable: boolean | null }>> {
    const out = new Map<string, { durationSeconds: number | null; embeddable: boolean | null }>();
    for (const id of videoIds) out.set(id, { durationSeconds: null, embeddable: null });

    try {
      const res = await fetch(
        `${YOUTUBE_API}/videos?part=contentDetails,status&id=${videoIds.join(',')}&key=${env.YOUTUBE_API_KEY}`,
      );
      if (!res.ok) {
        logger.warn({ status: res.status, count: videoIds.length }, 'YouTube videos.list failed');
        return out;
      }
      const data = (await res.json()) as {
        items?: Array<{
          id: string;
          contentDetails?: { duration?: string };
          status?: { embeddable?: boolean };
        }>;
      };
      for (const item of data.items ?? []) {
        const rawDuration = item.contentDetails?.duration;
        const durationSeconds = this.parseISO8601Duration(rawDuration);
        if (durationSeconds === null && rawDuration) {
          // Signal, do not fabricate — see YouTubeMatch.durationSeconds.
          logger.warn(
            { videoId: item.id, duration: rawDuration },
            'Unparseable ISO-8601 duration from YouTube - durationSeconds left unknown',
          );
        }
        out.set(item.id, {
          durationSeconds,
          // `null` when the field is absent (older response shape), so validation
          // can distinguish "not checked" from "checked and false".
          embeddable: typeof item.status?.embeddable === 'boolean' ? item.status.embeddable : null,
        });
      }
    } catch (err) {
      logger.warn({ err, count: videoIds.length }, 'YouTube videos.list request errored');
    }

    return out;
  }

  /**
   * Phase B (Phase C's cheap path) — fetch duration + embeddability for an
   * already-known set of video ids.
   *
   * Exposed because the backfill script enumerates channel upload playlists
   * instead of searching, and `playlistItems.list` carries title and duration
   * but not `status.embeddable`. Without this the enumeration path could never
   * pass the embeddable gate and every candidate would land on
   * `needsEmbeddableCheck`. Batched at 50 ids per call: 1 unit per 50 songs.
   */
  async fetchCandidateDetails(
    videoIds: string[],
  ): Promise<Map<string, { durationSeconds: number | null; embeddable: boolean | null }>> {
    const out = new Map<string, { durationSeconds: number | null; embeddable: boolean | null }>();
    for (let i = 0; i < videoIds.length; i += DETAIL_BATCH_SIZE) {
      const chunk = videoIds.slice(i, i + DETAIL_BATCH_SIZE);
      for (const [id, detail] of await this.fetchVideoDetails(chunk)) {
        out.set(id, detail);
      }
    }
    return out;
  }

  /**
   * Handle spellings to try for an artist name.
   *
   * `forHandle` is an exact match against the channel's `@handle`, and handles
   * are chosen by whoever claimed them — they are not derivable from the artist's
   * display name. Measured against the live catalog:
   *
   *   "@Burna Boy"  -> 0 items (a space disqualifies the handle outright)
   *   "@BurnaBoy"   -> 1 item
   *   "@Omah Lay"   -> 0 items
   *   "@OmahLay"    -> 1 item
   *
   * Order carries no meaning — see `resolveArtistChannels`, which ranks by
   * evidence rather than taking the first hit.
   */
  private static handleCandidates(artistName: string): string[] {
    const bare = artistName.replace(/\s+/g, '');
    const underscored = artistName.replace(/\s+/g, '_');
    const unique = [...new Set([bare, underscored])];
    const candidates: string[] = [];
    for (const base of unique) {
      candidates.push(`@${base}`, `@${base}Music`, `@${base}VEVO`);
    }
    return candidates;
  }

  /**
   * Phase C — resolve an artist's plausible upload playlists.
   *
   * `channels.list` with `forHandle` is 1 unit per handle and returns the uploads
   * playlist id; walking that playlist is 1 unit per 50 videos and costs no
   * `search.list` quota at all. This is the cheap path that lets the catalog be
   * backfilled without a quota increase.
   *
   * `part=contentDetails` is required, not optional: the uploads playlist id
   * lives under `contentDetails.relatedPlaylists.uploads`, so requesting only
   * `snippet` returns a channel with no way to reach its uploads and this
   * silently yields `null` for every artist. (It did, on the first dry run.)
   *
   * WHY EVERY CANDIDATE IS PROBED, RATHER THAN STOPPING AT THE FIRST
   * ------------------------------------------------------------------
   * Taking the first handle that resolves is wrong, and measurably so. A name is
   * not a unique identifier, and the spellings disagree about who the artist is.
   * Measured on the live catalog:
   *
   *   @Asake        -> a French Fortnite streamer, 130 subs, 5 videos
   *   @AsakeMusic   -> ASAKE the singer, 2.18M subs, 153 uploads, 33/36 matched
   *
   *   @Wizkid       -> 87 subs, 10 videos, 0/24 matched
   *   @WizkidVEVO   -> 525K subs, 76 videos, 13/24 matched
   *
   *   @Rema         -> 401 subs, 0 videos
   *   @RemaMusic    -> 2 videos
   *
   * Stopping at the first hit therefore resolves most artists to a fan page, a
   * gamer with the same nickname, or an abandoned handle — and the backfill then
   * reports "no match" for songs that have an obvious official upload. Probing all
   * six spellings costs 6 units and fixes it.
   *
   * Returns every channel with an uploads playlist, ordered by likelihood so the
   * caller can walk them in order. `null` means no handle resolved, which is a
   * statement about the artist rather than an API failure.
   */
  private async resolveArtistChannels(artistName: string): Promise<ResolvedChannel[]> {
    type ChannelItem = {
      id?: string;
      snippet?: { title?: string; customUrl?: string };
      contentDetails?: { relatedPlaylists?: { uploads?: string } };
      statistics?: { subscriberCount?: string; videoCount?: string };
    };

    const found: ResolvedChannel[] = [];
    const seen = new Set<string>();

    const candidates = YouTubeService.handleCandidates(artistName);
    this.lastEnumerationChannelsListCalls = 0;

    for (const handle of candidates) {
      this.lastEnumerationChannelsListCalls += 1;
      let items: ChannelItem[] = [];
      try {
        const res = await fetch(
          `${YOUTUBE_API}/channels?part=snippet,contentDetails,statistics&forHandle=${encodeURIComponent(handle)}&key=${env.YOUTUBE_API_KEY}`,
        );
        if (!res.ok) {
          logger.warn({ status: res.status, artistName, handle }, 'YouTube channels.list failed');
          // A quota or auth failure will not be fixed by the next spelling.
          return found;
        }
        const data = (await res.json()) as { items?: ChannelItem[] };
        items = data.items ?? [];
      } catch (err) {
        logger.warn({ err, artistName, handle }, 'YouTube channels.list request errored');
        return found;
      }

      for (const item of items) {
        const uploads = item.contentDetails?.relatedPlaylists?.uploads;
        if (!uploads || seen.has(uploads)) continue;
        seen.add(uploads);
        found.push({
          handle,
          channelId: item.id ?? null,
          channelTitle: item.snippet?.title ?? null,
          uploadsPlaylistId: uploads,
          subscriberCount: Number(item.statistics?.subscriberCount ?? 0),
          videoCount: Number(item.statistics?.videoCount ?? 0),
        });
      }
    }

    // A channel with a large subscriber base and a long upload history is far
    // likelier to be the label's own. Sorting rather than trusting the first hit
    // is what stops "@Asake" (a gamer) from shadowing "@AsakeMusic" (the singer).
    found.sort((a, b) => b.subscriberCount - a.subscriberCount || b.videoCount - a.videoCount);

    logger.info(
      { artistName, channels: found.map((c) => ({ handle: c.handle, subs: c.subscriberCount, videos: c.videoCount })) },
      'Resolved candidate channels for artist',
    );
    return found;
  }

  /**
   * Phase C — list an artist's uploads as validation candidates.
   *
   * Walks every candidate channel, largest first, and returns the union. Stopping
   * at the first channel would be cheaper but wrong: the highest-subscriber
   * channel is not always the right one (see `resolveArtistChannels`), and a
   * catalog song may be on the official channel while its live cut is on VEVO.
   * Validation is what decides which candidate is acceptable, so handing it more
   * verified candidates is strictly better and costs a few `playlistItems.list`
   * units.
   *
   * Returns raw candidates (no `embeddable`, which `playlistItems.list` does not
   * carry); the caller pairs them with `fetchCandidateDetails()` and scores them.
   *
   * Costs ~1 unit per 50 items per channel. Songs are matched against ~332
   * artists, so the catalog-wide sweep is a few thousand shared-pool units and
   * zero search calls.
   */
  async listArtistUploads(
    artistName: string,
    maxItems = 200,
    maxChannels = 3,
  ): Promise<MatchCandidate[] | null> {
    if (!this.isConfigured()) return null;

    const channels = await this.resolveArtistChannels(artistName);
    if (channels.length === 0) {
      logger.info({ artistName }, 'No YouTube upload playlist for any candidate handle');
      return null;
    }

    const candidates: MatchCandidate[] = [];
    const seen = new Set<string>();
    this.lastEnumerationPlaylistItemsCalls = 0;

    for (const channel of channels.slice(0, maxChannels)) {
      let pageToken: string | undefined;
      let prevPageToken: string | undefined;
      const PAGE = 50;
      let fetched = 0;
      // Hard cap on page fetches, independent of `maxItems`. YouTube paging is
      // driven by the server's `nextPageToken`; if that ever repeats (a proxy
      // that rewrites the response, a stale cache, a bug), the `fetched < maxItems`
      // condition alone never terminates, because every repeated page dedupes to
      // zero new candidates. Unbounded, that spins until the process dies.
      const MAX_PAGES = Math.ceil(maxItems / PAGE) + 1;
      let pages = 0;

      while (fetched < maxItems && pages < MAX_PAGES) {
        pages += 1;
        const url =
          `${YOUTUBE_API}/playlistItems?part=snippet,contentDetails&playlistId=${channel.uploadsPlaylistId}` +
          `&maxResults=${PAGE}&key=${env.YOUTUBE_API_KEY}${pageToken ? `&pageToken=${pageToken}` : ''}`;

        let data: {
          items?: Array<{
            snippet?: { title?: string; channelTitle?: string; resourceId?: { videoId?: string } };
            contentDetails?: { videoDuration?: string };
          }>;
          nextPageToken?: string;
        };
        try {
          const res = await fetch(url);
          if (!res.ok) {
            logger.warn(
              { status: res.status, artistName, handle: channel.handle },
              'YouTube playlistItems.list failed',
            );
            break;
          }
          data = await res.json();
          this.lastEnumerationPlaylistItemsCalls += 1;
        } catch (err) {
          logger.warn({ err, artistName, handle: channel.handle }, 'YouTube playlistItems.list request errored');
          break;
        }

        for (const item of data.items ?? []) {
          const videoId = item.snippet?.resourceId?.videoId;
          // The same upload can appear on more than one channel (a VEVO mirror,
          // a Topic channel), so dedupe on the id rather than trusting the walk.
          if (!videoId || seen.has(videoId)) continue;
          seen.add(videoId);
          fetched++;
          candidates.push({
            videoId,
            title: item.snippet?.title ?? '',
            channelTitle: item.snippet?.channelTitle ?? channel.channelTitle ?? artistName,
            // Filled in by `fetchCandidateDetails`, which has `status`. Leaving
            // this null would skip the duration gate entirely.
            durationSeconds: null,
            embeddable: null,
          });
        }

        pageToken = data.nextPageToken;

        // A repeated token means the upstream is not advancing; stop rather than loop.
        if (pageToken && pageToken === prevPageToken) {
          logger.warn(
            { artistName, handle: channel.handle, pageToken },
            'playlistItems.nextPageToken repeated - stopping walk',
          );
          break;
        }
        prevPageToken = pageToken;
        if (!pageToken) break;
      }

      if (candidates.length >= maxItems) break;
    }

    return candidates.slice(0, maxItems);
  }

  /** Exposed for the backfill script, which scores candidates itself. */
  get validationThresholds(): ValidationThresholds {
    return this.thresholds;
  }

  setValidationThresholds(strictness: Strictness): void {
    this.thresholds = strictness === 'loose' ? LOOSE_THRESHOLDS : STRICT_THRESHOLDS;
  }

  /** Search YouTube for the best match for a song title + artist. */
  async searchMatch(
    songTitle: string,
    artistName: string,
    catalogDurationMs: number | null = null,
  ): Promise<YouTubeMatch | null> {
    const result = await this.lookupMatch(songTitle, artistName, catalogDurationMs);
    return result.status === 'matched' ? result.match : null;
  }

  /**
   * Phase C — search for an artist's catalogue and return ONE pooled candidate
   * list for every song by that artist.
   *
   * Why this exists, given `lookupMatch()` already searches
   * ----------------------------------------------------
   * `search.list` costs 100 units, by far the most expensive call in this file
   * (`videos.list` and `playlistItems.list` are 1). `lookupMatch()` spends one
   * search PER SONG and returns only `SEARCH_CANDIDATES` videos, so for an
   * artist with 20 unmatched songs the old path cost 2,000 units to consider 160
   * videos, most of them repeats of the same handful of official uploads.
   *
   * Pooling amortises the cost over the artist: one 100-unit search returning up
   * to 50 videos answers for all of their songs, and every song then competes
   * against the same pool, which is strictly more evidence than an 8-item
   * per-song window. For the 136 artists Phase 1 left unmatched this is ~13,600
   * units instead of ~31,000, and it is the difference between finishing inside a
   * normal daily quota and not.
   *
   * Returns `null` (not `[]`) when the search itself failed, so the caller can
   * tell "YouTube is unreachable" from "this artist has nothing on YouTube".
   */
  async searchArtistPool(
    artistName: string,
    maxResults = 50,
  ): Promise<MatchCandidate[] | null> {
    if (!this.isConfigured()) return null;

    const url =
      `${YOUTUBE_API}/search?part=snippet&q=${encodeURIComponent(`${artistName} official audio`)}` +
      `&type=video&videoCategoryId=10&maxResults=${Math.min(maxResults, 50)}&key=${env.YOUTUBE_API_KEY}`;

    let items: Array<{ id?: { videoId?: string }; snippet?: Record<string, any> }>;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        logger.warn({ status: res.status, artistName }, 'YouTube artist search failed');
        return null;
      }
      const data = (await res.json()) as { items?: typeof items };
      items = data.items ?? [];
    } catch (err) {
      logger.warn({ err, artistName }, 'YouTube artist search request errored');
      return null;
    }

    const videoIds = items
      .map((i) => i.id?.videoId)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (videoIds.length === 0) return [];

    const details = await this.fetchVideoDetails(videoIds.slice(0, 50));

    return items
      .filter((i) => typeof i.id?.videoId === 'string')
      .map((i) => {
        const videoId = i.id!.videoId!;
        const snippet = i.snippet ?? {};
        const thumbnails = (snippet.thumbnails ?? {}) as Record<string, { url?: string }>;
        const detail = details.get(videoId);
        return {
          videoId,
          title: (snippet.title ?? '') as string,
          channelTitle: (snippet.channelTitle ?? artistName) as string,
          thumbnailUrl: thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null,
          durationSeconds: detail?.durationSeconds ?? null,
          embeddable: detail?.embeddable ?? null,
        } satisfies MatchCandidate;
      });
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
        const result = await this.lookupMatch(
          song.title,
          song.artist.name,
          song.durationMs,
        );
        if (result.status === 'matched') {
          await prisma.song.update({
            where: { id: song.id },
            data: {
              youtubeVideoId: result.match.videoId,
              youtubeMatchedAt: new Date(),
              youtubeMatchAttempts: 0,
              // Phase B — persist the verified duration. `null` when YouTube
              // returned an unparseable ISO-8601 string; it is written as null
              // rather than 0 so "unknown" stays distinct from a zero-length
              // track (2.21), and an existing value is left alone rather than
              // being clobbered by a missing measurement.
              ...(result.match.durationSeconds !== null && { durationMs: result.match.durationSeconds * 1000 }),
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

    const result = await this.lookupMatch(song.title, song.artist.name, song.durationMs);
    if (result.status !== 'matched') return null;

    await prisma.song.update({
      where: { id: song.id },
      // Stage 6.1 — an operator-forced match clears any accumulated failures.
      data: {
        youtubeVideoId: result.match.videoId,
        youtubeMatchedAt: new Date(),
        youtubeMatchAttempts: 0,
        // Phase B — same null-preserving duration write as batchMatchSongs.
        ...(result.match.durationSeconds !== null && {
          durationMs: result.match.durationSeconds * 1000,
        }),
      },
    });
    return result.match;
  }

  /**
   * Resolve the best available playback source for a song: own uploaded audio →
   * matched YouTube video → none. The Spotify 30s preview tier was removed in
   * Phase 3, so a song with no audio of its own and a gated/absent YouTube match
   * resolves to NONE rather than degrading.
   *
   * Two guards live here, both closing a production-defect lever:
   *
   *  - `FLAG_PLAYBACK_YOUTUBE` is the kill switch (2.15). When it is off the
   *    YouTube tier is skipped entirely and the caller falls through to no
   *    source, i.e. the pre-YouTube behaviour. This is what makes a bad
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

    // Tier 2: matched YouTube video. Gated on the rollout flag: with the flag
    // off this tier does not exist and the resolver returns NONE.
    if (song.youtubeVideoId && youtubePlaybackEnabled()) {
      return {
        source: 'YOUTUBE',
        youtubeVideoId: song.youtubeVideoId,
        song: songInfo,
      };
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
