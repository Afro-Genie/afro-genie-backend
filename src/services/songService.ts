import { Prisma, TranslationStatus } from '@prisma/client';
import { enqueueIndexSong } from '../jobs/searchIndexJob';
import { enqueueLanguageCategorization } from '../jobs/languageCategorizationJob';
import { lyricsEnrichmentQueue } from '../lib/queue';
import { redis } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { ApiError } from '../middleware/errorHandler';
import { getLatestLyricsContent, takedownLyrics, upsertLyrics, type LyricsInput } from './lyricsService';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

type SortBy = 'views' | 'popularity' | 'createdAt';
type SortOrder = 'asc' | 'desc';

interface SongFilters {
  language?: string;
  lang?: string;
  genre?: string;
  artistId?: string;
  search?: string;
}

interface SongListParams extends SongFilters {
  cursor?: string;
  lastId?: string;
  limit?: number;
  page?: number;
  sortBy?: SortBy;
  sortOrder?: SortOrder;
}

export interface SongMutationInput {
  title: string;
  artistId: string;
  albumName?: string | null;
  releaseYear?: number | null;
  spotifyId?: string | null;
  coverImageUrl?: string | null;
  imageUrl?: string | null;
  primaryLanguage?: string | null;
  languages?: string[];
  genres?: string[];
  lyrics?: LyricsInput;
}

const isMissingSoftDeleteColumnError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('softDeleted') && (message.includes('column') || message.includes('does not exist'));
};

const normalizeLimit = (limit?: number): number => {
  if (!limit || Number.isNaN(limit)) {
    return DEFAULT_LIMIT;
  }

  return Math.max(1, Math.min(MAX_LIMIT, limit));
};

const normalizeSortBy = (sortBy?: string): SortBy => {
  if (sortBy === 'views' || sortBy === 'popularity' || sortBy === 'createdAt') {
    return sortBy;
  }

  return 'createdAt';
};

const normalizeSortOrder = (sortOrder?: string): SortOrder => {
  return sortOrder === 'asc' ? 'asc' : 'desc';
};

const buildOrderBy = (sortBy: SortBy, sortOrder: SortOrder): Prisma.SongOrderByWithRelationInput => {
  if (sortBy === 'popularity') {
    return { requestCount: sortOrder };
  }

  if (sortBy === 'views') {
    return { views: sortOrder };
  }

  return { createdAt: sortOrder };
};

const buildSongWhere = (filters: SongFilters): Prisma.SongWhereInput => {
  const languageCode = (filters.language ?? filters.lang)?.trim().toLowerCase();

  return {
    ...(filters.artistId ? { artistId: filters.artistId } : {}),
    ...(filters.search
      ? {
          title: {
            contains: filters.search.trim(),
            mode: Prisma.QueryMode.insensitive,
          },
        }
      : {}),
    ...(filters.genre
      ? {
          genres: {
            some: {
              genre: {
                name: {
                  equals: filters.genre.trim(),
                  mode: Prisma.QueryMode.insensitive,
                },
              },
            },
          },
        }
      : {}),
    ...(languageCode
      ? {
          songLanguages: {
            some: {
              languageCode,
              percentage: { gte: 30 },
            },
          },
        }
      : {}),
  };
};

const isSongActive = async (songId: string): Promise<boolean> => {
  try {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Song"
      WHERE "id" = ${songId}
        AND COALESCE("softDeleted", false) = false
      LIMIT 1
    `;

    return rows.length > 0;
  } catch (error) {
    if (!isMissingSoftDeleteColumnError(error)) {
      throw error;
    }

    const song = await prisma.song.findUnique({
      where: { id: songId },
      select: { id: true },
    });

    return !!song;
  }
};

const isArtistActive = async (artistId: string): Promise<boolean> => {
  try {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Artist"
      WHERE "id" = ${artistId}
        AND COALESCE("softDeleted", false) = false
      LIMIT 1
    `;

    return rows.length > 0;
  } catch (error) {
    if (!isMissingSoftDeleteColumnError(error)) {
      throw error;
    }

    const artist = await prisma.artist.findUnique({
      where: { id: artistId },
      select: { id: true },
    });

    return !!artist;
  }
};

const getActiveSongIdSet = async (songIds: string[]): Promise<Set<string>> => {
  if (songIds.length === 0) {
    return new Set();
  }

  try {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Song"
      WHERE "id" = ANY(${songIds})
        AND COALESCE("softDeleted", false) = false
    `;

    return new Set(rows.map((row) => row.id));
  } catch (error) {
    if (!isMissingSoftDeleteColumnError(error)) {
      throw error;
    }

    return new Set(songIds);
  }
};

const songInclude = {
  artist: {
    select: {
      id: true,
      name: true,
      imageUrl: true,
      genres: true,
    },
  },
  songLanguages: {
    select: {
      languageCode: true,
      percentage: true,
    },
  },
  genres: {
    include: {
      genre: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  },
  lyrics: {
    where: {
      licenseStatus: { not: 'TAKEDOWN' },
    },
    orderBy: { createdAt: 'desc' as const },
    take: 1,
  },
} satisfies Prisma.SongInclude;

const getLatestApprovedTranslationsByLanguage = async (songId: string) => {
  const translations = await prisma.translation.findMany({
    where: {
      songId,
      status: {
        in: [TranslationStatus.APPROVED, TranslationStatus.PUBLISHED],
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  const latestByLanguage: Record<string, (typeof translations)[number]> = {};
  for (const translation of translations) {
    if (!latestByLanguage[translation.targetLang]) {
      latestByLanguage[translation.targetLang] = translation;
    }
  }

  return latestByLanguage;
};

export const listSongs = async (params: SongListParams) => {
  const cursor = params.cursor ?? params.lastId;
  const limit = normalizeLimit(params.limit);
  const page = params.page && params.page > 0 ? params.page : 1;
  const sortBy = normalizeSortBy(params.sortBy);
  const sortOrder = normalizeSortOrder(params.sortOrder);
  const where = buildSongWhere(params);
  const orderBy = buildOrderBy(sortBy, sortOrder);

  let total = 0;
  try {
    const totalRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "Song" s
      WHERE COALESCE(s."softDeleted", false) = false
        AND (${params.artistId ?? null}::text IS NULL OR s."artistId" = ${params.artistId ?? null})
        AND (${params.search ?? null}::text IS NULL OR LOWER(s."title") LIKE '%' || LOWER(${params.search ?? null}) || '%')
        AND (
          ${(params.genre ?? '').trim() || null}::text IS NULL
          OR EXISTS (
            SELECT 1
            FROM "SongGenre" sg
            JOIN "Genre" g ON g."id" = sg."genreId"
            WHERE sg."songId" = s."id"
              AND LOWER(g."name") = LOWER(${(params.genre ?? '').trim() || null})
          )
        )
        AND (
          ${((params.language ?? params.lang) ?? '').trim().toLowerCase() || null}::text IS NULL
          OR EXISTS (
            SELECT 1
            FROM "SongLanguage" sl
            WHERE sl."songId" = s."id"
              AND sl."languageCode" = ${((params.language ?? params.lang) ?? '').trim().toLowerCase() || null}
              AND sl."percentage" >= 30
          )
        )
    `;

    total = Number(totalRows[0]?.count ?? 0);
  } catch (error) {
    if (!isMissingSoftDeleteColumnError(error)) {
      throw error;
    }

    total = await prisma.song.count({ where });
  }

  let songs;
  let nextCursor: string | null = null;

  if (cursor) {
    const rows = await prisma.song.findMany({
      where,
      include: songInclude as Prisma.SongInclude,
      orderBy,
      cursor: { id: cursor },
      skip: 1,
      take: limit + 1,
    });

    const hasNext = rows.length > limit;
    songs = hasNext ? rows.slice(0, limit) : rows;
    nextCursor = hasNext ? songs[songs.length - 1]?.id ?? null : null;
  } else {
    const rows = await prisma.song.findMany({
      where,
      include: songInclude as Prisma.SongInclude,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    });
    songs = rows;
  }

  const activeSongIds = await getActiveSongIdSet(songs.map((song) => song.id));
  songs = songs.filter((song) => activeSongIds.has(song.id));

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return {
    songs,
    data: songs,
    total,
    page,
    totalPages,
    nextCursor,
  };
};

export const getSongById = async (songId: string, options?: { incrementViewCount?: boolean }) => {
  const active = await isSongActive(songId);
  if (!active) {
    throw new ApiError('Song not found', 'NOT_FOUND', 404);
  }

  const song = await prisma.song.findFirst({
    where: {
      id: songId,
    },
    include: {
      ...songInclude,
      translations: {
        orderBy: {
          createdAt: 'desc',
        },
      },
    } as Prisma.SongInclude,
  });

  if (!song) {
    throw new ApiError('Song not found', 'NOT_FOUND', 404);
  }

  const key = `song:views:${songId}`;
  const shouldIncrement = options?.incrementViewCount ?? true;
  let currentCount = 0;
  try {
    currentCount = shouldIncrement ? await redis.incr(key) : Number((await redis.get(key)) ?? 0);
  } catch {
    // Do not fail the song detail request when Redis is unavailable.
    currentCount = 0;
  }
  const approvedTranslationsByLanguage = await getLatestApprovedTranslationsByLanguage(songId);

  return {
    ...song,
    latestApprovedTranslations: approvedTranslationsByLanguage,
    viewCount: song.views + currentCount,
  };
};

export const getSongsByLanguage = async (languageCode: string, limit?: number) => {
  const normalizedCode = languageCode.trim().toLowerCase();
  const take = normalizeLimit(limit);

  const songs = await prisma.song.findMany({
    where: {
      songLanguages: {
        some: {
          languageCode: normalizedCode,
          percentage: { gte: 30 },
        },
      },
    },
    include: songInclude as Prisma.SongInclude,
    orderBy: { createdAt: 'desc' },
    take,
  });

  const activeSongIds = await getActiveSongIdSet(songs.map((song) => song.id));
  return songs.filter((song) => activeSongIds.has(song.id));
};

export const getSongTranslations = async (songId: string) => {
  const active = await isSongActive(songId);
  if (!active) {
    throw new ApiError('Song not found', 'NOT_FOUND', 404);
  }

  return prisma.translation.findMany({
    where: { songId },
    orderBy: { createdAt: 'desc' },
  });
};

const ensureArtistExists = async (artistId: string) => {
  const active = await isArtistActive(artistId);
  if (!active) {
    throw new ApiError('Artist not found', 'NOT_FOUND', 404);
  }
};

const syncGenres = async (songId: string, genres: string[] | undefined) => {
  if (!genres) {
    return;
  }

  await prisma.songGenre.deleteMany({ where: { songId } });

  const normalizedGenres = [...new Set(genres.map((item) => item.trim()).filter(Boolean))];

  for (const genreName of normalizedGenres) {
    const genre = await prisma.genre.upsert({
      where: { name: genreName },
      create: { name: genreName },
      update: {},
    });

    await prisma.songGenre.create({
      data: {
        songId,
        genreId: genre.id,
      },
    });
  }
};

const syncLanguages = async (songId: string, languages: string[] | undefined, primaryLanguage?: string | null) => {
  if (!languages && !primaryLanguage) {
    return;
  }

  const allLanguages = [
    ...(languages ?? []),
    ...(primaryLanguage ? [primaryLanguage] : []),
  ]
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const deduped = [...new Set(allLanguages)];
  if (deduped.length === 0) {
    return;
  }

  await prisma.songLanguage.deleteMany({ where: { songId } });

  const defaultPercentage = Number((100 / deduped.length).toFixed(2));

  for (const languageCode of deduped) {
    await prisma.language.upsert({
      where: { code: languageCode },
      create: {
        code: languageCode,
        name: languageCode.toUpperCase(),
      },
      update: {},
    });

    await prisma.songLanguage.create({
      data: {
        songId,
        languageCode,
        percentage: defaultPercentage,
      },
    });
  }
};

export const createSong = async (payload: SongMutationInput) => {
  await ensureArtistExists(payload.artistId);

  const created = await prisma.song.create({
    data: {
      title: payload.title.trim(),
      artistId: payload.artistId,
      albumName: payload.albumName ?? null,
      releaseYear: payload.releaseYear ?? null,
      spotifyId: payload.spotifyId ?? null,
      imageUrl: payload.coverImageUrl ?? payload.imageUrl ?? null,
    },
  });

  await Promise.all([
    syncGenres(created.id, payload.genres),
    syncLanguages(created.id, payload.languages, payload.primaryLanguage),
    payload.lyrics ? upsertLyrics(created.id, payload.lyrics) : Promise.resolve(),
  ]);

  await lyricsEnrichmentQueue.add(
    'enrichLyrics',
    { songId: created.id },
    {
      delay: 1000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
      jobId: `lyrics-enrichment-${created.id}`,
    },
  );

  await enqueueIndexSong(created.id);

  const latestLyrics = await getLatestLyricsContent(created.id);
  if (latestLyrics) {
    await enqueueLanguageCategorization(created.id, latestLyrics);
  }

  return getSongById(created.id, { incrementViewCount: false });
};

export const updateSong = async (songId: string, payload: Partial<SongMutationInput>) => {
  const existing = await isSongActive(songId);
  if (!existing) {
    throw new ApiError('Song not found', 'NOT_FOUND', 404);
  }

  if (payload.artistId) {
    await ensureArtistExists(payload.artistId);
  }

  await prisma.song.update({
    where: { id: songId },
    data: {
      ...(payload.title !== undefined ? { title: payload.title.trim() } : {}),
      ...(payload.artistId !== undefined ? { artistId: payload.artistId } : {}),
      ...(payload.albumName !== undefined ? { albumName: payload.albumName } : {}),
      ...(payload.releaseYear !== undefined ? { releaseYear: payload.releaseYear } : {}),
      ...(payload.spotifyId !== undefined ? { spotifyId: payload.spotifyId } : {}),
      ...(payload.coverImageUrl !== undefined || payload.imageUrl !== undefined
        ? { imageUrl: payload.coverImageUrl ?? payload.imageUrl ?? null }
        : {}),
    },
  });

  await Promise.all([
    syncGenres(songId, payload.genres),
    syncLanguages(songId, payload.languages, payload.primaryLanguage),
    payload.lyrics ? upsertLyrics(songId, payload.lyrics) : Promise.resolve(),
  ]);

  if (payload.lyrics) {
    const latestLyrics = await getLatestLyricsContent(songId);
    if (latestLyrics) {
      await enqueueLanguageCategorization(songId, latestLyrics);
    }
  }

  await enqueueIndexSong(songId);

  return getSongById(songId, { incrementViewCount: false });
};

export const softDeleteSong = async (songId: string) => {
  const existing = await isSongActive(songId);
  if (!existing) {
    throw new ApiError('Song not found', 'NOT_FOUND', 404);
  }

  await prisma.$executeRaw`
    UPDATE "Song"
    SET "softDeleted" = true,
        "updatedAt" = NOW()
    WHERE "id" = ${songId}
  `;

  await takedownLyrics(songId);

  await enqueueIndexSong(songId);

  return { success: true, songId };
};
