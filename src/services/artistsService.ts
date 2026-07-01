import { Prisma } from '@prisma/client';
import { enqueueIndexArtist } from '../jobs/searchIndexJob';
import { prisma } from '../lib/prisma';
import { ApiError } from '../middleware/errorHandler';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface ArtistListParams {
  cursor?: string;
  limit?: number;
  genre?: string;
  search?: string;
}

interface ArtistInput {
  name: string;
  bio?: string | null;
  imageUrl?: string | null;
  spotifyId?: string | null;
  genres?: string[];
  popularity?: number;
  followers?: number;
  externalUrl?: string | null;
  verified?: boolean;
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

const buildArtistWhere = (params: ArtistListParams): Prisma.ArtistWhereInput => {
  return {
    ...(params.genre
      ? {
          genres: {
            has: params.genre,
          },
        }
      : {}),
    ...(params.search
      ? {
          name: {
            contains: params.search.trim(),
            mode: Prisma.QueryMode.insensitive,
          },
        }
      : {}),
  };
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

const getActiveArtistIdSet = async (artistIds: string[]): Promise<Set<string>> => {
  if (artistIds.length === 0) {
    return new Set();
  }

  try {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Artist"
      WHERE "id" = ANY(${artistIds})
        AND COALESCE("softDeleted", false) = false
    `;

    return new Set(rows.map((row) => row.id));
  } catch (error) {
    if (!isMissingSoftDeleteColumnError(error)) {
      throw error;
    }

    return new Set(artistIds);
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

export const listArtists = async (params: ArtistListParams) => {
  const limit = normalizeLimit(params.limit);
  const where = buildArtistWhere(params);

  const rows = await prisma.artist.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    take: limit + 1,
    include: {
      _count: {
        select: {
          songs: true,
        },
      },
    } as Prisma.ArtistInclude,
  });

  const activeArtistIds = await getActiveArtistIdSet(rows.map((artist) => artist.id));
  const visibleRows = rows.filter((artist) => activeArtistIds.has(artist.id));

  const hasNext = visibleRows.length > limit;
  const data = hasNext ? visibleRows.slice(0, limit) : visibleRows;
  const nextCursor = hasNext ? data[data.length - 1]?.id ?? null : null;
  let total = 0;
  try {
    const totalRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "Artist" a
      WHERE COALESCE(a."softDeleted", false) = false
        AND (${params.genre ?? null}::text IS NULL OR ${params.genre ?? null} = ANY(a."genres"))
        AND (${params.search ?? null}::text IS NULL OR LOWER(a."name") LIKE '%' || LOWER(${params.search ?? null}) || '%')
    `;
    total = Number(totalRows[0]?.count ?? 0);
  } catch (error) {
    if (!isMissingSoftDeleteColumnError(error)) {
      throw error;
    }

    total = await prisma.artist.count({ where });
  }

  return {
    data,
    nextCursor,
    total,
  };
};

export const getArtistById = async (artistId: string) => {
  const activeArtist = await isArtistActive(artistId);
  if (!activeArtist) {
    throw new ApiError('Artist not found', 'NOT_FOUND', 404);
  }

  const artist = await prisma.artist.findFirst({
    where: {
      id: artistId,
    },
    include: {
      _count: {
        select: {
          songs: true,
        },
      },
      songs: {
        orderBy: [
          { views: 'desc' },
          { requestCount: 'desc' },
          { createdAt: 'desc' },
        ],
        take: 5,
      },
    } as Prisma.ArtistInclude,
  });

  if (!artist) {
    throw new ApiError('Artist not found', 'NOT_FOUND', 404);
  }

  const activeSongIds = await getActiveSongIdSet(artist.songs.map((song) => song.id));
  const topSongs = artist.songs.filter((song) => activeSongIds.has(song.id));
  const songCount = (artist._count as { songs: number }).songs;

  return {
    ...artist,
    songCount,
    topSongs,
  };
};

export const createArtist = async (payload: ArtistInput) => {
  const artist = await prisma.artist.create({
    data: {
      name: payload.name.trim(),
      bio: payload.bio ?? null,
      imageUrl: payload.imageUrl ?? null,
      spotifyId: payload.spotifyId ?? null,
      genres: payload.genres ?? [],
      popularity: payload.popularity ?? 0,
      followers: payload.followers ?? 0,
      externalUrl: payload.externalUrl ?? null,
      verified: payload.verified ?? false,
    },
  });

  await enqueueIndexArtist(artist.id);

  return artist;
};

export const updateArtist = async (artistId: string, payload: Partial<ArtistInput>) => {
  const existing = await isArtistActive(artistId);
  if (!existing) {
    throw new ApiError('Artist not found', 'NOT_FOUND', 404);
  }

  const updated = await prisma.artist.update({
    where: { id: artistId },
    data: {
      ...(payload.name !== undefined ? { name: payload.name.trim() } : {}),
      ...(payload.bio !== undefined ? { bio: payload.bio } : {}),
      ...(payload.imageUrl !== undefined ? { imageUrl: payload.imageUrl } : {}),
      ...(payload.spotifyId !== undefined ? { spotifyId: payload.spotifyId } : {}),
      ...(payload.genres !== undefined ? { genres: payload.genres } : {}),
      ...(payload.popularity !== undefined ? { popularity: payload.popularity } : {}),
      ...(payload.followers !== undefined ? { followers: payload.followers } : {}),
      ...(payload.externalUrl !== undefined ? { externalUrl: payload.externalUrl } : {}),
      ...(payload.verified !== undefined ? { verified: payload.verified } : {}),
    },
  });

  await enqueueIndexArtist(artistId);

  return updated;
};

export const softDeleteArtist = async (artistId: string) => {
  const existing = await isArtistActive(artistId);
  if (!existing) {
    throw new ApiError('Artist not found', 'NOT_FOUND', 404);
  }

  await prisma.$executeRaw`
    UPDATE "Artist"
    SET "softDeleted" = true,
        "updatedAt" = NOW()
    WHERE "id" = ${artistId}
  `;

  await enqueueIndexArtist(artistId);

  return { success: true, artistId };
};
