import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { enqueueIndexArtist } from '../jobs/searchIndexJob';
import { getSpotifyToken } from './spotifyService';
import { selectBestSpotifyImage } from './imageService';

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const LAST_SYNC_KEY_PREFIX = 'sync:lastSync:';
const SYNC_DURATION_KEY_PREFIX = 'sync:duration:';
const SYNC_STATS_KEY = 'sync:stats';

interface SpotifyArtistResponse {
  id: string;
  name: string;
  genres: string[];
  popularity: number;
  images: Array<{ url: string; height: number | null; width: number | null }>;
  followers?: { total?: number };
  external_urls?: { spotify?: string };
}

interface SpotifyAlbumItem {
  id: string;
  name: string;
  images?: Array<{ url: string; height: number | null; width: number | null }>;
  release_date?: string;
  total_tracks?: number;
  popularity?: number;
}

interface SpotifyAlbumsResponse {
  items: SpotifyAlbumItem[];
  total: number;
  next: string | null;
}

interface SpotifyTopTrackItem {
  id: string;
  name: string;
  preview_url?: string | null;
  album?: {
    images?: Array<{ url: string; height: number | null; width: number | null }>;
  };
}

interface SpotifyTopTracksResponse {
  tracks: SpotifyTopTrackItem[];
}

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
  };
  lastSyncDuration: {
    syncAll: number | null;
    refreshStale: number | null;
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
}

// ---------------------------------------------------------------------------
// Adaptive rate limiting — respects Spotify Retry-After headers
// ---------------------------------------------------------------------------
async function spotifyFetchWithRetry<T>(path: string, retries = 3): Promise<T> {
  const token = await getSpotifyToken();

  for (let attempt = 0; attempt < retries; attempt++) {
    const response = await fetch(`${SPOTIFY_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader
        ? Math.min(parseInt(retryAfterHeader, 10) || 1, env.SYNC_RETRY_AFTER_MAX_SECONDS)
        : Math.min(2 ** attempt, env.SYNC_RETRY_AFTER_MAX_SECONDS);

      logger.warn(
        { path, attempt: attempt + 1, retryAfterSeconds },
        'Spotify rate limited (429), waiting before retry',
      );
      await sleep(retryAfterSeconds * 1000);
      continue;
    }

    if (!response.ok) {
      const details = await response.text();
      logger.error({ status: response.status, details, path }, 'Spotify API request failed');
      throw new Error(`Spotify API error (${response.status}): ${details}`);
    }

    return response.json() as Promise<T>;
  }

  throw new Error(`Spotify API error: rate limit exceeded after ${retries} retries for ${path}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Stale threshold — configurable via environment variable
// ---------------------------------------------------------------------------
function getStaleThresholdMs(): number {
  return env.SYNC_STALE_THRESHOLD_HOURS * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Sync timestamps and stats
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Artist metadata sync
// ---------------------------------------------------------------------------
export const syncArtistMetadata = async (artistId: string): Promise<{ updated: boolean }> => {
  const artist = await prisma.artist.findUnique({
    where: { id: artistId },
    select: { id: true, spotifyId: true, name: true },
  });

  if (!artist) {
    logger.warn({ artistId }, 'Artist not found, skipping sync');
    return { updated: false };
  }

  if (!artist.spotifyId) {
    logger.debug({ artistId, name: artist.name }, 'Artist has no Spotify ID, skipping metadata sync');
    return { updated: false };
  }

  try {
    const spotifyArtist = await spotifyFetchWithRetry<SpotifyArtistResponse>(
      `/artists/${encodeURIComponent(artist.spotifyId)}`
    );

    await prisma.artist.update({
      where: { id: artistId },
      data: {
        name: spotifyArtist.name,
        imageUrl: selectBestSpotifyImage(spotifyArtist.images),
        popularity: spotifyArtist.popularity ?? 0,
        genres: spotifyArtist.genres ?? [],
        followers: spotifyArtist.followers?.total ?? 0,
        externalUrl: spotifyArtist.external_urls?.spotify ?? null,
      },
    });

    await enqueueIndexArtist(artistId);
    await setLastSyncTimestamp(`artist:${artistId}`);

    await syncArtistPreviewUrls(artist.spotifyId);

    logger.info({ artistId, spotifyId: artist.spotifyId }, 'Artist metadata synced from Spotify');
    return { updated: true };
  } catch (error) {
    logger.error({ artistId, spotifyId: artist.spotifyId, err: error }, 'Failed to sync artist metadata');
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Artist preview URLs sync
// ---------------------------------------------------------------------------
const syncArtistPreviewUrls = async (spotifyArtistId: string): Promise<void> => {
  try {
    const topTracks = await spotifyFetchWithRetry<SpotifyTopTracksResponse>(
      `/artists/${encodeURIComponent(spotifyArtistId)}/top-tracks?market=US`
    );

    // Build maps for tracks that have data
    const previewMap = new Map<string, string>();
    const nullPreviewIds = new Set<string>();
    const imageMap = new Map<string, string>();
    for (const track of topTracks.tracks) {
      if (track.preview_url) {
        previewMap.set(track.id, track.preview_url);
      } else {
        nullPreviewIds.add(track.id);
      }
      const imageUrl = selectBestSpotifyImage(track.album?.images);
      if (imageUrl) {
        imageMap.set(track.id, imageUrl);
      }
    }

    // Skip songs already known to have no preview — avoid redundant lookups
    const candidateIds = [...previewMap.keys(), ...nullPreviewIds.keys()];
    const allTrackIds = new Set([...previewMap.keys(), ...imageMap.keys(), ...nullPreviewIds]);
    if (allTrackIds.size === 0) return;

    const songs = await prisma.song.findMany({
      where: {
        spotifyId: { in: Array.from(allTrackIds) },
        softDeleted: false,
      },
      select: { id: true, spotifyId: true, imageUrl: true, previewAvailable: true },
    });

    for (const song of songs) {
      if (!song.spotifyId) continue;
      const previewUrl = previewMap.get(song.spotifyId);
      const imageUrl = imageMap.get(song.spotifyId);
      const hasNullPreview = nullPreviewIds.has(song.spotifyId);

      const updateData: Record<string, unknown> = {};
      if (previewUrl) {
        updateData.spotifyPreviewUrl = previewUrl;
        if (song.previewAvailable !== true) updateData.previewAvailable = true;
      }
      if (imageUrl && !song.imageUrl) updateData.imageUrl = imageUrl;
      if (hasNullPreview && song.previewAvailable !== false) {
        updateData.previewAvailable = false;
      }
      if (Object.keys(updateData).length > 0) {
        await prisma.song.update({
          where: { id: song.id },
          data: updateData,
        });
      }
    }

    logger.debug(
      { spotifyArtistId, matchedSongs: songs.length, previewsFound: previewMap.size, nullPreviews: nullPreviewIds.size, imagesFound: imageMap.size },
      'Artist preview URLs and artwork synced'
    );
  } catch (error) {
    logger.warn({ spotifyArtistId, err: error }, 'Failed to sync artist preview URLs (non-fatal)');
  }
};

// ---------------------------------------------------------------------------
// Artist albums sync
// ---------------------------------------------------------------------------
export const syncArtistAlbums = async (artistId: string): Promise<{ albumsSynced: number }> => {
  const artist = await prisma.artist.findUnique({
    where: { id: artistId },
    select: { id: true, spotifyId: true, name: true },
  });

  if (!artist?.spotifyId) {
    logger.debug({ artistId }, 'Artist not found or has no Spotify ID, skipping album sync');
    return { albumsSynced: 0 };
  }

  let allAlbums: SpotifyAlbumItem[] = [];
  let url: string | null = `/artists/${encodeURIComponent(artist.spotifyId)}/albums?include_groups=album&limit=50`;

  try {
    while (url) {
      const response: SpotifyAlbumsResponse = await spotifyFetchWithRetry<SpotifyAlbumsResponse>(url);
      allAlbums.push(...response.items);
      url = response.next;
      if (url) await sleep(200);
    }
  } catch (error) {
    logger.error({ artistId, spotifyId: artist.spotifyId, err: error }, 'Failed to fetch artist albums from Spotify');
    throw error;
  }

  let syncedCount = 0;
  for (const album of allAlbums) {
    try {
      const releaseYear = album.release_date ? parseInt(album.release_date.substring(0, 4), 10) : null;

      await prisma.album.upsert({
        where: { spotifyId: album.id },
        create: {
          name: album.name,
          artistId: artist.id,
          imageUrl: selectBestSpotifyImage(album.images),
          spotifyId: album.id,
          releaseYear: releaseYear && !Number.isNaN(releaseYear) ? releaseYear : null,
          totalTracks: album.total_tracks ?? null,
          popularity: album.popularity ?? 0,
        },
        update: {
          name: album.name,
          imageUrl: selectBestSpotifyImage(album.images),
          releaseYear: releaseYear && !Number.isNaN(releaseYear) ? releaseYear : null,
          totalTracks: album.total_tracks ?? null,
          popularity: album.popularity ?? 0,
        },
      });
      syncedCount++;
    } catch (error) {
      logger.warn({ albumId: album.id, artistId, err: error }, 'Failed to upsert album');
    }
  }

  await setLastSyncTimestamp(`artistAlbums:${artistId}`);

  logger.info({ artistId, spotifyId: artist.spotifyId, syncedCount, total: allAlbums.length }, 'Artist albums synced');
  return { albumsSynced: syncedCount };
};

// ---------------------------------------------------------------------------
// Full artist sync — metadata + albums + preview URLs in one pass
// ---------------------------------------------------------------------------
export const syncArtistFull = async (
  artistId: string,
): Promise<{ metadataUpdated: boolean; albumsSynced: number }> => {
  const start = Date.now();

  const metadataResult = await syncArtistMetadata(artistId);
  const albumsResult = await syncArtistAlbums(artistId);

  await setLastSyncTimestamp(`artistFull:${artistId}`);
  await recordSyncDuration(`artistFull:${artistId}`, Date.now() - start);

  logger.info(
    {
      artistId,
      metadataUpdated: metadataResult.updated,
      albumsSynced: albumsResult.albumsSynced,
      durationMs: Date.now() - start,
    },
    'Full artist sync completed',
  );

  return { metadataUpdated: metadataResult.updated, albumsSynced: albumsResult.albumsSynced };
};

// ---------------------------------------------------------------------------
// Genre sync — upsert all genres from Spotify artist data
// ---------------------------------------------------------------------------
export const syncGenres = async (): Promise<{ synced: number }> => {
  const artists = await prisma.artist.findMany({
    where: { softDeleted: false, spotifyId: { not: null } },
    select: { id: true, genres: true },
    take: env.SYNC_MAX_BATCH,
  });

  const genreSet = new Set<string>();
  for (const artist of artists) {
    for (const genre of artist.genres) {
      genreSet.add(genre.trim().toLowerCase());
    }
  }

  let syncedCount = 0;
  for (const genreName of genreSet) {
    try {
      await prisma.genre.upsert({
        where: { name: genreName },
        create: { name: genreName },
        update: { name: genreName },
      });
      syncedCount++;
    } catch (error) {
      logger.warn({ genreName, err: error }, 'Failed to upsert genre');
    }
  }

  await setLastSyncTimestamp('syncGenres');

  logger.info({ synced: syncedCount, totalFromArtists: genreSet.size }, 'Genre sync completed');
  return { synced: syncedCount };
};

// ---------------------------------------------------------------------------
// Sync all artists
// ---------------------------------------------------------------------------
export const syncAllArtists = async (
  onProgress?: (completed: number, total: number) => void
): Promise<{ synced: number; failed: number }> => {
  const start = Date.now();
  const artists = await prisma.artist.findMany({
    where: { softDeleted: false, spotifyId: { not: null } },
    select: { id: true, spotifyId: true },
    take: env.SYNC_MAX_BATCH,
  });

  logger.info({ total: artists.length }, 'Starting full artist sync');

  let synced = 0;
  let failed = 0;

  for (let i = 0; i < artists.length; i++) {
    try {
      await syncArtistMetadata(artists[i].id);
      synced++;
    } catch {
      failed++;
    }
    onProgress?.(i + 1, artists.length);
    if (i < artists.length - 1) await sleep(200);
  }

  await setLastSyncTimestamp('syncAll');
  await recordSyncDuration('syncAll', Date.now() - start);
  await recordSyncStats(synced, failed);

  logger.info({ synced, failed, total: artists.length, durationMs: Date.now() - start }, 'Full artist sync completed');
  return { synced, failed };
};

// ---------------------------------------------------------------------------
// Refresh stale artists
// ---------------------------------------------------------------------------
export const refreshStaleArtists = async (
  onProgress?: (completed: number, total: number) => void
): Promise<{ refreshed: number; skipped: number }> => {
  const start = Date.now();
  const staleThresholdMs = getStaleThresholdMs();
  const cutoffTime = new Date(Date.now() - staleThresholdMs);

  const staleArtists = await prisma.artist.findMany({
    where: {
      softDeleted: false,
      spotifyId: { not: null },
      updatedAt: { lt: cutoffTime },
    },
    select: { id: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' },
    take: env.SYNC_MAX_BATCH,
  });

  logger.info(
    { staleCount: staleArtists.length, thresholdHours: env.SYNC_STALE_THRESHOLD_HOURS },
    'Refreshing stale artists',
  );

  let refreshed = 0;
  let skipped = 0;

  for (let i = 0; i < staleArtists.length; i++) {
    try {
      await syncArtistMetadata(staleArtists[i].id);
      refreshed++;
    } catch {
      skipped++;
    }
    onProgress?.(i + 1, staleArtists.length);
    if (i < staleArtists.length - 1) await sleep(200);
  }

  await setLastSyncTimestamp('refreshStale');
  await recordSyncDuration('refreshStale', Date.now() - start);

  logger.info(
    { refreshed, skipped, total: staleArtists.length, durationMs: Date.now() - start },
    'Stale artist refresh completed',
  );
  return { refreshed, skipped };
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
    durationSyncAll,
    durationRefreshStale,
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
    getSyncDuration('syncAll'),
    getSyncDuration('refreshStale'),
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
    },
    lastSyncDuration: {
      syncAll: durationSyncAll,
      refreshStale: durationRefreshStale,
    },
    queueDepth,
    recentStats: syncStats,
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
