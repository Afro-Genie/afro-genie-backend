import { logger } from '../../lib/logger';
import { logAICall } from '../translationService';
import type { LyricsProvider, LyricsSearchResult } from './lyricsProvider';

const BASE = 'https://lrclib.net/api';
const REQUEST_TIMEOUT_MS = 8000;

interface LrcLibTrack {
  id: number;
  name: string;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

export class LrcLibProvider implements LyricsProvider {
  public readonly name = 'lrclib';

  constructor(private readonly songId?: string) {}

  private async callApi<T>(path: string, params: Record<string, string>): Promise<T> {
    const search = new URLSearchParams(params);
    const url = `${BASE}${path}?${search.toString()}`;
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          'User-Agent': 'AfroGenie/1.0 (https://github.com/afro-genie)',
        },
      });
    } catch (error) {
      const responseTimeMs = Date.now() - startedAt;
      logger.error(
        { provider: 'LRCLIB', endpoint: path, statusCode: null, responseTimeMs, err: error },
        'LRCLIB API call failed',
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
      { provider: 'LRCLIB', endpoint: path, statusCode, responseTimeMs },
      'LRCLIB API call completed',
    );

    await logAICall({
      provider: 'LRCLIB',
      model: `api:${path}`,
      promptVersion: `v1:status:${statusCode}:rt:${responseTimeMs}`,
      tokensInput: 0,
      tokensOutput: 0,
      estimatedCostUsd: 0,
      songId: this.songId,
    });

    if (statusCode === 404) {
      return null as T;
    }

    if (!response.ok || statusCode >= 400) {
      throw new Error(`LRCLIB API error at ${path}: status ${statusCode}`);
    }

    return payload as T;
  }

  async search(artist: string, title: string): Promise<LyricsSearchResult[] | null> {
    const data = await this.callApi<LrcLibTrack[] | null>('/search', {
      artist_name: artist,
      track_name: title,
    });

    if (!data || !Array.isArray(data) || data.length === 0) {
      return null;
    }

    const mapped = data
      .filter((track) => !track.instrumental && (track.plainLyrics || track.syncedLyrics))
      .map((track) => ({
        trackId: String(track.id),
        title: track.trackName || track.name,
        artist: track.artistName,
      }));

    return mapped.length > 0 ? mapped : null;
  }

  async fetchLyrics(trackId: string): Promise<string | null> {
    const data = await this.callApi<LrcLibTrack | null>('/get', {
      id: trackId,
    });

    if (!data) {
      return null;
    }

    // Prefer synced lyrics (LRC format with timestamps), fall back to plain
    const lyrics = data.syncedLyrics || data.plainLyrics;
    return lyrics?.trim() ? lyrics : null;
  }

  /**
   * Fetch lyrics and return both plain text and synced (LRC) content.
   * Used by the enrichment job to store timestamp-based line arrays.
   */
  async fetchLyricsWithSync(trackId: string): Promise<{ plain: string | null; synced: string | null }> {
    const data = await this.callApi<LrcLibTrack | null>('/get', {
      id: trackId,
    });

    if (!data) {
      return { plain: null, synced: null };
    }

    return {
      plain: data.plainLyrics?.trim() || null,
      synced: data.syncedLyrics?.trim() || null,
    };
  }
}
