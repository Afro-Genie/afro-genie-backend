import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({
  adapter: new PrismaPg(pool),
});

async function verify() {
  const songs = await prisma.song.count();
  const artists = await prisma.artist.count();
  const lyrics = await prisma.lyric.count({ where: { content: { not: null } } });
  const noLyrics = await prisma.song.count({ where: { lyrics: { none: {} } } });
  console.log('Songs:', songs, '| Artists:', artists, '| Lyrics:', lyrics);
  console.log('Songs missing lyrics:', noLyrics);
  const samples = await prisma.song.findMany({
    take: 5,
    include: { artist: true, lyrics: { take: 1 } },
    orderBy: { createdAt: 'asc' },
  });
  samples.forEach((song) =>
    console.log(
      song.title,
      '--',
      song.artist.name,
      '--',
      song.lyrics[0]?.content?.substring(0, 50) || 'NO LYRICS',
    ),
  );
}

verify()
  .catch((error) => {
    console.error('Verification failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });