// ---------------------------------------------------------------------------
// Playback source cache (Stage 2 / 2.18).
//
// `GET /api/playback/:songId/source` caches its resolved tier in Redis for an
// hour. Anything that changes which tier a song resolves to MUST evict that
// entry, or players keep being handed the old answer for up to an hour.
//
// This used to be a copy-paste of the same three lines in three files
// (`routes/playback.ts`, `routes/admin/youtube.ts`, `jobs/libraryEnrichmentJob`),
// and the mutation sites that most needed it — audio upload, preview backfill
// and song edit — had none at all. The documented symptom was an artist
// uploading audio and the song still playing from Spotify for an hour.
//
// One helper, one key format, every writer uses it.
// ---------------------------------------------------------------------------

import { redis, scanKeys } from './redis';
import { logger } from './logger';

export const PLAYBACK_SOURCE_CACHE_PREFIX = 'playback:source:';

export const playbackSourceCacheKey = (songId: string): string =>
  `${PLAYBACK_SOURCE_CACHE_PREFIX}${songId}`;

/** Evict one song's cached source. Never throws — a failed eviction degrades to
 *  a stale read for at most the cache TTL, which is not worth failing a write
 *  or an enrichment run over. */
export async function invalidatePlaybackSourceCache(songId: string): Promise<void> {
  try {
    await redis.del(playbackSourceCacheKey(songId));
  } catch (err) {
    logger.warn({ err, songId }, 'Failed to invalidate playback source cache');
  }
}

/** Evict many songs' cached sources (batched so one song cannot fail the set). */
export async function invalidatePlaybackSourceCaches(songIds: string[]): Promise<void> {
  if (songIds.length === 0) return;
  try {
    await Promise.all(songIds.map((id) => invalidatePlaybackSourceCache(id)));
  } catch (err) {
    logger.warn({ err, count: songIds.length }, 'Failed to invalidate playback source caches');
  }
}

/**
 * Evict every cached playback source.
 *
 * Used after a bulk operation (a preview backfill re-pointing hundreds of songs
 * at new Spotify preview URLs) where per-song calls would mean hundreds of
 * round-trips. SCAN-based, never KEYS.
 */
export async function invalidateAllPlaybackSourceCaches(): Promise<void> {
  try {
    const keys = await scanKeys(`${PLAYBACK_SOURCE_CACHE_PREFIX}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.info({ count: keys.length }, 'Invalidated all cached playback sources');
    }
  } catch (err) {
    logger.warn({ err }, 'Bulk playback source invalidation failed — non-fatal');
  }
}

// ---------------------------------------------------------------------------
// Flag-aware cache entries (Phase 2.3).
//
// The 1h TTL is longer than the rollout decision it can outlive, and the cache key
// cannot see the flag, so a cached answer is otherwise served after the flag moves
// underneath it — in BOTH directions:
//
//   flag ON  → caches {source:'YOUTUBE'} → flip OFF → still serves YouTube for up
//              to an hour. The kill switch does not kill.
//   flag OFF → caches {source:'NONE'} → flip ON → still serves nothing for up
//              to an hour. The rollout cannot be resumed.
//
// Checking `source === 'YOUTUBE'` only fixes the first half: the entry flag-off
// *writes* is exactly the stale one in the second half. So the flag state is
// recorded in the entry and a mismatch is a miss, which makes the cache correct
// under either transition rather than under one of them.
//
// Unwrapped entries (written before this change) have no `flagPlaybackYoutube` and
// read as a miss, so a deploy heals them within one request instead of serving
// them for a full TTL.
// ---------------------------------------------------------------------------

/** Decode a cache entry, or null if it is absent, corrupt, or flag-stale. */
export const readPlaybackSourceCacheEntry = <T>(
  raw: string | null,
  flagPlaybackYoutube: boolean,
): T | null => {
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as { flagPlaybackYoutube?: unknown; value?: T };
    if (typeof entry?.flagPlaybackYoutube !== 'boolean' || entry.value === undefined) return null;
    if (entry.flagPlaybackYoutube !== flagPlaybackYoutube) return null;
    return entry.value;
  } catch {
    return null;
  }
};

/** Wrap a resolved source with the flag state it was computed under. */
export const packPlaybackSourceCacheEntry = <T>(value: T, flagPlaybackYoutube: boolean): string =>
  JSON.stringify({ flagPlaybackYoutube, value });
