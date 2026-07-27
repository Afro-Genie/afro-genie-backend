import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { NotificationType, UserRole } from '@prisma/client';
import { enqueueIndexArtist } from '../jobs/searchIndexJob';
import { getSpotifyToken } from './spotifyService';
import { selectBestSpotifyImage } from './imageService';
import { fetchLastFmArtist } from './lastfmService';
import { syncQueue, lyricsEnrichmentQueue } from '../lib/queue';

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const LAST_SYNC_KEY_PREFIX = 'sync:lastSync:';
const SYNC_DURATION_KEY_PREFIX = 'sync:duration:';
const SYNC_STATS_KEY = 'sync:stats';
const POPULAR_TRACKS_CACHE_KEY = 'catalog:popularTracks';
const POPULAR_TRACKS_SYNC_KEY = 'sync:lastSync:popularTracks';

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
// Monitoring helpers — sync failure alerts + run records
// ---------------------------------------------------------------------------

const sendSyncAlert = async (type: string, error: unknown): Promise<void> => {
  try {
    const adminUser = await prisma.user.findFirst({
      where: { role: UserRole.ADMIN },
      select: { id: true },
    });
    if (!adminUser) return;

    await prisma.notification.create({
      data: {
        userId: adminUser.id,
        title: `Spotify Sync Failed: ${type}`,
        message: `Sync job "${type}" failed: ${error instanceof Error ? error.message : String(error)}`,
        type: NotificationType.SYSTEM,
      },
    });
  } catch {
    // Non-fatal — alert delivery failure shouldn't crash the sync
  }
};

const recordSyncRun = async (data: {
  type: string;
  startedAt: number;
  songsAdded: number;
  artistsUpdated: number;
  errors: number;
}): Promise<void> => {
  try {
    await prisma.syncRun.create({
      data: {
        type: data.type,
        startedAt: new Date(data.startedAt),
        completedAt: new Date(),
        songsAdded: data.songsAdded,
        artistsUpdated: data.artistsUpdated,
        errors: data.errors,
        durationMs: Date.now() - data.startedAt,
      },
    });
  } catch {
    // Non-fatal
  }
};

// ---------------------------------------------------------------------------
// Enqueue helpers — automatically trigger enrichment after each upsert
// ---------------------------------------------------------------------------

const enqueueLyricsEnrichment = async (songId: string): Promise<void> => {
  try {
    await lyricsEnrichmentQueue.add(
      'enrichLyrics',
      { songId },
      {
        jobId: `lyrics-enrichment-${songId}`,
        delay: 1000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 500,
      },
    );
  } catch {
    // Non-fatal
  }
};

const enqueueArtistLastFm = async (artistId: string): Promise<void> => {
  try {
    await syncQueue.add(
      'enrich-artist-lastfm',
      { type: 'enrich-artist-lastfm', artistId },
      {
        jobId: `enrich-artist-lastfm-${artistId}`,
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    );
  } catch {
    // Non-fatal
  }
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
  try {
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
    await recordSyncRun({ type: 'syncAll', startedAt: start, songsAdded: 0, artistsUpdated: synced, errors: failed });

    logger.info({ synced, failed, total: artists.length, durationMs: Date.now() - start }, 'Full artist sync completed');
    return { synced, failed };
  } catch (err) {
    await sendSyncAlert('syncAll', err);
    throw err;
  }
};

// ---------------------------------------------------------------------------
// Refresh stale artists
// ---------------------------------------------------------------------------
export const refreshStaleArtists = async (
  onProgress?: (completed: number, total: number) => void
): Promise<{ refreshed: number; skipped: number }> => {
  const start = Date.now();
  try {
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
    await recordSyncRun({ type: 'refreshStale', startedAt: start, songsAdded: 0, artistsUpdated: refreshed, errors: skipped });

    logger.info(
      { refreshed, skipped, total: staleArtists.length, durationMs: Date.now() - start },
      'Stale artist refresh completed',
    );
    return { refreshed, skipped };
  } catch (err) {
    await sendSyncAlert('refreshStale', err);
    throw err;
  }
};

// ─── African genre keywords for filtering new releases ──────────────────────
const AFRICAN_GENRE_KEYWORDS = new Set([
  'afrobeats', 'amapiano', 'afropop', 'afro fusion', 'highlife',
  'bongo flava', 'gengetone', 'afro r&b', 'dancehall', 'afrobeat',
  'afro house', 'afro soul', 'afro trap', 'azonto', 'kizomba',
  'soukous', 'gqom', 'mbalax', 'kuduro', 'zouglou', 'ndombolo', 'bikutsi',
  'african pop', 'african hip hop', 'african r&b', 'african',
  'naija', 'nigerian', 'ghanaian', 'south african', 'east african',
  'west african', 'afropop', 'south african pop',
]);

// ─── Supplementary genre queries for Friday discovery sync ───────────────────
const SUPPLEMENTARY_GENRE_QUERIES = [
  'afro house', 'afro soul', 'afro trap', 'azonto',
  'kizomba', 'soukous', 'gqom', 'mbalax',
  'kuduro', 'zouglou', 'ndombolo', 'bikutsi',
  'african hip hop', 'african r&b', 'african pop',
  'south african music', 'east african music', 'west african music',
] as const;

interface SpotifyNewReleasesResponse {
  albums: {
    items: Array<{
      id: string;
      name: string;
      artists: Array<{ id: string; name: string }>;
      images?: Array<{ url: string; height: number | null; width: number | null }>;
      release_date?: string;
      total_tracks?: number;
    }>;
    total: number;
    next: string | null;
  };
}

interface SpotifyAlbumTracksResponse {
  items: Array<{
    id: string;
    name: string;
    artists: Array<{ id: string; name: string }>;
    preview_url?: string | null;
    duration_ms: number;
    track_number: number;
  }>;
  total: number;
  next: string | null;
}

// ---------------------------------------------------------------------------
// Popular African tracks sync — weekly background job
// ---------------------------------------------------------------------------
const SEARCH_QUERIES = [
  'afrobeats', 'amapiano', 'afropop', 'nigerian music', 'african music',
  'afro fusion', 'highlife', 'bongo flava', 'gengetone', 'afro r&b',
  'dancehall africa', 'naija hits', 'burna boy', 'wizkid', 'davido',
  'tems', 'asake', 'rema', 'fireboy dml', 'ayra starr',
  'black sherif', 'tiwa savage', 'sauti sol', 'sarkodie', 'diamond platnumz',
] as const;

const GENRE_KEYWORDS = new Set([
  'afrobeats', 'amapiano', 'afropop', 'afro fusion',
  'highlife', 'r&b', 'hip hop', 'banku', 'dancehall', 'alternative',
  'afro r&b', 'bongo flava', 'gengetone', 'dancehall africa', 'naija hits',
  'african music', 'nigerian music',
]);

const TRACKS_PER_QUERY = 30;

interface SpotifySearchTracksResponse {
  tracks: {
    items: Array<{
      id: string;
      name: string;
      artists: Array<{ id: string; name: string }>;
      album: {
        name: string;
        images?: Array<{ url: string; height: number | null; width: number | null }>;
        release_date?: string;
      };
      popularity: number;
      preview_url?: string | null;
      duration_ms: number;
      track_number: number;
    }>;
    total: number;
  };
}

export const syncPopularTracks = async (
  onProgress?: (completed: number, total: number) => void
): Promise<{ synced: number; failed: number; queries: number }> => {
  const start = Date.now();
  try {
    let totalSynced = 0;
    let totalFailed = 0;

    logger.info({ queries: SEARCH_QUERIES.length, tracksPerQuery: TRACKS_PER_QUERY }, 'Starting popular tracks sync');

    for (let i = 0; i < SEARCH_QUERIES.length; i++) {
      const query = SEARCH_QUERIES[i];
      const isGenreQuery = GENRE_KEYWORDS.has(query);

      try {
        const searchResult = await spotifyFetchWithRetry<SpotifySearchTracksResponse>(
          `/search?q=${encodeURIComponent(query)}&type=track&limit=${TRACKS_PER_QUERY}&market=US`
        );

        const tracks = searchResult.tracks?.items ?? [];
        logger.info({ query, tracksFound: tracks.length }, 'Spotify tracks found');

        let querySynced = 0;
        let queryFailed = 0;

        for (const track of tracks) {
          try {
            const artistName = track.artists?.[0]?.name || 'Unknown';
            const spotifyArtistId = track.artists?.[0]?.id || null;

            // Upsert artist (idempotent by spotifyId)
            let artistId: string;
            if (spotifyArtistId) {
              const upserted = await prisma.artist.upsert({
                where: { spotifyId: spotifyArtistId },
                create: {
                  name: artistName,
                  spotifyId: spotifyArtistId,
                  genres: isGenreQuery ? [query] : [],
                  imageUrl: selectBestSpotifyImage(track.album?.images),
                  popularity: track.popularity ?? 0,
                  followers: 0,
                },
                update: {
                  popularity: track.popularity ?? undefined,
                  imageUrl: selectBestSpotifyImage(track.album?.images) ?? undefined,
                  genres: isGenreQuery ? { set: [query] } : undefined,
                },
              });
              artistId = upserted.id;
              void enqueueArtistLastFm(artistId);
            } else {
              const existingArtist = await prisma.artist.findFirst({ where: { name: artistName }, select: { id: true } });
              if (existingArtist) {
                artistId = existingArtist.id;
                void enqueueArtistLastFm(artistId);
              } else {
                const newArtist = await prisma.artist.create({
                  data: {
                    name: artistName,
                    genres: isGenreQuery ? [query] : [],
                    imageUrl: selectBestSpotifyImage(track.album?.images),
                    popularity: track.popularity ?? 0,
                    followers: 0,
                  },
                });
                artistId = newArtist.id;
                void enqueueArtistLastFm(artistId);
              }
            }

            // Upsert song by spotifyId (unique) or title+artistId
            const releaseYear = track.album?.release_date
              ? parseInt(track.album.release_date.substring(0, 4), 10)
              : null;

            const imageUrl = selectBestSpotifyImage(track.album?.images);
            const songData = {
              title: track.name,
              artistId,
              albumName: track.album?.name || null,
              releaseYear: releaseYear && !Number.isNaN(releaseYear) ? releaseYear : null,
              imageUrl,
              spotifyId: track.id,
              spotifyPreviewUrl: track.preview_url || null,
              previewAvailable: !!track.preview_url,
              durationMs: track.duration_ms || null,
              trackNumber: track.track_number || null,
            };

            const existingBySpotify = track.id
              ? await prisma.song.findUnique({ where: { spotifyId: track.id }, select: { id: true } })
              : null;

            const song = existingBySpotify
              ? await prisma.song.update({
                  where: { id: existingBySpotify.id },
                  data: songData,
                })
              : await prisma.song.upsert({
                  where: { title_artistId: { title: track.name, artistId } },
                  create: songData,
                  update: songData,
                });

            void enqueueLyricsEnrichment(song.id);
            querySynced++;
          } catch (err) {
            queryFailed++;
            logger.debug({ trackId: track.id, query, err }, 'Failed to upsert popular track');
          }
        }

        totalSynced += querySynced;
        totalFailed += queryFailed;
        logger.info({ query, synced: querySynced, failed: queryFailed }, 'Query popular tracks synced');

        // Small delay between queries to respect rate limits
        if (i < SEARCH_QUERIES.length - 1) {
          await sleep(500);
        }
      } catch (err) {
        logger.error({ query, err }, 'Failed to sync popular tracks for query');
        totalFailed++;
      }

      onProgress?.(i + 1, SEARCH_QUERIES.length);
    }

    await setLastSyncTimestamp('popularTracks');
    await recordSyncDuration('popularTracks', Date.now() - start);
    await recordSyncRun({ type: 'popularTracks', startedAt: start, songsAdded: totalSynced, artistsUpdated: 0, errors: totalFailed });

    logger.info(
      { synced: totalSynced, failed: totalFailed, queries: SEARCH_QUERIES.length, durationMs: Date.now() - start },
      'Popular tracks sync completed',
    );

    return { synced: totalSynced, failed: totalFailed, queries: SEARCH_QUERIES.length };
  } catch (err) {
    await sendSyncAlert('popularTracks', err);
    throw err;
  }
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

// ---------------------------------------------------------------------------
// New releases sync — check Spotify's new releases for African music
// ---------------------------------------------------------------------------
export const syncNewReleases = async (): Promise<void> => {
  logger.info('[syncNewReleases] Starting new releases sync');

  const start = Date.now();

  const res = await spotifyFetchWithRetry<SpotifyNewReleasesResponse>(
    `/browse/new-releases?limit=30&country=US`,
  );

  const albums = res?.albums?.items ?? [];
  if (albums.length === 0) {
    logger.info('[syncNewReleases] No new releases found');
    await setLastSyncTimestamp('syncNewReleases');
    return;
  }

  const allArtistIds = [...new Set(albums.flatMap((a) => a.artists.map((ar) => ar.id)))];

  const artistGenreMap = new Map<string, string[]>();
  for (let i = 0; i < allArtistIds.length; i += 50) {
    const batch = allArtistIds.slice(i, i + 50);
    const artistRes = await spotifyFetchWithRetry<{ artists: SpotifyArtistResponse[] }>(
      `/artists?ids=${batch.join(',')}`,
    );
    for (const artist of artistRes?.artists ?? []) {
      if (artist) {
        artistGenreMap.set(artist.id, artist.genres);
      }
    }
  }

  const filteredAlbums = albums.filter((album) => {
    const genres = album.artists.flatMap((ar) => artistGenreMap.get(ar.id) ?? []);
    return genres.some((g) => AFRICAN_GENRE_KEYWORDS.has(g.toLowerCase()));
  });

  if (filteredAlbums.length === 0) {
    logger.info('[syncNewReleases] No African-music new releases found');
    await setLastSyncTimestamp('syncNewReleases');
    return;
  }

  let syncedCount = 0;

  for (const album of filteredAlbums) {
    const tracksRes = await spotifyFetchWithRetry<SpotifyAlbumTracksResponse>(
      `/albums/${album.id}/tracks?limit=50`,
    );

    for (const item of tracksRes?.items ?? []) {
      const existing = await prisma.song.findUnique({ where: { spotifyId: item.id } });
      if (existing) continue;

      const artistName = item.artists[0]?.name || 'Unknown';
      const spotifyArtistId = item.artists[0]?.id || null;

      let prismaArtistId: string;
      if (spotifyArtistId) {
        const upserted = await prisma.artist.upsert({
          where: { spotifyId: spotifyArtistId },
          create: {
            name: artistName,
            spotifyId: spotifyArtistId,
            genres: artistGenreMap.get(spotifyArtistId) ?? [],
            imageUrl: selectBestSpotifyImage(album.images),
            popularity: 0,
            followers: 0,
          },
          update: {
            name: artistName,
            genres: artistGenreMap.get(spotifyArtistId) ?? [],
            imageUrl: selectBestSpotifyImage(album.images) ?? undefined,
          },
        });
        prismaArtistId = upserted.id;
        void enqueueArtistLastFm(prismaArtistId);
      } else {
        const existingArtist = await prisma.artist.findFirst({ where: { name: artistName }, select: { id: true } });
        if (existingArtist) {
          prismaArtistId = existingArtist.id;
          void enqueueArtistLastFm(prismaArtistId);
        } else {
          const newArtist = await prisma.artist.create({
            data: {
              name: artistName,
              imageUrl: selectBestSpotifyImage(album.images),
              popularity: 0,
              followers: 0,
            },
          });
          prismaArtistId = newArtist.id;
          void enqueueArtistLastFm(prismaArtistId);
        }
      }

      const song = await prisma.song.upsert({
        where: { spotifyId: item.id },
        create: {
          title: item.name,
          artistId: prismaArtistId,
          albumName: album.name,
          imageUrl: selectBestSpotifyImage(album.images),
          spotifyId: item.id,
          durationMs: item.duration_ms || null,
          trackNumber: item.track_number || null,
        },
        update: {
          title: item.name,
          imageUrl: selectBestSpotifyImage(album.images) ?? undefined,
          durationMs: item.duration_ms || null,
        },
      });

      void enqueueLyricsEnrichment(song.id);
      syncedCount++;
    }
  }

  await setLastSyncTimestamp('syncNewReleases');
  await recordSyncDuration('syncNewReleases', Date.now() - start);

  logger.info({ synced: syncedCount, albums: filteredAlbums.length, durationMs: Date.now() - start }, '[syncNewReleases] Completed');
};

// ---------------------------------------------------------------------------
// Genre discovery sync — supplementary genre queries to catch what main sync missed
// ---------------------------------------------------------------------------
export const syncGenreDiscovery = async (): Promise<void> => {
  logger.info('[syncGenreDiscovery] Starting genre discovery sync');

  const start = Date.now();
  let syncedCount = 0;

  for (const query of SUPPLEMENTARY_GENRE_QUERIES) {
    try {
      const searchRes = await spotifyFetchWithRetry<SpotifySearchTracksResponse>(
        `/search?q=${encodeURIComponent(query)}&type=track&limit=20&market=US`,
      );

      const tracks = searchRes.tracks?.items ?? [];

      const artistIds = [...new Set(tracks.flatMap((t) => t.artists.map((a) => a.id)))];

      const genreMap = new Map<string, string[]>();
      for (let i = 0; i < artistIds.length; i += 50) {
        const batch = artistIds.slice(i, i + 50);
        const artistRes = await spotifyFetchWithRetry<{ artists: SpotifyArtistResponse[] }>(
          `/artists?ids=${batch.join(',')}`,
        );
        for (const artist of artistRes?.artists ?? []) {
          if (artist) {
            genreMap.set(artist.id, artist.genres);
          }
        }
      }

      for (const track of tracks) {
        const existing = await prisma.song.findUnique({ where: { spotifyId: track.id } });
        if (existing) continue;

        const genres = track.artists.flatMap((a) => genreMap.get(a.id) ?? []);
        if (!genres.some((g) => AFRICAN_GENRE_KEYWORDS.has(g.toLowerCase()))) continue;

        const artistName = track.artists[0]?.name || 'Unknown';
        const spotifyArtistId = track.artists[0]?.id || null;

        let prismaArtistId: string;
        if (spotifyArtistId) {
          const upserted = await prisma.artist.upsert({
            where: { spotifyId: spotifyArtistId },
            create: {
              name: artistName,
              spotifyId: spotifyArtistId,
              genres: genreMap.get(spotifyArtistId) ?? [],
              imageUrl: selectBestSpotifyImage(track.album?.images),
              popularity: track.popularity ?? 0,
              followers: 0,
            },
            update: {
              popularity: track.popularity ?? undefined,
              imageUrl: selectBestSpotifyImage(track.album?.images) ?? undefined,
            },
          });
          prismaArtistId = upserted.id;
          void enqueueArtistLastFm(prismaArtistId);
        } else {
          const existingArtist = await prisma.artist.findFirst({ where: { name: artistName }, select: { id: true } });
          if (existingArtist) {
            prismaArtistId = existingArtist.id;
            void enqueueArtistLastFm(prismaArtistId);
          } else {
            const newArtist = await prisma.artist.create({
              data: {
                name: artistName,
                imageUrl: selectBestSpotifyImage(track.album?.images),
                popularity: track.popularity ?? 0,
                followers: 0,
              },
            });
            prismaArtistId = newArtist.id;
            void enqueueArtistLastFm(prismaArtistId);
          }
        }

        const releaseYear = track.album?.release_date
          ? parseInt(track.album.release_date.substring(0, 4), 10)
          : null;

        const song = await prisma.song.upsert({
          where: { spotifyId: track.id },
          create: {
            title: track.name,
            artistId: prismaArtistId,
            albumName: track.album?.name || null,
            releaseYear: releaseYear && !Number.isNaN(releaseYear) ? releaseYear : null,
            imageUrl: selectBestSpotifyImage(track.album?.images),
            spotifyId: track.id,
            spotifyPreviewUrl: track.preview_url || null,
            previewAvailable: !!track.preview_url,
            durationMs: track.duration_ms || null,
            trackNumber: track.track_number || null,
          },
          update: {
            title: track.name,
            albumName: track.album?.name || null,
            releaseYear: releaseYear && !Number.isNaN(releaseYear) ? releaseYear : null,
            imageUrl: selectBestSpotifyImage(track.album?.images) ?? undefined,
            spotifyPreviewUrl: track.preview_url || null,
            previewAvailable: !!track.preview_url,
            durationMs: track.duration_ms || null,
          },
        });

        void enqueueLyricsEnrichment(song.id);
        syncedCount++;
      }
    } catch (err) {
      logger.warn({ err, query }, `[syncGenreDiscovery] Search failed for query "${query}"`);
    }

    if (syncedCount > 0) await sleep(200);
  }

  await setLastSyncTimestamp('syncGenreDiscovery');
  await recordSyncDuration('syncGenreDiscovery', Date.now() - start);

  logger.info({ synced: syncedCount, queries: SUPPLEMENTARY_GENRE_QUERIES.length, durationMs: Date.now() - start }, '[syncGenreDiscovery] Completed');
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
