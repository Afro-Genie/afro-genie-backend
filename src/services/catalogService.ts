import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { searchSpotify } from './spotifyService';

const FALLBACK_PREVIEW = '/api/spotify/fallback-preview.mp3';

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
    const cacheKey = 'catalog:homepage';
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const [dbSongs, dbArtists, genres] = await Promise.all([
      prisma.song.findMany({
        where: { softDeleted: false },
        include: { artist: { select: { name: true, imageUrl: true } } },
        orderBy: { views: 'desc' },
        take: 20,
      }),
      prisma.artist.findMany({
        where: { softDeleted: false },
        take: 12,
        orderBy: { popularity: 'desc' },
      }),
      prisma.genre.findMany({ take: 10 }),
    ]);

    let songs: UnifiedSong[] = dbSongs.map((s) => ({
      id: s.id,
      title: s.title,
      artistName: (s as any).artist.name,
      artistId: s.artistId,
      albumName: s.albumName || undefined,
      imageUrl: s.imageUrl || undefined,
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
      } catch {
        // Spotify fallback failed; serve DB-only results
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

    if (artists.length < 10) {
      try {
        const spotifyResults = await searchSpotify('afrobeats', 'artist');
        const spotifyArtists = (spotifyResults.artists?.items ?? []).map((artist: any) => ({
          id: `spotify:${artist.id}`,
          name: artist.name,
          genre: artist.genres?.[0] || '',
          image: artist.images?.[0]?.url || '',
          spotifyId: artist.id,
          bio: '',
          popularity: artist.popularity,
          followers: artist.followers?.total || 0,
        }));

        artists = dedupeById([...artists, ...spotifyArtists]).slice(0, 12);
      } catch {
        // Spotify fallback failed; serve DB-only artists.
      }
    }

    const result = {
      songs: songs.slice(0, 20),
      artists,
      genres: genres.map((g) => ({
        id: g.id,
        name: g.name,
        image: g.imageUrl || '',
      })),
    };

    await redis.set(cacheKey, JSON.stringify(result), 'EX', 3600);
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
