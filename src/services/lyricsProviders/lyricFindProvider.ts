import { logger } from '../../lib/logger';
import { logAICall } from '../translationService';
import type { LyricsProvider, LyricsSearchResult } from './lyricsProvider';

const BASE = 'https://api.lyricfind.com';
const REQUEST_TIMEOUT_MS = 4500;

interface LyricFindTrack {
  track_id: string;
  track_title: string;
  artist_name: string;
}

interface LyricFindSearchResponse {
  response?: {
    track?: LyricFindTrack[];
  };
}

interface LyricFindLyricsResponse {
  response?: {
    track?: {
      track_id: string;
      lyrics?: string;
    };
  };
}

export class LyricFindProvider implements LyricsProvider {
  public readonly name = 'lyricfind';

  constructor(private readonly songId?: string) {}

  private getApiKey(): string {
    const key = process.env.LYRICFIND_API_KEY;
    if (!key) {
      throw new Error('LYRICFIND_API_KEY is not configured');
    }
    return key;
  }

  private getUsername(): string {
    return process.env.LYRICFIND_USERNAME || 'afrogenie';
  }

  private async callApi<T>(path: string, params: Record<string, string>): Promise<T> {
    const apiKey = this.getApiKey();
    const username = this.getUsername();

    const search = new URLSearchParams({
      ...params,
      apikey: apiKey,
      username,
      output: 'json',
    });

    const url = `${BASE}${path}?${search.toString()}`;
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'User-Agent': 'AfroGenie/1.0' },
      });
    } catch (error) {
      const responseTimeMs = Date.now() - startedAt;
      logger.error(
        { provider: 'LYRICFIND', endpoint: path, statusCode: null, responseTimeMs, err: error },
        'LyricFind API call failed',
      );
      throw error;
    }

    const responseTimeMs = Date.now() - startedAt;
    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const statusCode = response.status;

    logger.info(
      { provider: 'LYRICFIND', endpoint: path, statusCode, responseTimeMs },
      'LyricFind API call completed',
    );

    await logAICall({
      provider: 'LYRICFIND',
      model: `api:${path}`,
      promptVersion: `v1:status:${statusCode}:rt:${responseTimeMs}`,
      tokensInput: 0,
      tokensOutput: 0,
      estimatedCostUsd: 0,
      songId: this.songId,
    });

    if (!response.ok || statusCode >= 400) {
      throw new Error(`LyricFind API error at ${path}: status ${statusCode}`);
    }

    return payload as T;
  }

  async search(artist: string, title: string): Promise<LyricsSearchResult[] | null> {
    const data = await this.callApi<LyricFindSearchResponse>('/search', {
      q: `${artist} ${title}`,
    });

    const tracks = data?.response?.track;
    if (!tracks || tracks.length === 0) {
      return null;
    }

    const mapped = tracks.map((track) => ({
      trackId: track.track_id,
      title: track.track_title,
      artist: track.artist_name,
    }));

    return mapped.length > 0 ? mapped : null;
  }

  async fetchLyrics(trackId: string): Promise<string | null> {
    const data = await this.callApi<LyricFindLyricsResponse>('/lyric', {
      track_id: trackId,
    });

    const lyrics = data?.response?.track?.lyrics;
    return lyrics?.trim() ? lyrics : null;
  }
}
