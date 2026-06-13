import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LicenseStatus, LyricSourceProvider, PrismaClient } from '@prisma/client';

interface FirebaseArtist {
  id?: string;
  name?: string;
  bio?: string;
  imageUrl?: string;
  spotifyId?: string;
  genres?: string[];
}

interface FirebaseSong {
  id?: string;
  title?: string;
  artistId?: string;
  albumName?: string;
  releaseYear?: number;
  spotifyId?: string;
  imageUrl?: string;
  genres?: string[];
  languages?: Array<{ languageCode?: string; percentage?: number }>;
}

interface FirebaseLyric {
  id?: string;
  songId?: string;
  content?: string;
  sourceProvider?: keyof typeof LyricSourceProvider;
  licenseStatus?: keyof typeof LicenseStatus;
}

interface FirebaseExport {
  artists?: FirebaseArtist[] | Record<string, FirebaseArtist>;
  songs?: FirebaseSong[] | Record<string, FirebaseSong>;
  lyrics?: FirebaseLyric[] | Record<string, FirebaseLyric>;
}

const prisma = new PrismaClient();

const toArray = <T>(value: T[] | Record<string, T> | undefined): T[] => {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : Object.values(value);
};

const parseProvider = (value?: string): LyricSourceProvider => {
  if (!value) {
    return LyricSourceProvider.MANUAL;
  }

  if (value in LyricSourceProvider) {
    return value as LyricSourceProvider;
  }

  return LyricSourceProvider.MANUAL;
};

const parseLicenseStatus = (value?: string): LicenseStatus => {
  if (!value) {
    return LicenseStatus.UNKNOWN;
  }

  if (value in LicenseStatus) {
    return value as LicenseStatus;
  }

  return LicenseStatus.UNKNOWN;
};

const getArg = (name: string): string | undefined => {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
};

const run = async () => {
  const fileArg = getArg('file') ?? getArg('input');

  if (!fileArg) {
    throw new Error('Missing --file argument. Example: tsx scripts/migrateFromFirebase.ts --file ./firebase-export.json');
  }

  const absolutePath = resolve(process.cwd(), fileArg);
  const raw = await readFile(absolutePath, 'utf8');
  const parsed = JSON.parse(raw) as FirebaseExport;

  const artists = toArray(parsed.artists);
  const songs = toArray(parsed.songs);
  const lyrics = toArray(parsed.lyrics);

  const artistIdMap = new Map<string, string>();
  const songIdMap = new Map<string, string>();

  console.log(`Starting migration from ${absolutePath}`);
  console.log(`Artists: ${artists.length}, Songs: ${songs.length}, Lyrics: ${lyrics.length}`);

  for (const artist of artists) {
    const sourceId = artist.id ?? `artist:${artist.name ?? 'unknown'}`;

    try {
      if (!artist.name || !artist.name.trim()) {
        throw new Error('Missing artist name');
      }

      const created = await prisma.artist.upsert({
        where: { name: artist.name.trim() },
        update: {
          bio: artist.bio ?? null,
          imageUrl: artist.imageUrl ?? null,
          spotifyId: artist.spotifyId ?? null,
          genres: artist.genres ?? [],
        },
        create: {
          name: artist.name.trim(),
          bio: artist.bio ?? null,
          imageUrl: artist.imageUrl ?? null,
          spotifyId: artist.spotifyId ?? null,
          genres: artist.genres ?? [],
        },
      });

      artistIdMap.set(sourceId, created.id);
      console.log(`[artist] success source=${sourceId} target=${created.id}`);
    } catch (error) {
      console.error(`[artist] failed source=${sourceId}`, error);
    }
  }

  for (const song of songs) {
    const sourceId = song.id ?? `song:${song.title ?? 'unknown'}`;

    try {
      if (!song.title || !song.title.trim()) {
        throw new Error('Missing song title');
      }

      const mappedArtistId = song.artistId ? artistIdMap.get(song.artistId) : undefined;
      const artistId = mappedArtistId ?? song.artistId;

      if (!artistId) {
        throw new Error('Missing artistId mapping');
      }

      const created = await prisma.song.upsert({
        where: { title_artistId: { title: song.title.trim(), artistId } },
        update: {
          albumName: song.albumName ?? null,
          releaseYear: song.releaseYear ?? null,
          spotifyId: song.spotifyId ?? null,
          imageUrl: song.imageUrl ?? null,
        },
        create: {
          title: song.title.trim(),
          artistId,
          albumName: song.albumName ?? null,
          releaseYear: song.releaseYear ?? null,
          spotifyId: song.spotifyId ?? null,
          imageUrl: song.imageUrl ?? null,
        },
      });

      songIdMap.set(sourceId, created.id);

      if (Array.isArray(song.genres)) {
        await prisma.songGenre.deleteMany({ where: { songId: created.id } });

        for (const genreName of song.genres.map((item) => item.trim()).filter(Boolean)) {
          const genre = await prisma.genre.upsert({
            where: { name: genreName },
            update: {},
            create: { name: genreName },
          });

          await prisma.songGenre.create({
            data: {
              songId: created.id,
              genreId: genre.id,
            },
          });
        }
      }

      if (Array.isArray(song.languages)) {
        await prisma.songLanguage.deleteMany({ where: { songId: created.id } });

        for (const entry of song.languages) {
          const languageCode = entry.languageCode?.trim().toLowerCase();
          if (!languageCode) {
            continue;
          }

          await prisma.language.upsert({
            where: { code: languageCode },
            update: {},
            create: {
              code: languageCode,
              name: languageCode.toUpperCase(),
            },
          });

          await prisma.songLanguage.upsert({
            where: {
              songId_languageCode: {
                songId: created.id,
                languageCode,
              },
            },
            update: {
              percentage: entry.percentage ?? 0,
            },
            create: {
              songId: created.id,
              languageCode,
              percentage: entry.percentage ?? 0,
            },
          });
        }
      }

      console.log(`[song] success source=${sourceId} target=${created.id}`);
    } catch (error) {
      console.error(`[song] failed source=${sourceId}`, error);
    }
  }

  for (const lyric of lyrics) {
    const sourceId = lyric.id ?? `lyric:${lyric.songId ?? 'unknown'}`;

    try {
      const mappedSongId = lyric.songId ? songIdMap.get(lyric.songId) : undefined;
      const songId = mappedSongId ?? lyric.songId;

      if (!songId) {
        throw new Error('Missing songId mapping');
      }

      await prisma.lyric.create({
        data: {
          songId,
          content: lyric.content ?? null,
          sourceProvider: parseProvider(lyric.sourceProvider),
          licenseStatus: parseLicenseStatus(lyric.licenseStatus),
        },
      });

      console.log(`[lyric] success source=${sourceId} targetSong=${songId}`);
    } catch (error) {
      console.error(`[lyric] failed source=${sourceId}`, error);
    }
  }

  console.log('Firebase migration completed');
};

run()
  .catch((error) => {
    console.error('Firebase migration failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
