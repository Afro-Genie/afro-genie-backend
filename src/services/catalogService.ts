import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { searchSpotify } from './spotifyService';
import { genreService } from './genreService';

const FALLBACK_PREVIEW = '/api/spotify/fallback-preview.mp3';

// Color mapping for genres
const GENRE_COLORS: Record<string, { primary: string; secondary: string }> = {
  'afrobeats': { primary: '#FF6B35', secondary: '#F7931E' },
  'afropop': { primary: '#F4A261', secondary: '#E76F51' },
  'amapiano': { primary: '#2A9D8F', secondary: '#264653' },
  'highlife': { primary: '#E9C46A', secondary: '#F4A261' },
  'dancehall': { primary: '#D62828', secondary: '#F77F00' },
  'reggae': { primary: '#06A77D', secondary: '#118B7C' },
  'hipop': { primary: '#D62828', secondary: '#F77F00' },
  'r&b': { primary: '#7209B7', secondary: '#B5179E' },
  'alt-r&b': { primary: '#7209B7', secondary: '#B5179E' },
  'house': { primary: '#00A8E8', secondary: '#00C9FF' },
  'electronic': { primary: '#FF0080', secondary: '#FF8C00' },
  'pop': { primary: '#FF006E', secondary: '#FB5607' },
  'mbalax': { primary: '#FFB703', secondary: '#FB8500' },
  'benga': { primary: '#8ECAE6', secondary: '#219EBC' },
  'kwaito': { primary: '#023047', secondary: '#FB8500' },
  'afro-fusion': { primary: '#FF006E', secondary: '#FB5607' },
};

/**
 * Generate a gradient-based image URL for genres
 */
function generateGradientImage(genreName: string): string {
  const config = GENRE_COLORS[genreName.toLowerCase()] || {
    primary: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
    secondary: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
  };

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
    <defs>
      <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:${config.primary};stop-opacity:1" />
        <stop offset="100%" style="stop-color:${config.secondary};stop-opacity:1" />
      </linearGradient>
    </defs>
    <rect width="300" height="300" fill="url(#grad)" />
    <text x="50%" y="50%" text-anchor="middle" dy="0.3em" font-size="36" font-weight="bold" fill="white" font-family="Arial" opacity="0.3">
      ${genreName.substring(0, 1).toUpperCase()}
    </text>
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
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

class CatalogService {
  async getHomepageData(): Promise<{ songs: UnifiedSong[]; artists: any[]; genres: any[] }> {
    const cacheKey = 'catalog:homepage:v11';
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    let dbSongs: any[] = [];
    let dbArtists: any[] = [];
    let genres: any[] = [];

    try {
      const results = await Promise.all([
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
      ]);

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

    const dedupeById = <T extends { id: string }>(items: T[]) => {
      const seen = new Set<string>();
      return items.filter((item) => {
        if (seen.has(item.id)) {
          return false;
        }

        seen.add(item.id);
        return true;
      });
    };

    if (songs.length < 10) {
      try {
        const spotifyResults = await searchSpotify('afrobeats', 'track');
        const spotifyTracks = (spotifyResults.tracks?.items ?? []).map((t: any) => ({
          id: `spotify:${t.id}`,
          title: t.name,
          artistName: t.artists?.[0]?.name || 'Unknown',
          albumName: t.album?.name,
          imageUrl: t.album?.images?.[0]?.url,
          previewUrl: t.preview_url || FALLBACK_PREVIEW,
          spotifyId: t.id,
          source: 'SPOTIFY' as const,
          genres: [],
          popularity: t.popularity,
        }));

        songs = dedupeById([...songs, ...spotifyTracks]);
      } catch (err) {
        logger.warn({ err }, 'Spotify fallback for songs failed');
      }
    }

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

    // ALWAYS fetch from Spotify to enrich with images
    try {
      // Search for each artist individually to get their images
      for (const artist of artists) {
        if (!artist.image) {
          try {
            const result = await searchSpotify(artist.name, 'artist');
            const firstArtist = result.artists?.items?.[0];
            if (firstArtist && firstArtist.images?.[0]?.url) {
              artist.image = firstArtist.images[0].url;
            }
          } catch {
            // Individual search failed, continue
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Artist image enrichment failed');
    }

    // Get genres from additional Spotify search
    try {
      const spotifyResults = await searchSpotify('afrobeats', 'artist');
      if (genres.length < 5) {
        const seen = new Set<string>();
        for (const a of (spotifyResults.artists?.items || [])) {
          for (const g of (a.genres || [])) {
            const name = g as string;
            if (!seen.has(name) && name) {
              seen.add(name);
              (genres as any[]).push({ id: `spotify:${name}`, name, imageUrl: '' });
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Spotify genre extraction failed');
    }

    // If genres still low, try secondary search
    if (genres.length < 5) {
      try {
        const additionalResults = await searchSpotify('amapiano', 'artist');
        const seen = new Set<string>(genres.map(g => g.name.toLowerCase()));
        for (const a of (additionalResults.artists?.items || [])) {
          if (genres.length >= 10) break;
          for (const g of (a.genres || [])) {
            const name = g as string;
            if (!seen.has(name.toLowerCase()) && name) {
              seen.add(name.toLowerCase());
              (genres as any[]).push({ id: `spotify:${name}`, name, imageUrl: '' });
            }
          }
        }
      } catch (err2) {
        logger.warn({ err: err2 }, 'Secondary Spotify genre search failed');
      }
    }

    // Fetch genre images from Spotify playlists with gradient fallbacks
    const genreNames = genres.slice(0, 10).map((g: any) => g.name);
    const genreImageMap = await genreService.getGenreImages(genreNames);

    // Convert Map to object for proper serialization
    const genreImageObj: Record<string, string> = {};
    for (const [name, image] of genreImageMap.entries()) {
      genreImageObj[name] = image;
    }

    const result = {
      songs: songs.slice(0, 20).map(s => ({
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
      await redis.set(cacheKey, JSON.stringify(result), 'EX', 21600);
    } else {
      logger.warn('Catalog homepage result is empty — skipping Redis cache to avoid poisoning');
    }
    return result;
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
