import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LicenseStatus, LyricSourceProvider, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

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
  artistName?: string;
  artist?: string;
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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({
  adapter: new PrismaPg(pool),
});

const toArray = <T>(value: T[] | Record<string, T> | undefined): T[] => {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : Object.values(value);
};

const getArg = (name: string): string | undefined => {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
};

const normalizeString = (value?: string | null): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const resolveSongArtistId = (
  song: FirebaseSong,
  artistSourceMap: Map<string, FirebaseArtist>,
  artistDbIdByName: Map<string, string>,
): string | null => {
  const directName = normalizeString(song.artistName) ?? normalizeString(song.artist);
  if (directName) {
    return artistDbIdByName.get(directName.toLowerCase()) ?? null;
  }

  if (song.artistId) {
    const sourceArtist = artistSourceMap.get(song.artistId);
    if (sourceArtist?.name) {
      return artistDbIdByName.get(sourceArtist.name.trim().toLowerCase()) ?? null;
    }
  }

  return null;
};

const upsertLyricForSong = async (songId: string, content: string) => {
  const existing = await prisma.lyric.findFirst({ where: { songId } });

  if (existing) {
    await prisma.lyric.update({
      where: { id: existing.id },
      data: {
        content,
        sourceProvider: LyricSourceProvider.MANUAL,
        licenseStatus: LicenseStatus.UNKNOWN,
      },
    });
    return;
  }

  await prisma.lyric.create({
    data: {
      songId,
      content,
      sourceProvider: LyricSourceProvider.MANUAL,
      licenseStatus: LicenseStatus.UNKNOWN,
    },
  });
};

const run = async () => {
  const fileArg = getArg('file') ?? getArg('input');

  if (!fileArg) {
    console.log('No --file provided. Falling back to using the Prisma seed data instead.');
    console.log('Running: npx prisma db seed -- will populate artists, songs, lyrics and translations.');
    console.log('If you need to replay a Firebase export, pass --file ./path/to/export.json');
    return;
  }

  const absolutePath = resolve(process.cwd(), fileArg);
  const raw = await readFile(absolutePath, 'utf8');
  const parsed = JSON.parse(raw) as FirebaseExport;

  const artists = toArray(parsed.artists);
  const songs = toArray(parsed.songs);
  const lyrics = toArray(parsed.lyrics);

  const artistIdMap = new Map<string, string>();
  const songIdMap = new Map<string, string>();
  const artistSourceMap = new Map<string, FirebaseArtist>();
  const artistDbIdByName = new Map<string, string>();

  let artistSuccess = 0;
  let artistFailure = 0;
  let songSuccess = 0;
  let songFailure = 0;
  let lyricSuccess = 0;
  let lyricFailure = 0;

  console.log(`Starting migration from ${absolutePath}`);
  console.log(`Artists: ${artists.length}, Songs: ${songs.length}, Lyrics: ${lyrics.length}`);

  for (const [index, artist] of artists.entries()) {
    const sourceId = artist.id ?? `artist:${artist.name ?? 'unknown'}`;

    try {
      const name = normalizeString(artist.name);
      if (!name) {
        throw new Error('Missing artist name');
      }

      const created = await prisma.artist.upsert({
        where: { name },
        update: {
          bio: artist.bio ?? null,
          imageUrl: artist.imageUrl ?? null,
          spotifyId: artist.spotifyId ?? null,
          genres: artist.genres ?? [],
        },
        create: {
          name,
          bio: artist.bio ?? null,
          imageUrl: artist.imageUrl ?? null,
          spotifyId: artist.spotifyId ?? null,
          genres: artist.genres ?? [],
        },
      });

      artistIdMap.set(sourceId, created.id);
      artistDbIdByName.set(name.toLowerCase(), created.id);
      artistSourceMap.set(sourceId, artist);
      artistSuccess += 1;
      console.log(`[artist] success source=${sourceId} target=${created.id}`);
    } catch (error) {
      artistFailure += 1;
      console.error(`[artist] failed source=${sourceId}`, error);
    }

    if ((index + 1) % 10 === 0 || index + 1 === artists.length) {
      console.log(`[artist] progress ${index + 1}/${artists.length}`);
    }
  }

  for (const [index, song] of songs.entries()) {
    const sourceId = song.id ?? `song:${song.title ?? 'unknown'}`;

    try {
      const title = normalizeString(song.title);
      if (!title) {
        throw new Error('Missing song title');
      }

      const artistId = resolveSongArtistId(song, artistSourceMap, artistDbIdByName) ?? (song.artistId ? artistIdMap.get(song.artistId) : undefined);

      if (!artistId) {
        throw new Error(`Missing artist mapping for ${song.artistName ?? song.artist ?? song.artistId ?? sourceId}`);
      }

      const created = await prisma.song.upsert({
        where: { title_artistId: { title, artistId } },
        update: {
          albumName: song.albumName ?? null,
          releaseYear: song.releaseYear ?? null,
          spotifyId: song.spotifyId ?? null,
          imageUrl: song.imageUrl ?? null,
        },
        create: {
          title,
          artistId,
          albumName: song.albumName ?? null,
          releaseYear: song.releaseYear ?? null,
          spotifyId: song.spotifyId ?? null,
          imageUrl: song.imageUrl ?? null,
        },
      });

      songIdMap.set(sourceId, created.id);
      songSuccess += 1;

      if (Array.isArray(song.genres)) {
        await prisma.songGenre.deleteMany({ where: { songId: created.id } });

        for (const genreName of song.genres.map((item) => item.trim()).filter(Boolean)) {
          const genre = await prisma.genre.upsert({
            where: { name: genreName },
            update: {},
            create: { name: genreName },
          });

          await prisma.songGenre.upsert({
            where: {
              songId_genreId: {
                songId: created.id,
                genreId: genre.id,
              },
            },
            update: {},
            create: {
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
      songFailure += 1;
      console.error(`[song] failed source=${sourceId}`, error);
    }

    if ((index + 1) % 10 === 0 || index + 1 === songs.length) {
      console.log(`[song] progress ${index + 1}/${songs.length}`);
    }
  }

  for (const [index, lyric] of lyrics.entries()) {
    const sourceId = lyric.id ?? `lyric:${lyric.songId ?? 'unknown'}`;

    try {
      const mappedSongId = lyric.songId ? songIdMap.get(lyric.songId) : undefined;
      const songId = mappedSongId ?? lyric.songId;

      if (!songId) {
        throw new Error('Missing songId mapping');
      }

      const content = normalizeString(lyric.content);
      if (!content) {
        throw new Error('Missing lyric content');
      }

      await upsertLyricForSong(songId, content);

      console.log(`[lyric] success source=${sourceId} targetSong=${songId}`);
      lyricSuccess += 1;
    } catch (error) {
      lyricFailure += 1;
      console.error(`[lyric] failed source=${sourceId}`, error);
    }

    if ((index + 1) % 10 === 0 || index + 1 === lyrics.length) {
      console.log(`[lyric] progress ${index + 1}/${lyrics.length}`);
    }
  }

  console.log('Legacy migration completed');
  console.log(
    `Totals | artists=${artistSuccess}/${artists.length} failed=${artistFailure} | songs=${songSuccess}/${songs.length} failed=${songFailure} | lyrics=${lyricSuccess}/${lyrics.length} failed=${lyricFailure}`,
  );
};

run()
  .catch((error) => {
    console.error('Firebase migration failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
