import { logger } from '../../lib/logger';
import { logAICall } from '../translationService';
import type { LyricsProvider, LyricsSearchResult } from './lyricsProvider';

const GENIUS_API_BASE = 'https://api.genius.com';
const REQUEST_TIMEOUT_MS = 4500;

interface GeniusSearchHit {
  result: {
    id: number;
    title: string;
    primary_artist: {
      id: number;
      name: string;
    };
    url: string;
  };
}

interface GeniusSearchResponse {
  response?: {
    hits?: GeniusSearchHit[];
  };
}

interface GeniusSongResponse {
  response?: {
    song?: {
      id: number;
      title: string;
      primary_artist: {
        id: number;
        name: string;
      };
      url: string;
      recording_location?: string;
      release_date_for_display?: string;
    };
  };
}

interface GeniusLyricsResponse {
  response?: {
    lyrics?: {
      body?: {
        html?: string;
        plain?: string;
      };
    };
  };
}

export class GeniusProvider implements LyricsProvider {
  public readonly name = 'genius';

  constructor(private readonly songId?: string) {}

  private getAccessToken(): string {
    const token = process.env.GENIUS_ACCESS_TOKEN || process.env.GENIUS_API_KEY;
    if (!token) {
      throw new Error('GENIUS_ACCESS_TOKEN is not configured');
    }
    return token;
  }

  private async callApi<T>(path: string, params?: Record<string, string>): Promise<T> {
    const token = this.getAccessToken();

    const search = new URLSearchParams(params);
    const url = `${GENIUS_API_BASE}${path}${search.toString() ? '?' + search.toString() : ''}`;
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'AfroGenie/1.0',
        },
      });
    } catch (error) {
      const responseTimeMs = Date.now() - startedAt;
      logger.error(
        { provider: 'GENIUS', endpoint: path, statusCode: null, responseTimeMs, err: error },
        'Genius API call failed',
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
      { provider: 'GENIUS', endpoint: path, statusCode, responseTimeMs },
      'Genius API call completed',
    );

    await logAICall({
      provider: 'GENIUS',
      model: `api:${path}`,
      promptVersion: `v1:status:${statusCode}:rt:${responseTimeMs}`,
      tokensInput: 0,
      tokensOutput: 0,
      estimatedCostUsd: 0,
      songId: this.songId,
    });

    if (!response.ok || statusCode >= 400) {
      throw new Error(`Genius API error at ${path}: status ${statusCode}`);
    }

    return payload as T;
  }

  async search(artist: string, title: string): Promise<LyricsSearchResult[] | null> {
    const data = await this.callApi<GeniusSearchResponse>('/search', {
      q: `${artist} ${title}`,
    });

    const hits = data?.response?.hits;
    if (!hits || hits.length === 0) {
      return null;
    }

    const mapped = hits.map((hit) => ({
      trackId: String(hit.result.id),
      title: hit.result.title,
      artist: hit.result.primary_artist.name,
    }));

    return mapped.length > 0 ? mapped : null;
  }

  async fetchLyrics(trackId: string): Promise<string | null> {
    // Genius API /songs/:id returns song metadata, not lyrics
    // Use the internal lyrics endpoint that powers Genius embeds
    try {
      const songData = await this.callApi<GeniusSongResponse>(`/songs/${trackId}`);
      const songUrl = songData?.response?.song?.url;
      if (!songUrl) {
        return null;
      }

      // Fetch the song page and extract lyrics from the embedded JSON
      const pageResponse = await fetch(songUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AfroGenie/1.0)',
        },
      });

      if (!pageResponse.ok) {
        return null;
      }

      const html = await pageResponse.text();

      // Extract lyrics from the page's JSON-LD structured data or DOM
      // Genius embeds lyrics in a <div> with data-lyrics-container="true"
      const lyricsMatch = html.match(/data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/);
      if (lyricsMatch) {
        // Decode HTML entities and strip tags
        const decoded = lyricsMatch[1]
          .replace(/<br\s*\/?>/g, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, ' ')
          .trim();

        if (decoded) {
          return decoded;
        }
      }

      // Fallback: try to extract from window.__PRELOADED_STATE__
      const stateMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
      if (stateMatch) {
        try {
          const state = JSON.parse(stateMatch[1]);
          const lyrics = state?.songPage?.lyrics?.plain;
          if (lyrics) {
            return lyrics.trim();
          }
        } catch {
          // JSON parse failed, continue
        }
      }

      return null;
    } catch (error) {
      logger.error(
        { provider: 'GENIUS', trackId, err: error },
        'Genius lyrics fetch failed',
      );
      return null;
    }
  }
}
