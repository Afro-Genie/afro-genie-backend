import { createHash } from 'node:crypto';
import { enqueueIndexArtist, enqueueIndexSong, enqueueRefreshGenre } from '../jobs/searchIndexJob';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { syncQueue } from '../lib/queue';
import { findArtistGenreLookup, findSongGenreLookup } from './genreProviders/musicBrainzProvider';

export type GenreBackfillScope = 'missing' | 'missed' | 'all';
export type GenreBackfillTargetKind = 'song' | 'artist';

export interface GenreBackfillTarget {
  kind: GenreBackfillTargetKind;
  id: string;
  label: string;
  secondaryLabel: string;
  missedAt: Date | null;
}

export type GenreEnrichmentOutcome = 'populated' | 'miss' | 'already-populated' | 'not-found';

const scopeWhere = (scope: GenreBackfillScope) => (
  scope === 'all' ? {} : { genreBackfillMissedAt: scope === 'missed' ? { not: null } : null }
);

const normalizeGenreNames = (genres: readonly string[]): string[] =>
  [...new Set(genres.map((genre) => genre.trim()).filter(Boolean))].slice(0, 4);

export async function getGenreBackfillTargets(scope: GenreBackfillScope = 'missing'): Promise<GenreBackfillTarget[]> {
  const [songs, artists] = await Promise.all([
    prisma.song.findMany({
      where: {
        softDeleted: false,
        genres: { none: {} },
        ...scopeWhere(scope),
      },
      select: {
        id: true,
        title: true,
        albumName: true,
        genreBackfillMissedAt: true,
        artist: { select: { name: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.artist.findMany({
      where: {
        softDeleted: false,
        genres: { isEmpty: true },
        ...scopeWhere(scope),
      },
      select: {
        id: true,
        name: true,
        genreBackfillMissedAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  ]);

  return [
    ...songs.map((song) => ({
      kind: 'song' as const,
      id: song.id,
      label: song.title,
      secondaryLabel: song.artist.name,
      missedAt: song.genreBackfillMissedAt,
    })),
    ...artists.map((artist) => ({
      kind: 'artist' as const,
      id: artist.id,
      label: artist.name,
      secondaryLabel: 'Artist',
      missedAt: artist.genreBackfillMissedAt,
    })),
  ];
}

export async function getGenreBackfillCoverage(
  candidates?: GenreBackfillTarget[],
  scope: GenreBackfillScope = 'missing',
) {
  const [songsWithGenres, songsMissingGenres, artistsWithGenres, artistsMissingGenres, songsMissed, artistsMissed] = await Promise.all([
    prisma.song.count({ where: { softDeleted: false, genres: { some: {} } } }),
    prisma.song.count({ where: { softDeleted: false, genres: { none: {} } } }),
    prisma.artist.count({ where: { softDeleted: false, genres: { isEmpty: false } } }),
    prisma.artist.count({ where: { softDeleted: false, genres: { isEmpty: true } } }),
    prisma.song.count({ where: { softDeleted: false, genres: { none: {} }, genreBackfillMissedAt: { not: null } } }),
    prisma.artist.count({ where: { softDeleted: false, genres: { isEmpty: true }, genreBackfillMissedAt: { not: null } } }),
  ]);
  const targets = candidates ?? await getGenreBackfillTargets(scope);

  return {
    songsWithGenres,
    songsMissingGenres,
    artistsWithGenres,
    artistsMissingGenres,
    songsMissed,
    artistsMissed,
    songEligible: targets.filter((target) => target.kind === 'song').length,
    artistEligible: targets.filter((target) => target.kind === 'artist').length,
    eligible: targets.length,
    scope,
  };
}

export async function getMissedGenreBackfillTargets(params: {
  limit: number;
  page: number;
  search?: string;
}) {
  const search = params.search?.trim();
  const songWhere = {
    softDeleted: false,
    genres: { none: {} },
    genreBackfillMissedAt: { not: null },
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' as const } },
            { artist: { name: { contains: search, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };
  const artistWhere = {
    softDeleted: false,
    genres: { isEmpty: true },
    genreBackfillMissedAt: { not: null },
    ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
  };

  const [songs, artists, songTotal, artistTotal] = await Promise.all([
    prisma.song.findMany({
      where: songWhere,
      select: {
        id: true,
        title: true,
        genreBackfillMissedAt: true,
        artist: { select: { name: true } },
      },
      orderBy: [{ genreBackfillMissedAt: 'desc' }, { createdAt: 'asc' }],
    }),
    prisma.artist.findMany({
      where: artistWhere,
      select: { id: true, name: true, genreBackfillMissedAt: true },
      orderBy: [{ genreBackfillMissedAt: 'desc' }, { createdAt: 'asc' }],
    }),
    prisma.song.count({ where: songWhere }),
    prisma.artist.count({ where: artistWhere }),
  ]);

  const items = [
    ...songs.map((song) => ({
      kind: 'song' as const,
      id: song.id,
      label: song.title,
      secondaryLabel: song.artist.name,
      missedAt: song.genreBackfillMissedAt,
    })),
    ...artists.map((artist) => ({
      kind: 'artist' as const,
      id: artist.id,
      label: artist.name,
      secondaryLabel: 'Artist',
      missedAt: artist.genreBackfillMissedAt,
    })),
  ]
    .sort((a, b) => Date.parse(String(b.missedAt ?? 0)) - Date.parse(String(a.missedAt ?? 0)))
    .slice((params.page - 1) * params.limit, params.page * params.limit);

  return { items, total: songTotal + artistTotal, page: params.page, limit: params.limit };
}

export function hashGenreBackfillTargets(targets: readonly GenreBackfillTarget[]): string {
  return createHash('sha256')
    .update(targets.map((target) => `${target.kind}:${target.id}`).sort().join('\n'))
    .digest('hex');
}

export async function enqueueGenreEnrichment(input: { songId?: string; artistId?: string }): Promise<void> {
  const id = input.songId ?? input.artistId;
  if (!id) return;
  const key = input.songId ? `song-${input.songId}` : `artist-${input.artistId}`;
  await syncQueue.add(
    'genre-enrichment',
    {
      type: 'genre-enrichment',
      songId: input.songId,
      artistId: input.artistId,
    },
    {
      jobId: `genre-enrichment-${key}`,
      delay: 1000,
      attempts: 1,
      removeOnComplete: 500,
      removeOnFail: 200,
    },
  );
}

async function applySongGenres(songId: string, genres: readonly string[], replace: boolean): Promise<string[]> {
  const names = normalizeGenreNames(genres);
  if (names.length === 0) return [];

  const previous = await prisma.songGenre.findMany({
    where: { songId },
    select: { genreId: true },
  });
  const previousIds = previous.map((row) => row.genreId);
  if (replace) {
    await prisma.songGenre.deleteMany({ where: { songId } });
  }

  const nextIds: string[] = [];
  for (const genreName of names) {
    const genre = await prisma.genre.upsert({
      where: { name: genreName },
      create: { name: genreName },
      update: {},
      select: { id: true },
    });
    nextIds.push(genre.id);
  }
  await prisma.songGenre.createMany({
    data: nextIds.map((genreId) => ({ songId, genreId })),
    skipDuplicates: true,
  });

  return replace ? [...new Set([...previousIds, ...nextIds])] : nextIds;
}

async function setSongMusicBrainzId(songId: string, musicBrainzId: string | null): Promise<void> {
  if (!musicBrainzId) return;
  try {
    await prisma.song.update({ where: { id: songId }, data: { musicBrainzId } });
  } catch (error) {
    logger.warn({ err: error, songId, musicBrainzId }, 'Could not persist MusicBrainz recording ID');
  }
}

async function setArtistMusicBrainzId(artistId: string, musicBrainzId: string | null): Promise<void> {
  if (!musicBrainzId) return;
  try {
    await prisma.artist.update({ where: { id: artistId }, data: { musicBrainzId } });
  } catch (error) {
    logger.warn({ err: error, artistId, musicBrainzId }, 'Could not persist MusicBrainz artist ID');
  }
}

async function refreshSongSearch(songId: string, genreIds: string[]): Promise<void> {
  await enqueueIndexSong(songId).catch(() => undefined);
  await Promise.all(genreIds.map((genreId) => enqueueRefreshGenre(genreId).catch(() => undefined)));
}

export async function enrichSongGenres(songId: string, replace = false): Promise<GenreEnrichmentOutcome> {
  const song = await prisma.song.findUnique({
    where: { id: songId },
    select: {
      id: true,
      title: true,
      albumName: true,
      musicBrainzId: true,
      genreBackfillMissedAt: true,
      artistId: true,
      artist: { select: { name: true, genres: true } },
      genres: { select: { genreId: true } },
    },
  });
  if (!song) return 'not-found';

  if (song.genres.length > 0 && !replace) {
    if (song.genreBackfillMissedAt) {
      await prisma.song.update({ where: { id: songId }, data: { genreBackfillMissedAt: null } });
    }
    return 'already-populated';
  }

  const lookup = await findSongGenreLookup(song.artist.name, song.title, song.albumName);
  if (!lookup) {
    await prisma.song.update({ where: { id: songId }, data: { genreBackfillMissedAt: new Date() } });
    return 'miss';
  }

  await setSongMusicBrainzId(songId, lookup.musicBrainzId);
  if (lookup.artistMusicBrainzId) {
    await setArtistMusicBrainzId(song.artistId, lookup.artistMusicBrainzId);
  }
  if (lookup.artistGenres.length > 0 && song.artist.genres.length === 0) {
    await prisma.artist.update({
      where: { id: song.artistId },
      data: {
        genres: normalizeGenreNames(lookup.artistGenres),
        genreBackfillMissedAt: null,
        genreBackfillAt: new Date(),
      },
    });
    await enqueueIndexArtist(song.artistId).catch(() => undefined);
  }

  const genres = lookup.genres.length > 0 ? lookup.genres : lookup.artistGenres;
  if (genres.length === 0) {
    await prisma.song.update({ where: { id: songId }, data: { genreBackfillMissedAt: new Date() } });
    return 'miss';
  }

  const genreIds = await applySongGenres(songId, genres, replace);
  await prisma.song.update({
    where: { id: songId },
    data: { genreBackfillMissedAt: null, genreBackfillAt: new Date() },
  });
  await refreshSongSearch(songId, genreIds);
  return 'populated';
}

export async function enrichArtistGenres(artistId: string, replace = false): Promise<GenreEnrichmentOutcome> {
  const artist = await prisma.artist.findUnique({
    where: { id: artistId },
    select: {
      id: true,
      name: true,
      genres: true,
      musicBrainzId: true,
      genreBackfillMissedAt: true,
    },
  });
  if (!artist) return 'not-found';

  if (artist.genres.length > 0 && !replace) {
    if (artist.genreBackfillMissedAt) {
      await prisma.artist.update({ where: { id: artistId }, data: { genreBackfillMissedAt: null } });
    }
    return 'already-populated';
  }

  const lookup = await findArtistGenreLookup(artist.name);
  await setArtistMusicBrainzId(artistId, lookup?.musicBrainzId ?? null);

  if (!lookup || lookup.genres.length === 0) {
    await prisma.artist.update({ where: { id: artistId }, data: { genreBackfillMissedAt: new Date() } });
    return 'miss';
  }

  const genres = normalizeGenreNames(lookup.genres);
  const nextGenres = replace || artist.genres.length === 0
    ? genres
    : [...new Set([...artist.genres, ...genres])].slice(0, 4);
  await prisma.artist.update({
    where: { id: artistId },
    data: {
      genres: nextGenres,
      genreBackfillMissedAt: null,
      genreBackfillAt: new Date(),
    },
  });
  await enqueueIndexArtist(artistId).catch(() => undefined);
  for (const genreName of genres) {
    const genre = await prisma.genre.findUnique({ where: { name: genreName }, select: { id: true } });
    if (genre) await enqueueRefreshGenre(genre.id).catch(() => undefined);
  }
  return 'populated';
}
