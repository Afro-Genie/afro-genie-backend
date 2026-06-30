import { logger } from '../../lib/logger';
import { redis } from '../../lib/redis';
import type { LyricsProvider, LyricsSearchResult } from './lyricsProvider';

const BASE = 'https://api.musixmatch.com/ws/1.1/';
const KEY = process.env.MUSICMATCH_API_KEY;
const DAILY_REQUEST_LIMIT = 2000;
const RATE_LIMIT_WINDOW_SECONDS = 86400;
const REQUEST_TIMEOUT_MS = 4500;

interface MusixmatchTrack {
  track_id: number;
  track_name: string;
  artist_name: string;
}

interface MusixmatchResponse<TBody> {
  message?: {
    header?: {
      status_code?: number;
    };
    body?: TBody;
  };
}

interface TrackSearchBody {
  track_list?: Array<{
    track?: MusixmatchTrack;
  }>;
}

interface TrackLyricsBody {
  lyrics?: {
    lyrics_body?: string | null;
  };
}

export class MusicMatchRateLimitError extends Error {
  public readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('MusicMatch daily rate limit reached');
    this.name = 'MusicMatchRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class MusicMatchProvider implements LyricsProvider {
  public readonly name = 'musicmatch';

  private getDailyKey(): string {
    const today = new Date().toISOString().slice(0, 10);
    return `musicmatch:requests:${today}`;
  }

  private getRetryAfterMs(): number {
    const now = new Date();
    const nextDayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return Math.max(1000, nextDayUtc - now.getTime() + 1000);
  }

  private async reserveRateLimitSlot(): Promise<void> {
    const key = this.getDailyKey();
    const count = await redis.incr(key);
    await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);

    if (count > DAILY_REQUEST_LIMIT) {
      throw new MusicMatchRateLimitError(this.getRetryAfterMs());
    }
  }

  private async callApi<TBody>(endpoint: string, params: Record<string, string>): Promise<TBody> {
    if (!KEY) {
      throw new Error('MUSICMATCH_API_KEY is not configured');
    }

    await this.reserveRateLimitSlot();

    const search = new URLSearchParams({
      ...params,
      apikey: KEY,
    });

    const url = `${BASE}${endpoint}?${search.toString()}`;
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      const responseTimeMs = Date.now() - startedAt;
      logger.error(
        { provider: 'MUSICMATCH', endpoint, statusCode: null, responseTimeMs, err: error },
        'MusicMatch API call failed',
      );
      throw error;
    }

    const responseTimeMs = Date.now() - startedAt;

    let payload: MusixmatchResponse<TBody> | null = null;
    try {
      payload = (await response.json()) as MusixmatchResponse<TBody>;
    } catch {
      payload = null;
    }

    const statusCode = payload?.message?.header?.status_code ?? response.status;

    logger.info(
      { provider: 'MUSICMATCH', endpoint, statusCode, responseTimeMs },
      'MusicMatch API call completed',
    );

    if (!response.ok || statusCode >= 400) {
      throw new Error(`MusicMatch API error at ${endpoint}: status ${statusCode}`);
    }

    return (payload?.message?.body ?? null) as TBody;
  }

  async search(artist: string, title: string): Promise<LyricsSearchResult[] | null> {
    const body = await this.callApi<TrackSearchBody>('track.search', {
      q_track: title,
      q_artist: artist,
      page_size: '3',
    });

    const tracks = body?.track_list ?? [];
    if (tracks.length === 0) {
      return null;
    }

    const mapped = tracks
      .map((item) => item.track)
      .filter((track): track is MusixmatchTrack => Boolean(track))
      .map((track) => ({
        trackId: String(track.track_id),
        title: track.track_name,
        artist: track.artist_name,
      }));

    return mapped.length > 0 ? mapped : null;
  }

  async fetchLyrics(trackId: string): Promise<string | null> {
    const body = await this.callApi<TrackLyricsBody>('track.lyrics.get', {
      track_id: trackId,
    });

    const lyricsBody = body?.lyrics?.lyrics_body;
    return lyricsBody?.trim() ? lyricsBody : null;
  }
}
