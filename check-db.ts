import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const [songs, artists, albums, genres, languages, lyrics, users] = await Promise.all([
    prisma.song.count(),
    prisma.artist.count(),
    prisma.album.count(),
    prisma.genre.count(),
    prisma.language.count(),
    prisma.lyric.count(),
    prisma.user.count(),
  ]);

  console.log(JSON.stringify({ songs, artists, albums, genres, languages, lyrics, users }, null, 2));
  process.exit(0);
}

main();
