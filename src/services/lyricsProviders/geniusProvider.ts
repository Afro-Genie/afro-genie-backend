import { logger } from '../../lib/logger';
import { logAICall } from '../translationService';
import type { LyricsProvider, LyricsSearchResult } from './lyricsProvider';

const GENIUS_API_BASE = 'https://api.genius.com';
const REQUEST_TIMEOUT_MS = 4500;

/**
 * Audit-log port (2.13).
 *
 * `logAICall` writes a row via Prisma (`prisma.aICallLog.create`). Hard-coding
 * that call made the provider's happy path un-testable without a database,
 * and the three HTML extractors below had zero runtime coverage (§15.5). The
 * logger is now constructed in and defaults to the real `logAICall`, so
 * production behaviour is unchanged — but tests can inject a no-op port and
 * exercise the extractors against fixture HTML with no DB and no network.
 */
export type AICallLogPort = (params: {
  provider: string;
  model: string;
  promptVersion: string;
  tokensInput: number;
  tokensOutput: number;
  estimatedCostUsd: number;
  songId?: string | null;
  userId?: string | null;
}) => Promise<void>;

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

  constructor(
    private readonly songId?: string,
    private readonly auditLog: AICallLogPort = logAICall,
  ) {}

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

    await this.auditLog({
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

      // Fetch the song page and extract lyrics from the embedded JSON.
      // Search + song metadata already come from the official Genius API
      // (`/search`, `/songs/:id`) — only the lyrics text needs the page. Ask
      // for compressed bodies (gzip cuts the 50-200KB page to ~20KB); fetch()
      // decompresses transparently.
      const pageResponse = await fetch(songUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AfroGenie/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!pageResponse.ok) {
        return null;
      }

      const html = await pageResponse.text();

      // Reject bot walls — but ONLY actual walls. Every genuine Genius page
      // embeds reCAPTCHA v3 config (`recaptcha_v3_site_key`,
      // `grecaptcha-badge`) and renders a footer "Sign In" link, so substring
      // checks for "captcha"/"Sign In" match ALL real pages and silently killed
      // the Genius lyrics path (confirmed against a live page 2026-09-29).
      // A real Cloudflare wall has a distinct <title> and no lyric markup.
      const pageTitle = html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '';
      const hasLyricMarkup = /data-lyrics-container="true"|Lyrics__Container|__PRELOADED_STATE__/.test(html);
      const isCloudflareWall = /just a moment|access denied|verify you are human/i.test(pageTitle);
      if (isCloudflareWall || (!hasLyricMarkup && /g-recaptcha|challenge-platform/.test(html))) {
        logger.warn({ provider: 'GENIUS', trackId }, 'Genius page returned a bot wall');
        return null;
      }

      return extractLyricsFromHtml(html);
    } catch (error) {
      logger.error(
        { provider: 'GENIUS', trackId, err: error },
        'Genius lyrics fetch failed',
      );
      return null;
    }
  }
}

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ', '&#x2F;': '/',
  '&apos;': "'", '&#x26;': '&', '&#x2D;': '-', '&#x2019;': '\u2019',
  '&#x2018;': '\u2018', '&#x201C;': '\u201C', '&#x201D;': '\u201D',
};

function decodeHtmlEntities(html: string): string {
  let result = html;
  for (const [entity, char] of Object.entries(HTML_ENTITY_MAP)) {
    result = result.replaceAll(entity, char);
  }
  return result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10))).trim();
}

function stripTags(html: string): string {
  return html.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '');
}

// ---------------------------------------------------------------------------
// HTML extractors (2.13)
//
// Pure, exported, and deliberately independent of the network and the audit
// log: fixture-HTML tests can call them directly with no DB and no fetch. The
// order here matches the way Genius markup has evolved: try the newest embed
// container first, fall back to the legacy container, then the embedded JSON.
// ---------------------------------------------------------------------------

/** Method 1 — current Genius embed: `<div data-lyrics-container="true">`. */
export function extractLyricsFromDataContainerHtml(html: string): string | null {
  const matches = [...html.matchAll(/data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g)];
  let best: string | null = null;
  for (const match of matches) {
    const decoded = decodeHtmlEntities(stripTags(match[1]));
    if (decoded && decoded.length > 40 && (!best || decoded.length > best.length)) {
      best = decoded;
    }
  }
  return best;
}

/** Method 2 — older Genius markup: `class="Lyrics__Container ..."`. */
export function extractLyricsFromLegacyContainerHtml(html: string): string | null {
  const matches = [...html.matchAll(/class="Lyrics__Container[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
  let best: string | null = null;
  for (const match of matches) {
    const decoded = decodeHtmlEntities(stripTags(match[1]));
    if (decoded && decoded.length > 40 && (!best || decoded.length > best.length)) {
      best = decoded;
    }
  }
  return best;
}

/** Method 3 — the `window.__PRELOADED_STATE__` JSON embedded by Genius. */
export function extractLyricsFromPreloadedState(html: string): string | null {
  const match = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (!match) return null;
  try {
    const state = JSON.parse(match[1]);
    const lyrics = state?.songPage?.lyrics?.plain;
    if (lyrics) return lyrics.trim();
  } catch {
    // JSON parse failed, continue
  }
  return null;
}

/** Tries the three extractors in markup-evolution order; first hit wins. */
export function extractLyricsFromHtml(html: string): string | null {
  return (
    extractLyricsFromDataContainerHtml(html) ??
    extractLyricsFromLegacyContainerHtml(html) ??
    extractLyricsFromPreloadedState(html)
  );
}
