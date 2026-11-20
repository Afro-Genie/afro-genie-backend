import { Prisma, TranslationStatus } from '@prisma/client';
import { enqueueIndexSong } from '../jobs/searchIndexJob';
import { indexSong } from '../services/searchService';
import { enqueueLanguageCategorization } from '../jobs/languageCategorizationJob';
import { lyricsEnrichmentQueue } from '../lib/queue';
import { redis } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { invalidatePlaybackSourceCache } from '../lib/playbackCache';
import { ApiError } from '../middleware/errorHandler';
import { getLatestLyricsContent, takedownLyrics, upsertLyrics, type LyricsInput } from './lyricsService';
import { validateManualAfricanSongGenres } from './youtubeCatalogPolicy';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;

const VIEW_COUNT_TTL_SECONDS = 6 * 60 * 60;

type SortBy = 'views' | 'popularity' | 'createdAt' | 'title' | 'artist' | 'releaseYear';
type SortOrder = 'asc' | 'desc';

interface SongFilters {
  language?: string;
  lang?: string;
  genre?: string;
  artistId?: string;
  artistName?: string;
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
  if (
    sortBy === 'views' ||
    sortBy === 'popularity' ||
    sortBy === 'createdAt' ||
    sortBy === 'title' ||
    sortBy === 'artist' ||
    sortBy === 'releaseYear'
  ) {
    return sortBy;
  }

  return 'createdAt';
};

const normalizeSortOrder = (sortOrder?: string): SortOrder => {
  return sortOrder === 'asc' ? 'asc' : 'desc';
};

const buildOrderBy = (sortBy: SortBy, sortOrder: SortOrder): Prisma.SongOrderByWithRelationInput[] => {
  if (sortBy === 'popularity') {
    return [{ requestCount: sortOrder }, { id: sortOrder }];
  }

  if (sortBy === 'views') {
    return [{ views: sortOrder }, { id: sortOrder }];
  }

  if (sortBy === 'title') {
    return [{ title: sortOrder }, { id: sortOrder }];
  }

  if (sortBy === 'artist') {
    return [{ artist: { name: sortOrder } }, { id: sortOrder }];
  }

  if (sortBy === 'releaseYear') {
    return [{ releaseYear: { sort: sortOrder, nulls: 'last' } }, { id: sortOrder }];
  }

  return [{ createdAt: sortOrder }, { id: sortOrder }];
};

// Postgres sorts NULLs first on DESC, so ordering by youtubeVideoId in SQL
// ranks unplayable songs ahead of playable ones. Group in JS instead:
// playable (youtubeVideoId set) first, requested sort applied within each group.
const rankPlayableFirst = <T extends { youtubeVideoId?: string | null }>(
  rows: T[],
  compareSecondary: (a: T, b: T) => number
): T[] => {
  return [...rows].sort((a, b) => {
    const aPlayable = a.youtubeVideoId ? 1 : 0;
    const bPlayable = b.youtubeVideoId ? 1 : 0;
    if (aPlayable !== bPlayable) return bPlayable - aPlayable;
    return compareSecondary(a, b);
  });
};

const buildSecondaryComparator = (sortBy: SortBy, sortOrder: SortOrder) => {
  const direction = sortOrder === 'asc' ? 1 : -1;

  if (sortBy === 'title') {
    return (a: { title?: string }, b: { title?: string }) =>
      (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' }) * direction;
  }

  if (sortBy === 'artist') {
    return (a: { artist?: { name?: string } }, b: { artist?: { name?: string } }) =>
      (a.artist?.name ?? '').localeCompare(b.artist?.name ?? '', undefined, { sensitivity: 'base' }) * direction;
  }

  if (sortBy === 'releaseYear') {
    return (a: { releaseYear?: number | null }, b: { releaseYear?: number | null }) =>
      ((a.releaseYear ?? 0) - (b.releaseYear ?? 0)) * direction;
  }

  if (sortBy === 'views') {
    return (a: { views?: number }, b: { views?: number }) => ((a.views ?? 0) - (b.views ?? 0)) * direction;
  }

  if (sortBy === 'popularity') {
    return (a: { requestCount?: number }, b: { requestCount?: number }) =>
      ((a.requestCount ?? 0) - (b.requestCount ?? 0)) * direction;
  }

  return (a: { createdAt?: Date | string }, b: { createdAt?: Date | string }) =>
    (new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()) * direction;
};

const buildSongWhere = (filters: SongFilters): Prisma.SongWhereInput => {
  const languageCode = (filters.language ?? filters.lang)?.trim().toLowerCase();

  return {
    artist: { suspended: false },
    AND: [
      {
        OR: [
          { audioUrl: null },
          { released: true },
        ],
      },
    ],
    ...(filters.artistId ? { artistId: filters.artistId } : {}),
    ...(filters.artistName?.trim()
      ? {
          artist: {
            name: {
              contains: filters.artistName.trim(),
              mode: Prisma.QueryMode.insensitive,
            },
            suspended: false,
          },
        }
      : {}),
    ...(filters.search
      ? {
          OR: [
            { title: { contains: filters.search.trim(), mode: Prisma.QueryMode.insensitive } },
            { artist: { name: { contains: filters.search.trim(), mode: Prisma.QueryMode.insensitive } } },
            {
              genres: {
                some: {
                  genre: { name: { contains: filters.search.trim(), mode: Prisma.QueryMode.insensitive } },
                },
              },
            },
          ],
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
    const song = await prisma.song.findFirst({
      where: {
        id: songId,
        softDeleted: false,
        OR: [
          { audioUrl: null },
          { released: true },
        ],
      },
      select: { id: true },
    });
    return !!song;
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
    const artist = await prisma.artist.findFirst({
      where: { id: artistId, softDeleted: false },
      select: { id: true },
    });
    return !!artist;
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
    const rows = await prisma.song.findMany({
      where: {
        id: { in: songIds },
        softDeleted: false,
        artist: { suspended: false },
        OR: [
          { audioUrl: null },
          { released: true },
        ],
      },
      select: { id: true },
    });
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

  let total: number;
  let visibleWhere: Prisma.SongWhereInput = { ...where, softDeleted: false };
  try {
    total = await prisma.song.count({ where: visibleWhere });
  } catch (error) {
    if (!isMissingSoftDeleteColumnError(error)) {
      throw error;
    }

    visibleWhere = where;
    total = await prisma.song.count({ where });
  }

  let pageKeys: Array<{ id: string }>;
  let nextCursor: string | null = null;

  if (cursor) {
    const rows = await prisma.song.findMany({
      where: visibleWhere,
      select: {
        id: true,
        youtubeVideoId: true,
        views: true,
        requestCount: true,
        createdAt: true,
        title: true,
        releaseYear: true,
        artist: { select: { name: true } },
      },
      orderBy,
    });
    const ordered = rankPlayableFirst(rows, buildSecondaryComparator(sortBy, sortOrder));
    const cursorIndex = ordered.findIndex((row) => row.id === cursor);
    const slice = cursorIndex >= 0 ? ordered.slice(cursorIndex + 1, cursorIndex + 1 + limit + 1) : [];
    const hasNext = slice.length > limit;
    pageKeys = (hasNext ? slice.slice(0, limit) : slice).map(({ id }) => ({ id }));
    nextCursor = hasNext ? pageKeys[pageKeys.length - 1]?.id ?? null : null;
  } else {
    const offset = (page - 1) * limit;
    const playableWhere = { ...visibleWhere, youtubeVideoId: { not: null } };
    const unplayableWhere = { ...visibleWhere, youtubeVideoId: null };
    const playableCount = await prisma.song.count({ where: playableWhere });
    const requestedPlayable = Math.max(0, Math.min(limit, playableCount - offset));
    const playableRows = requestedPlayable
      ? await prisma.song.findMany({
          where: playableWhere,
          select: { id: true },
          orderBy,
          skip: Math.min(offset, playableCount),
          take: requestedPlayable,
        })
      : [];
    const remaining = limit - playableRows.length;
    const unplayableRows = remaining
      ? await prisma.song.findMany({
          where: unplayableWhere,
          select: { id: true },
          orderBy,
          skip: Math.max(0, offset - playableCount),
          take: remaining,
        })
      : [];
    pageKeys = [...playableRows, ...unplayableRows];
  }

  const rows = await prisma.song.findMany({
    where: { id: { in: pageKeys.map((row) => row.id) } },
    include: songInclude as Prisma.SongInclude,
  });
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const hydrated = pageKeys
    .map((key) => rowsById.get(key.id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return {
    songs: hydrated,
    data: hydrated,
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
    if (shouldIncrement && currentCount === 1) {
      // Safety TTL so view counters can't linger if the flush job ever lags.
      await redis.expire(key, VIEW_COUNT_TTL_SECONDS);
    }
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
  const artist = await prisma.artist.findUnique({
    where: { id: payload.artistId },
    select: { name: true, suspended: true },
  });
  if (!artist || artist.suspended) {
    throw new ApiError('Artist not found', 'NOT_FOUND', 404);
  }
  let approvedGenres: string[];
  try {
    approvedGenres = validateManualAfricanSongGenres(artist.name, payload.genres ?? []);
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : 'Manual song failed African-music policy validation.', 'AFRICAN_MUSIC_POLICY', 400);
  }

  const created = await prisma.song.create({
    data: {
      title: payload.title.trim(),
      artistId: payload.artistId,
      albumName: payload.albumName ?? null,
      releaseYear: payload.releaseYear ?? null,
      imageUrl: payload.coverImageUrl ?? payload.imageUrl ?? null,
    },
  });

  await Promise.all([
    syncGenres(created.id, approvedGenres),
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

  // Also index synchronously so the song appears in search immediately
  await indexSong(created.id);

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

  // 2.18 — the cached playback payload embeds the song's title/artist/cover, so
  // an edit leaves stale metadata in `playback:source:<id>` for up to an hour.
  await invalidatePlaybackSourceCache(songId);

  return getSongById(songId, { incrementViewCount: false });
};

export const softDeleteSong = async (songId: string) => {
  const existing = await isSongActive(songId);
  if (!existing) {
    throw new ApiError('Song not found', 'NOT_FOUND', 404);
  }

  await prisma.song.update({
    where: { id: songId },
    data: { softDeleted: true },
  });

  await takedownLyrics(songId);

  await enqueueIndexSong(songId);

  // 2.18/2.17 — must evict, not just rely on the `softDeleted: false` guard in
  // `getPlaybackSource()`: a live cache entry would keep serving a song that is
  // supposed to be hidden.
  await invalidatePlaybackSourceCache(songId);

  return { success: true, songId };
};
