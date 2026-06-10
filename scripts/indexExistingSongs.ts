import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import {
  bulkIndex,
  indexArtist,
  indexSong,
  refreshGenre
} from '../src/services/searchService';

const BATCH_SIZE = 100;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

const chunks = <T>(items: T[], size: number): T[][] => {
  const grouped: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    grouped.push(items.slice(index, index + size));
  }
  return grouped;
};

const run = async () => {
  const [songs, artists, genres] = await Promise.all([
    prisma.song.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } }),
    prisma.artist.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } }),
    prisma.genre.findMany({ select: { id: true }, orderBy: { name: 'asc' } })
  ]);

  console.log(`Starting Typesense backfill for ${songs.length} songs, ${artists.length} artists, ${genres.length} genres`);

  for (const batch of chunks(songs, BATCH_SIZE)) {
    await Promise.all(batch.map((song) => indexSong(song.id)));
    console.log(`Indexed songs: ${batch[batch.length - 1]?.id ?? 'n/a'} (${batch.length} in batch)`);
  }

  for (const batch of chunks(artists, BATCH_SIZE)) {
    await Promise.all(batch.map((artist) => indexArtist(artist.id)));
    console.log(`Indexed artists: ${batch[batch.length - 1]?.id ?? 'n/a'} (${batch.length} in batch)`);
  }

  for (const batch of chunks(genres, BATCH_SIZE)) {
    await Promise.all(batch.map((genre) => refreshGenre(genre.id)));
    console.log(`Indexed genres: ${batch[batch.length - 1]?.id ?? 'n/a'} (${batch.length} in batch)`);
  }

  await bulkIndex();
  console.log('Typesense backfill complete');
};

run()
  .catch((error) => {
    console.error('Typesense backfill failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
