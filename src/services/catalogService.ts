import { prisma } from '../lib/prisma';
import { redis, scanKeys } from '../lib/redis';
import { logger } from '../lib/logger';
import type { Prisma } from '@prisma/client';
import { generateGradientImage } from './imageService';

const AFROBEAT_GENRES = [
  'afrobeats', 'afrobeat', 'afropop', 'afro fusion', 'afropiano',
  'amapiano', 'highlife', 'banku', 'bongo flava', 'kwaito', 'gqom',
  'makossa', 'gengetone', 'naija', 'afro pop', 'afro r&b',
  'afro soul', 'afrohiphop', 'afro hip hop', 'hiplife',
] as const;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[${label}] Timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// Ranks songs with a YouTube match first, preserving secondary ordering
// (e.g. views desc) within each group. Postgres puts NULLs first on DESC,
// so SQL-level ordering by youtubeVideoId cannot express this grouping.
function rankPlayableFirst<T extends { youtubeVideoId?: string | null; views?: number | null }>(
  rows: T[]
): T[] {
  return [...rows].sort((a, b) => {
    const aPlayable = a.youtubeVideoId ? 1 : 0;
    const bPlayable = b.youtubeVideoId ? 1 : 0;
    if (aPlayable !== bPlayable) return bPlayable - aPlayable;
    return (b.views ?? 0) - (a.views ?? 0);
  });
}

interface UnifiedSong {
  id: string;
  title: string;
  artistName: string;
  artistId?: string;
  albumName?: string;
  imageUrl?: string;
  youtubeVideoId?: string | null;
  source: 'DB' | 'HYBRID';
  genres?: string[];
  popularity?: number;
}

// In-process memory cache fallback for when Redis is unavailable
let memCache: { data: any; expiresAt: number; cacheKey: string } | null = null;
const MEM_CACHE_TTL_MS = 3600 * 1000;

class CatalogService {
  async getHomepageData(): Promise<{ songs: UnifiedSong[]; artists: any[]; genres: any[]; featuredArtists: any[] }> {
    const cacheKey = 'catalog:homepage:v20';

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
    let featuredArtists: any[] = [];

    const songWhere: Prisma.SongWhereInput = {
      softDeleted: false,
      artist: { suspended: false },
      AND: [
        {
          OR: [
            { release: null },
            { release: { status: 'PUBLISHED' as const } },
          ],
        },
        {
          OR: [
            { audioUrl: null },
            { released: true },
          ],
        },
      ],
    };

    try {
      const results = await withTimeout(Promise.all([
        this.fetchHomepageArtists(),
        prisma.genre.findMany({ take: 10 }),
      ]), 6000, 'db:homepage');

      dbArtists = results[0].artists;
      genres = results[1];
      featuredArtists = results[0].featuredArtists;

      // 2. Rank songs playable-first (youtubeVideoId set), then by views.
      // Postgres sorts NULLs first on DESC, so the grouping is done here in
      // JS over lightweight keys, then the top rows are hydrated with includes.
      const candidates = await prisma.song.findMany({
        where: songWhere,
        select: { id: true, youtubeVideoId: true, views: true },
        orderBy: { views: 'desc' },
      });
      const topIds = rankPlayableFirst(candidates)
        .slice(0, 20)
        .map((row) => row.id);
      const hydrated = await prisma.song.findMany({
        where: { id: { in: topIds } },
        include: { artist: { select: { name: true, imageUrl: true, suspended: true } } },
      });
      const hydratedById = new Map(hydrated.map((row) => [row.id, row]));
      dbSongs = topIds
        .map((id) => hydratedById.get(id))
        .filter((row): row is NonNullable<typeof row> => Boolean(row));

      if (dbSongs.length === 0 || dbArtists.length === 0) {
        logger.warn({ dbSongs: dbSongs.length, dbArtists: dbArtists.length, genres: genres.length }, 'Catalog: DB returned empty results — possible Neon cold start');
      }
    } catch (err) {
      logger.warn({ err }, 'Catalog: DB queries failed (Neon cold start?) — falling through to Spotify');
    }

    let songs: UnifiedSong[] = dbSongs
      .filter((s) => !(s as any).artist?.suspended)
      .map((s) => ({
      id: s.id,
      title: s.title,
      artistName: (s as any).artist.name,
      artistId: s.artistId,
      albumName: s.albumName || undefined,
      imageUrl: s.imageUrl || '',
      audioUrl: s.audioUrl,
      youtubeVideoId: s.youtubeVideoId || null,
      source: 'DB' as const,
    }));

    let artists = dbArtists.map((a) => ({
      id: a.id,
      name: a.name,
      genre: a.genres?.[0] || '',
      image: a.imageUrl || '',
      bio: a.bio,
      popularity: a.popularity,
      followers: a.followers,
    }));

    // Genre images — use DB imageUrl first, gradient as fallback (no I/O)
    const genreImageObj: Record<string, string> = {};
    const genreNames = genres.slice(0, 10).map((g: any) => g.name);
    for (const g of genres.slice(0, 10)) {
      genreImageObj[g.name] = g.imageUrl || generateGradientImage(g.name);
    }

    // Assemble and return result immediately (DB data only)
    const result = {
      songs: songs
        .sort((a, b) => {
          const aPlayable = a.youtubeVideoId ? 1 : 0;
          const bPlayable = b.youtubeVideoId ? 1 : 0;
          if (aPlayable !== bPlayable) return bPlayable - aPlayable;
          return (b.popularity || 0) - (a.popularity || 0);
        })
        .slice(0, 20)
        .map(s => ({
        id: s.id,
        title: s.title,
        artistName: s.artistName,
        artistId: s.artistId || '',
        albumName: s.albumName || '',
        imageUrl: s.imageUrl || '',
        youtubeVideoId: s.youtubeVideoId || null,
        source: s.source,
      })),
      artists,
      genres: genres.slice(0, 10).map((g: any) => ({
        id: g.id,
        name: g.name,
        image: genreImageObj[g.name] || generateGradientImage(g.name),
      })),
      featuredArtists: featuredArtists.map((a) => ({
        id: a.id,
        name: a.name,
        image: a.imageUrl || '',
        genres: a.genres || [],
        verified: a.verified,
      })),
    };

    const hasRealData = result.songs.length > 0 && result.genres.length > 0 && result.artists.length > 0;
    if (hasRealData) {
      memCache = { data: result, expiresAt: Date.now() + MEM_CACHE_TTL_MS, cacheKey };
      withTimeout(redis.set(cacheKey, JSON.stringify(result), 'EX', 3600), 500, 'redis:homepage:set').catch(() => {
        // Non-fatal cache write failure
      });
    } else {
      logger.warn('Catalog homepage result is empty — skipping Redis cache to avoid poisoning');
    }

    return result;
  }

  /**
   * Fetches homepage artists with a case-insensitive afrobeat-genre match.
   * `genres` is a Postgres String[] so Prisma's `hasSome` is case-sensitive and
   * returns nothing when the stored casing differs. We fetch active artists and
   * partition in JS: afrobeat-genred artists first, then fill with the rest so
   * the section is never empty. Falls back to top artists when none are flagged
   * `isFeatured`.
   */
  private async fetchHomepageArtists(): Promise<{ artists: any[]; featuredArtists: any[] }> {
    const select = {
      id: true,
      name: true,
      imageUrl: true,
      genres: true,
      bio: true,
      popularity: true,
      followers: true,
      verified: true,
      isFeatured: true,
    } as const;

    const candidates = await prisma.artist.findMany({
      where: {
        softDeleted: false,
        suspended: false,
      },
      select,
      take: 40,
      orderBy: [{ popularity: 'desc' }, { followers: 'desc' }],
    });

    const lowerGenres = new Set(AFROBEAT_GENRES.map((g) => g.toLowerCase()));
    const matchesAfrobeat = (a: any) =>
      (a.genres || []).some((g: string) => lowerGenres.has(String(g).toLowerCase()));

    const afrobeat = candidates.filter(matchesAfrobeat);
    const others = candidates.filter((a) => !matchesAfrobeat(a));

    const dbArtists = [...afrobeat, ...others].slice(0, 12);

    let featured = candidates.filter((a) => a.isFeatured);
    if (featured.length === 0) {
      featured = dbArtists;
    }

    return { artists: dbArtists, featuredArtists: featured.slice(0, 8) };
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
    const where: any = {
      softDeleted: false,
      artist: { suspended: false },
      AND: [
        {
          OR: [
            { release: null },
            { release: { status: 'PUBLISHED' } },
          ],
        },
        {
          OR: [
            { audioUrl: null },
            { released: true },
          ],
        },
      ],
    };

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
    const direction = sortOrder === 'asc' ? 1 : -1;
    const secondary = (a: any, b: any): number => {
      if (sortBy === 'title') return a.title.localeCompare(b.title) * direction;
      if (sortBy === 'createdAt') return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * direction;
      if (sortBy === 'releaseYear') return ((a.releaseYear || 0) - (b.releaseYear || 0)) * direction;
      return ((a.views || 0) - (b.views || 0)) * direction;
    };

    const page = params.page || 1;
    const limit = Math.min(params.limit || 50, 500);

    // Playable tracks (youtubeVideoId set) always rank ahead of deferred ones,
    // with the requested sort applied within each group. Postgres sorts NULLs
    // first on DESC, so the grouping is done here over lightweight keys.
    const [keys, total] = await Promise.all([
      prisma.song.findMany({
        where,
        select: { id: true, youtubeVideoId: true, title: true, views: true, createdAt: true, releaseYear: true },
        orderBy: sortBy === 'title' ? { title: sortOrder as any } : sortBy === 'createdAt' ? { createdAt: sortOrder as any } : sortBy === 'releaseYear' ? { releaseYear: sortOrder as any } : { views: sortOrder as any },
      }),
      prisma.song.count({ where }),
    ]);
    const ordered = [...keys].sort((a, b) => {
      const aPlayable = a.youtubeVideoId ? 1 : 0;
      const bPlayable = b.youtubeVideoId ? 1 : 0;
      if (aPlayable !== bPlayable) return bPlayable - aPlayable;
      return secondary(a, b);
    });
    const pageIds = ordered
      .slice((page - 1) * limit, (page - 1) * limit + limit)
      .map((row) => row.id);
    const pageRows = await prisma.song.findMany({
      where: { id: { in: pageIds } },
      include: {
        artist: { select: { name: true, imageUrl: true } },
        genres: { include: { genre: { select: { name: true } } }, take: 1 },
        _count: { select: { lyrics: true } },
      },
    });
    const rowsById = new Map(pageRows.map((row) => [row.id, row]));
    const dbSongs = pageIds
      .map((id) => rowsById.get(id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

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
      youtubeVideoId: (s as any).youtubeVideoId || null,
      audioUrl: (s as any).audioUrl || null,
      source: 'DB' as const,
    }));

    return { songs, total };
  }

  async getCatalogArtists(params: {
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<{ artists: any[]; total: number }> {
    const where: any = {
      softDeleted: false,
      suspended: false,
      genres: { hasSome: [...AFROBEAT_GENRES] },
    };
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
    const patterns = ['catalog:homepage:v*', 'song:views:*'];
    for (const pattern of patterns) {
      try {
        const keys = await withTimeout(scanKeys(pattern), 2000, `redis:keys:${pattern}`);
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

  async invalidateHomepageCache(): Promise<void> {
    memCache = null;
    try {
      const keys = await withTimeout(scanKeys('catalog:homepage:v*'), 2000, 'redis:keys:homepage');
      if (keys.length > 0) {
        await withTimeout(redis.del(...keys), 2000, 'redis:del:homepage');
      }
    } catch {
      // Redis unavailable — skip
    }
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
