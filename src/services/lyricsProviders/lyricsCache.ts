import { redis } from '../../lib/redis';
import { logger } from '../../lib/logger';
import type { LyricsProvider, LyricsSearchResult } from './lyricsProvider';

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const CACHE_KEY_PREFIX = 'lyrics:';
const NEGATIVE_CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours for "not found" cache

interface CachedSearchResult {
  results: LyricsSearchResult[];
}

interface CachedLyrics {
  content: string;
}

function getSearchCacheKey(provider: string, artist: string, title: string): string {
  const normalized = `${artist.toLowerCase().trim()}::${title.toLowerCase().trim()}`;
  return `${CACHE_KEY_PREFIX}search:${provider}:${normalized}`;
}

function getLyricsCacheKey(provider: string, trackId: string): string {
  return `${CACHE_KEY_PREFIX}lyrics:${provider}:${trackId}`;
}

function getNegativeCacheKey(provider: string, artist: string, title: string): string {
  const normalized = `${artist.toLowerCase().trim()}::${title.toLowerCase().trim()}`;
  return `${CACHE_KEY_PREFIX}neg:${provider}:${normalized}`;
}

export async function cachedSearch(
  provider: LyricsProvider,
  artist: string,
  title: string,
): Promise<LyricsSearchResult[] | null> {
  const cacheKey = getSearchCacheKey(provider.name, artist, title);
  const negKey = getNegativeCacheKey(provider.name, artist, title);

  try {
    // Check negative cache first
    const negCached = await redis.get(negKey);
    if (negCached) {
      return null;
    }

    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed: CachedSearchResult = JSON.parse(cached);
      return parsed.results.length > 0 ? parsed.results : null;
    }
  } catch (err) {
    logger.warn({ err, provider: provider.name }, 'Lyrics search cache read failed');
  }

  // Cache miss — call the actual provider
  const results = await provider.search(artist, title);

  try {
    if (results && results.length > 0) {
      await redis.set(cacheKey, JSON.stringify({ results }), 'EX', CACHE_TTL_SECONDS);
    } else {
      // Cache negative result to avoid repeated API calls
      await redis.set(negKey, '1', 'EX', NEGATIVE_CACHE_TTL_SECONDS);
    }
  } catch (err) {
    logger.warn({ err, provider: provider.name }, 'Lyrics search cache write failed');
  }

  return results;
}

export async function cachedFetchLyrics(
  provider: LyricsProvider,
  trackId: string,
): Promise<string | null> {
  const cacheKey = getLyricsCacheKey(provider.name, trackId);

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      if (cached === '__EMPTY__') {
        return null;
      }
      const parsed: CachedLyrics = JSON.parse(cached);
      return parsed.content || null;
    }
  } catch (err) {
    logger.warn({ err, provider: provider.name }, 'Lyrics fetch cache read failed');
  }

  // Cache miss — call the actual provider
  const content = await provider.fetchLyrics(trackId);

  try {
    if (content) {
      await redis.set(cacheKey, JSON.stringify({ content }), 'EX', CACHE_TTL_SECONDS);
    } else {
      // Cache empty result to avoid repeated API calls
      await redis.set(cacheKey, '__EMPTY__', 'EX', NEGATIVE_CACHE_TTL_SECONDS);
    }
  } catch (err) {
    logger.warn({ err, provider: provider.name }, 'Lyrics fetch cache write failed');
  }

  return content;
}
