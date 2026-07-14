import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { searchSpotify } from './spotifyService';
import { genreService } from './genreService';
import { generateGradientImage } from './imageService';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[${label}] Timed out after ${ms}ms`)), ms)
    ),
  ]);
}

interface UnifiedSong {
  id: string;
  title: string;
  artistName: string;
  artistId?: string;
  albumName?: string;
  imageUrl?: string;
  previewUrl?: string | null;
  spotifyId?: string | null;
  source: 'DB' | 'SPOTIFY' | 'HYBRID';
  genres?: string[];
  popularity?: number;
}

// In-process memory cache fallback for when Redis is unavailable
let memCache: { data: any; expiresAt: number; cacheKey: string } | null = null;
const MEM_CACHE_TTL_MS = 3600 * 1000;

class CatalogService {
  async getHomepageData(options?: { spotifyFallback?: boolean }): Promise<{ songs: UnifiedSong[]; artists: any[]; genres: any[] }> {
    const enableSpotifyEnrichment = options?.spotifyFallback !== false;
    const cacheKey = 'catalog:homepage:v17';

    // 1. Try Redis (fast path)
    try {
      const cached = await withTimeout(redis.get(cacheKey), 500, 'redis:homepage:get');
      if (cached) return JSON.parse(cached);
    } catch {
      // Redis unavailable or slow — fall through
    }

    // 2. Try in-process memory cache (protects against repeated Neon cold starts)
    if (memCache && memCache.expiresAt > Date.now() && memCache.cacheKey === cacheKey) {
      return memCache.data;
    }

    let dbSongs: any[] = [];
    let dbArtists: any[] = [];
    let genres: any[] = [];

    try {
      const results = await withTimeout(Promise.all([
        prisma.song.findMany({
          where: { softDeleted: false },
          include: { artist: { select: { name: true, imageUrl: true } } },
          orderBy: { views: 'desc' },
          take: 20,
        }),
        prisma.artist.findMany({
          where: { softDeleted: false },
          select: {
            id: true,
            name: true,
            imageUrl: true,
            genres: true,
            spotifyId: true,
            bio: true,
            popularity: true,
            followers: true,
          },
          take: 12,
          orderBy: { popularity: 'desc' },
        }),
        prisma.genre.findMany({ take: 10 }),
      ]), 6000, 'db:homepage');

      dbSongs = results[0];
      dbArtists = results[1];
      genres = results[2];

      if (dbSongs.length === 0 || dbArtists.length === 0) {
        logger.warn({ dbSongs: dbSongs.length, dbArtists: dbArtists.length, genres: genres.length }, 'Catalog: DB returned empty results — possible Neon cold start');
      }
    } catch (err) {
      logger.warn({ err }, 'Catalog: DB queries failed (Neon cold start?) — falling through to Spotify');
    }

    let songs: UnifiedSong[] = dbSongs.map((s) => ({
      id: s.id,
      title: s.title,
      artistName: (s as any).artist.name,
      artistId: s.artistId,
      albumName: s.albumName || undefined,
      imageUrl: s.imageUrl || '',
      previewUrl: s.spotifyPreviewUrl,
      spotifyId: s.spotifyId,
      source: 'DB' as const,
    }));

    let artists = dbArtists.map((a) => ({
      id: a.id,
      name: a.name,
      genre: a.genres?.[0] || '',
      image: a.imageUrl || '',
      spotifyId: a.spotifyId,
      bio: a.bio,
      popularity: a.popularity,
      followers: a.followers,
    }));

    // Genre images — use gradient fallbacks immediately (no I/O)
    const genreImageObj: Record<string, string> = {};
    const genreNames = genres.slice(0, 10).map((g: any) => g.name);
    for (const name of genreNames) {
      genreImageObj[name] = generateGradientImage(name);
    }

    // Assemble and return result immediately (DB data only)
    const result = {
      songs: songs
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
        .slice(0, 20)
        .map(s => ({
        id: s.id,
        title: s.title,
        artistName: s.artistName,
        artistId: s.artistId || '',
        albumName: s.albumName || '',
        imageUrl: s.imageUrl || '',
        previewUrl: s.previewUrl || null,
        spotifyId: s.spotifyId || null,
        source: s.source,
      })),
      artists,
      genres: genres.slice(0, 10).map((g: any) => ({
        id: g.id,
        name: g.name,
        image: genreImageObj[g.name] || generateGradientImage(g.name),
      })),
    };

    const hasRealData = result.songs.length > 0 && result.genres.length > 0;
    if (hasRealData) {
      memCache = { data: result, expiresAt: Date.now() + MEM_CACHE_TTL_MS, cacheKey };
      withTimeout(redis.set(cacheKey, JSON.stringify(result), 'EX', 3600), 500, 'redis:homepage:set').catch(() => {
        // Non-fatal cache write failure
      });
    } else {
      logger.warn('Catalog homepage result is empty — skipping Redis cache to avoid poisoning');
    }

    // Kick off Spotify enrichment in background (non-blocking)
    if (enableSpotifyEnrichment && hasRealData) {
      this.enrichHomepageCache(cacheKey).catch((err) => {
        logger.warn({ err }, 'Background homepage enrichment failed');
      });
    }

    return result;
  }

  private async enrichHomepageCache(cacheKey: string): Promise<void> {
    const dbSongs = await prisma.song.findMany({
      where: { softDeleted: false },
      include: { artist: { select: { name: true, imageUrl: true } } },
      orderBy: { views: 'desc' },
      take: 20,
    });
    const dbArtists = await prisma.artist.findMany({
      where: { softDeleted: false },
      select: {
        id: true, name: true, imageUrl: true, genres: true,
        spotifyId: true, bio: true, popularity: true, followers: true,
      },
      take: 12,
      orderBy: { popularity: 'desc' },
    });
    const genres = await prisma.genre.findMany({ take: 10 });

    const artists = dbArtists.map((a) => ({
      id: a.id,
      name: a.name,
      genre: a.genres?.[0] || '',
      image: a.imageUrl || '',
      spotifyId: a.spotifyId,
      bio: a.bio,
      popularity: a.popularity,
      followers: a.followers,
    }));

    // Artist images — parallel batches
    const artistsNeedingImages = artists.filter(a => !a.image);
    if (artistsNeedingImages.length > 0) {
      const CONCURRENCY = 5;
      for (let i = 0; i < artistsNeedingImages.length; i += CONCURRENCY) {
        const batch = artistsNeedingImages.slice(i, i + CONCURRENCY);
        await Promise.allSettled(
          batch.map(async (artist) => {
            try {
              const result = await searchSpotify(artist.name, 'artist');
              const firstArtist = result.artists?.items?.[0];
              if (firstArtist?.images?.[0]?.url) {
                artist.image = firstArtist.images[0].url;
              }
            } catch {
              // Individual search failed
            }
          })
        );
      }
    }

    // Genre enrichment from Spotify
    if (genres.length < 5) {
      const [afrobeatsResult, amapianoResult] = await Promise.allSettled([
        searchSpotify('afrobeats', 'artist'),
        searchSpotify('amapiano', 'artist'),
      ]);

      const seen = new Set<string>(genres.map(g => g.name?.toLowerCase()));

      if (afrobeatsResult.status === 'fulfilled') {
        for (const a of (afrobeatsResult.value.artists?.items || [])) {
          for (const g of (a.genres || [])) {
            const name = g as string;
            if (!seen.has(name.toLowerCase()) && name && genres.length < 10) {
              seen.add(name.toLowerCase());
              (genres as any[]).push({ id: `spotify:${name}`, name, imageUrl: '' });
            }
          }
        }
      }

      if (genres.length < 5 && amapianoResult.status === 'fulfilled') {
        for (const a of (amapianoResult.value.artists?.items || [])) {
          for (const g of (a.genres || [])) {
            const name = g as string;
            if (!seen.has(name.toLowerCase()) && name && genres.length < 10) {
              seen.add(name.toLowerCase());
              (genres as any[]).push({ id: `spotify:${name}`, name, imageUrl: '' });
            }
          }
        }
      }
    }

    // Genre images — parallel from Spotify playlists
    const genreNames = genres.slice(0, 10).map((g: any) => g.name);
    const genreImageMap = new Map<string, string>();
    const genreResults = await Promise.allSettled(
      genreNames.map(name => genreService.getGenreImage(name))
    );
    for (let i = 0; i < genreNames.length; i++) {
      if (genreResults[i].status === 'fulfilled') {
        genreImageMap.set(genreNames[i], (genreResults[i] as PromiseFulfilledResult<string>).value);
      }
    }

    const genreImageObj: Record<string, string> = {};
    for (const [name, image] of genreImageMap.entries()) {
      genreImageObj[name] = image;
    }

    const enrichedResult = {
      songs: dbSongs.map((s) => ({
        id: s.id,
        title: s.title,
        artistName: (s as any).artist.name,
        artistId: s.artistId || '',
        albumName: s.albumName || '',
        imageUrl: s.imageUrl || '',
        previewUrl: s.spotifyPreviewUrl || null,
        spotifyId: s.spotifyId || null,
        source: 'DB' as const,
      })).sort((a, b) => 0).slice(0, 20),
      artists,
      genres: genres.slice(0, 10).map((g: any) => ({
        id: g.id,
        name: g.name,
        image: genreImageObj[g.name] || generateGradientImage(g.name),
      })),
    };

    try {
      await redis.set(cacheKey, JSON.stringify(enrichedResult), 'EX', 3600);
      logger.info('Homepage cache enriched with Spotify data');
    } catch {
      // Non-fatal
    }
  }

  async getCatalogSongs(params: {
    page?: number;
    limit?: number;
    language?: string;
    genre?: string;
    artistId?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: string;
  }): Promise<{ songs: any[]; total: number }> {
    const where: any = { softDeleted: false };

    if (params.language && params.language !== 'all') {
      where.songLanguages = { some: { language: { code: params.language } } };
    }
    if (params.artistId && params.artistId !== 'all') {
      where.artistId = params.artistId;
    }
    if (params.genre && params.genre !== 'all') {
      where.genres = { some: { genre: { name: params.genre } } };
    }
    if (params.search) {
      where.OR = [
        { title: { contains: params.search, mode: 'insensitive' } },
        { artist: { name: { contains: params.search, mode: 'insensitive' } } },
      ];
    }

    const sortBy = params.sortBy || 'views';
    const sortOrder = params.sortOrder === 'asc' ? 'asc' : 'desc';
    const orderBy: any = {};
    if (sortBy === 'title') orderBy.title = sortOrder;
    else if (sortBy === 'createdAt') orderBy.createdAt = sortOrder;
    else if (sortBy === 'releaseYear') orderBy.releaseYear = sortOrder;
    else orderBy.views = sortOrder;

    const page = params.page || 1;
    const limit = Math.min(params.limit || 50, 500);

    const [dbSongs, total] = await Promise.all([
      prisma.song.findMany({
        where,
        include: {
          artist: { select: { name: true, imageUrl: true } },
          genres: { include: { genre: { select: { name: true } } }, take: 1 },
          _count: { select: { lyrics: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
      }),
      prisma.song.count({ where }),
    ]);

    const songs = dbSongs.map((s) => ({
      id: s.id,
      title: s.title,
      artist: (s as any).artist.name,
      artistId: s.artistId,
      image: s.imageUrl || '',
      views: s.views,
      year: s.releaseYear,
      genre: s.genres?.[0]?.genre?.name || '',
      album: s.albumName || '',
      requestCount: s.requestCount,
      createdAt: s.createdAt,
      spotifyId: s.spotifyId || null,
      source: (s as any)._count?.lyrics > 0 ? 'DB' as const : s.spotifyId ? 'SPOTIFY' as const : 'DB' as const,
    }));

    return { songs, total };
  }

  async getCatalogArtists(params: {
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<{ artists: any[]; total: number }> {
    const where: any = { softDeleted: false };
    if (params.search) {
      where.name = { contains: params.search, mode: 'insensitive' };
    }

    const page = params.page || 1;
    const limit = Math.min(params.limit || 20, 200);

    const [artists, total] = await Promise.all([
      prisma.artist.findMany({
        where,
        select: {
          id: true,
          name: true,
          imageUrl: true,
          genres: true,
          spotifyId: true,
          bio: true,
          popularity: true,
          followers: true,
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { popularity: 'desc' },
      }),
      prisma.artist.count({ where }),
    ]);

    return {
      artists: artists.map((a) => ({
        id: a.id,
        name: a.name,
        genre: a.genres?.[0] || '',
        image: a.imageUrl || '',
        spotifyId: a.spotifyId,
        bio: a.bio,
        popularity: a.popularity,
        followers: a.followers,
      })),
      total,
    };
  }

  async clearCache(): Promise<{ cleared: string[] }> {
    const cleared: string[] = [];

    // Clear in-process memory cache
    memCache = null;
    cleared.push('memCache');

    // Clear all known Redis cache keys
    const patterns = ['catalog:homepage:v*', 'spotify:search:*', 'song:views:*'];
    for (const pattern of patterns) {
      try {
        const keys = await withTimeout(redis.keys(pattern), 2000, `redis:keys:${pattern}`);
        if (keys.length > 0) {
          await withTimeout(redis.del(...keys), 2000, `redis:del:${pattern}`);
          cleared.push(...keys);
        }
      } catch {
        // Redis unavailable — skip
      }
    }

    return { cleared };
  }

  async getCatalogAlbums(artistId: string): Promise<{ albums: any[] }> {
    const songs = await prisma.song.findMany({
      where: { artistId, softDeleted: false, albumName: { not: null } },
      select: { albumName: true, imageUrl: true, releaseYear: true },
      distinct: ['albumName'],
      orderBy: { releaseYear: 'desc' },
    });

    return {
      albums: songs.map((s) => ({
        name: s.albumName,
        imageUrl: s.imageUrl,
        year: s.releaseYear,
      })),
    };
  }
}

export const catalogService = new CatalogService();
