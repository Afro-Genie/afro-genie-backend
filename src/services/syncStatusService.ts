// ---------------------------------------------------------------------------
// Non-Spotify survivors of the former `services/syncEngine.ts` (Phase 4).
//
// The Spotify catalog pipeline was removed; these are the parts that must live
// on: the Last.fm/missing-lyrics backfill jobs, and the admin sync dashboard /
// status endpoints. The `sync:lastSync:*` / `sync:duration:*` Redis keys they
// read keep their old names so any in-flight dashboard data survives the move.
// ---------------------------------------------------------------------------

import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { fetchLastFmArtist } from './lastfmService';
import { lyricsEnrichmentQueue } from '../lib/queue';

const LAST_SYNC_KEY_PREFIX = 'sync:lastSync:';
const SYNC_DURATION_KEY_PREFIX = 'sync:duration:';
const SYNC_STATS_KEY = 'sync:stats';

interface SyncStatus {
  lastSync: Record<string, string | null>;
  staleCount: number;
  genres: { synced: boolean; lastSync: string | null };
}

export interface SyncDashboard {
  totalArtists: number;
  artistsWithSpotify: number;
  staleCount: number;
  staleThresholdHours: number;
  lastSync: {
    syncAll: string | null;
    refreshStale: string | null;
    syncGenres: string | null;
    popularTracks: string | null;
  };
  lastSyncDuration: {
    syncAll: number | null;
    refreshStale: number | null;
    popularTracks: number | null;
  };
  queueDepth: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  };
  recentStats: {
    totalSynced: number;
    totalFailed: number;
    lastRunAt: string | null;
  };
  popularTracksStats: {
    lastSync: string | null;
    durationMs: number | null;
  };
}

function getStaleThresholdMs(): number {
  return env.SYNC_STALE_THRESHOLD_HOURS * 60 * 60 * 1000;
}

const setLastSyncTimestamp = async (key: string): Promise<void> => {
  try {
    await redis.set(`${LAST_SYNC_KEY_PREFIX}${key}`, new Date().toISOString(), 'EX', 60 * 60 * 24 * 7);
  } catch {
    // Non-fatal when cache is unavailable.
  }
};

const getLastSyncTimestamp = async (key: string): Promise<string | null> => {
  try {
    return await redis.get(`${LAST_SYNC_KEY_PREFIX}${key}`);
  } catch {
    return null;
  }
};

const recordSyncDuration = async (key: string, durationMs: number): Promise<void> => {
  try {
    await redis.set(`${SYNC_DURATION_KEY_PREFIX}${key}`, String(durationMs), 'EX', 60 * 60 * 24 * 7);
  } catch {
    // Non-fatal
  }
};

const getSyncDuration = async (key: string): Promise<number | null> => {
  try {
    const val = await redis.get(`${SYNC_DURATION_KEY_PREFIX}${key}`);
    return val ? parseInt(val, 10) : null;
  } catch {
    return null;
  }
};

const recordSyncStats = async (synced: number, failed: number): Promise<void> => {
  try {
    await redis.set(
      SYNC_STATS_KEY,
      JSON.stringify({ synced, failed, lastRunAt: new Date().toISOString() }),
      'EX',
      60 * 60 * 24 * 7,
    );
  } catch {
    // Non-fatal
  }
};

const getSyncStats = async (): Promise<{ totalSynced: number; totalFailed: number; lastRunAt: string | null }> => {
  try {
    const raw = await redis.get(SYNC_STATS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // Non-fatal
  }
  return { totalSynced: 0, totalFailed: 0, lastRunAt: null };
};

export const enrichArtistLastFm = async (artistId: string): Promise<{ updated: boolean }> => {
  try {
    const artist = await prisma.artist.findUnique({
      where: { id: artistId },
      select: { id: true, name: true, popularity: true, followers: true, bio: true, genres: true, imageUrl: true },
    });
    if (!artist) return { updated: false };

    const lastfmData = await fetchLastFmArtist(artist.name);
    if (!lastfmData) return { updated: false };

    const updateData: Record<string, unknown> = {};
    if (lastfmData.listeners > 0 && artist.popularity === 0) updateData.popularity = lastfmData.listeners;
    if (lastfmData.playcount > 0 && artist.followers === 0) updateData.followers = lastfmData.playcount;
    if (lastfmData.bio && !artist.bio) updateData.bio = lastfmData.bio;
    if (lastfmData.imageUrl && !artist.imageUrl) updateData.imageUrl = lastfmData.imageUrl;
    if (lastfmData.tags.length > 0 && (!artist.genres || artist.genres.length === 0)) updateData.genres = lastfmData.tags;

    if (Object.keys(updateData).length === 0) return { updated: false };

    await prisma.artist.update({ where: { id: artistId }, data: updateData });
    return { updated: true };
  } catch {
    return { updated: false };
  }
};

// ---------------------------------------------------------------------------
// Backfill lyrics — enqueue enrichment jobs for songs missing lyrics
// ---------------------------------------------------------------------------
export const backfillMissingLyrics = async (
  onProgress?: (completed: number, total: number) => void
): Promise<{ enqueued: number }> => {
  // Find songs with NO lyric record at all
  const songsWithNoLyricRow = await prisma.song.findMany({
    where: {
      softDeleted: false,
      spotifyId: { not: null },
      lyrics: { none: {} },
    },
    select: { id: true, title: true },
    orderBy: { createdAt: 'asc' },
  });

  // Find songs with a lyric record but NULL content (from failed enrichment attempts)
  const songsWithEmptyLyrics = await prisma.song.findMany({
    where: {
      softDeleted: false,
      spotifyId: { not: null },
      lyrics: {
        some: {
          content: null,
        },
      },
    },
    select: { id: true, title: true },
    orderBy: { createdAt: 'asc' },
  });

  // Merge and deduplicate
  const songMap = new Map<string, { id: string; title: string }>();
  for (const s of songsWithNoLyricRow) songMap.set(s.id, s);
  for (const s of songsWithEmptyLyrics) songMap.set(s.id, s);
  const songs = [...songMap.values()];

  if (songs.length === 0) {
    logger.info('[backfillMissingLyrics] No songs missing lyrics');
    return { enqueued: 0 };
  }

  logger.info(
    {
      noLyricRow: songsWithNoLyricRow.length,
      emptyLyricRow: songsWithEmptyLyrics.length,
      totalUnique: songs.length,
    },
    '[backfillMissingLyrics] Enqueuing lyrics enrichment jobs'
  );

  for (let i = 0; i < songs.length; i++) {
    await lyricsEnrichmentQueue.add(
      'enrichLyrics',
      { songId: songs[i].id },
      {
        jobId: `lyrics-enrichment-backfill-${songs[i].id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 500,
      },
    );
    onProgress?.(i + 1, songs.length);
  }

  await setLastSyncTimestamp('backfillLyrics');
  logger.info({ enqueued: songs.length }, '[backfillMissingLyrics] Completed');
  return { enqueued: songs.length };
};

// ---------------------------------------------------------------------------
// Backfill artist metadata from Last.fm — bio, popularity, followers, genres
// ---------------------------------------------------------------------------
export const backfillArtistLastFm = async (
  onProgress?: (completed: number, total: number) => void
): Promise<{ updated: number; skipped: number }> => {
  const artists = await prisma.artist.findMany({
    where: {
      softDeleted: false,
      spotifyId: { not: null },
      OR: [
        { popularity: 0 },
        { followers: 0 },
        { bio: null },
      ],
    },
    select: { id: true, name: true, popularity: true, followers: true, bio: true, genres: true, imageUrl: true },
    orderBy: { updatedAt: 'asc' },
  });

  if (artists.length === 0) {
    logger.info('[backfillArtistLastFm] No artists needing LastFM enrichment');
    await setLastSyncTimestamp('backfillArtistLastFm');
    return { updated: 0, skipped: 0 };
  }

  logger.info({ count: artists.length }, '[backfillArtistLastFm] Starting LastFM enrichment');

  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < artists.length; i++) {
    const artist = artists[i];
    try {
      const lastfmData = await fetchLastFmArtist(artist.name);

      if (!lastfmData) {
        skipped++;
        onProgress?.(i + 1, artists.length);
        if (i < artists.length - 1) await new Promise((r) => setTimeout(r, 250));
        continue;
      }

      const updateData: Record<string, unknown> = {};
      if (lastfmData.listeners > 0 && artist.popularity === 0) updateData.popularity = lastfmData.listeners;
      if (lastfmData.playcount > 0 && artist.followers === 0) updateData.followers = lastfmData.playcount;
      if (lastfmData.bio && !artist.bio) updateData.bio = lastfmData.bio;
      if (lastfmData.imageUrl && !artist.imageUrl) updateData.imageUrl = lastfmData.imageUrl;
      if (lastfmData.tags.length > 0 && (!artist.genres || artist.genres.length === 0)) updateData.genres = lastfmData.tags;

      if (Object.keys(updateData).length > 0) {
        await prisma.artist.update({
          where: { id: artist.id },
          data: updateData,
        });
        updated++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }

    onProgress?.(i + 1, artists.length);
    if (i < artists.length - 1) await new Promise((r) => setTimeout(r, 250));
  }

  await setLastSyncTimestamp('backfillArtistLastFm');
  logger.info({ updated, skipped, total: artists.length }, '[backfillArtistLastFm] Completed');
  return { updated, skipped };
};

// ---------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------
export const getSyncDashboard = async (): Promise<SyncDashboard> => {
  const staleThresholdMs = getStaleThresholdMs();

  const [
    totalArtists,
    artistsWithSpotify,
    staleCount,
    lastSyncAll,
    lastRefreshStale,
    lastSyncGenres,
    lastSyncPopularTracks,
    durationSyncAll,
    durationRefreshStale,
    durationPopularTracks,
    syncStats,
  ] = await Promise.all([
    prisma.artist.count({ where: { softDeleted: false } }),
    prisma.artist.count({ where: { softDeleted: false, spotifyId: { not: null } } }),
    prisma.artist.count({
      where: {
        softDeleted: false,
        spotifyId: { not: null },
        updatedAt: { lt: new Date(Date.now() - staleThresholdMs) },
      },
    }),
    getLastSyncTimestamp('syncAll'),
    getLastSyncTimestamp('refreshStale'),
    getLastSyncTimestamp('syncGenres'),
    getLastSyncTimestamp('popularTracks'),
    getSyncDuration('syncAll'),
    getSyncDuration('refreshStale'),
    getSyncDuration('popularTracks'),
    getSyncStats(),
  ]);

  // Queue depth from BullMQ
  let queueDepth = { waiting: 0, active: 0, completed: 0, failed: 0 };
  try {
    const { syncQueue } = await import('../lib/queue.js');
    const counts = await syncQueue.getJobCounts('waiting', 'active', 'completed', 'failed');
    queueDepth = {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
    };
  } catch {
    // Queue may be unavailable in test/disabled-redis mode
  }

  return {
    totalArtists,
    artistsWithSpotify,
    staleCount,
    staleThresholdHours: env.SYNC_STALE_THRESHOLD_HOURS,
    lastSync: {
      syncAll: lastSyncAll,
      refreshStale: lastRefreshStale,
      syncGenres: lastSyncGenres,
      popularTracks: lastSyncPopularTracks,
    },
    lastSyncDuration: {
      syncAll: durationSyncAll,
      refreshStale: durationRefreshStale,
      popularTracks: durationPopularTracks,
    },
    queueDepth,
    recentStats: syncStats,
    popularTracksStats: {
      lastSync: lastSyncPopularTracks,
      durationMs: durationPopularTracks,
    },
  };
};

// ---------------------------------------------------------------------------
// Legacy status endpoint
// ---------------------------------------------------------------------------
export const getLastSyncStatus = async (): Promise<SyncStatus> => {
  const staleThresholdMs = getStaleThresholdMs();

  const [lastSyncArtists, lastSyncAlbums, staleArtists] = await Promise.all([
    getLastSyncTimestamp('syncAll'),
    getLastSyncTimestamp('refreshStale'),
    prisma.artist.count({
      where: {
        softDeleted: false,
        spotifyId: { not: null },
        updatedAt: { lt: new Date(Date.now() - staleThresholdMs) },
      },
    }),
  ]);

  return {
    lastSync: {
      artists: lastSyncArtists,
      albums: lastSyncAlbums,
    },
    staleCount: staleArtists,
    genres: {
      synced: (await prisma.genre.count()) > 0,
      lastSync: await getLastSyncTimestamp('syncGenres'),
    },
  };
};