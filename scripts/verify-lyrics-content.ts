import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const totalLyrics = await prisma.lyric.count();
  const withContent = await prisma.lyric.count({ where: { content: { not: null } } });
  const withSynced = await prisma.lyric.count({ where: { syncedLyrics: { not: null } } });
  const emptyContent = await prisma.lyric.count({ where: { content: null } });

  console.log(`Total lyric records: ${totalLyrics}`);
  console.log(`With content (non-null): ${withContent} (${(withContent / totalLyrics * 100).toFixed(1)}%)`);
  console.log(`With synced lyrics: ${withSynced}`);
  console.log(`Empty content (null): ${emptyContent}`);

  // By provider
  const byProvider = await prisma.lyric.groupBy({
    by: ['sourceProvider'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  });
  console.log('\nBy provider:');
  for (const row of byProvider) {
    console.log(`  ${row.sourceProvider}: ${row._count.id}`);
  }

  // Sample filled lyrics
  const samples = await prisma.lyric.findMany({
    where: { content: { not: null } },
    take: 3,
    orderBy: { createdAt: 'desc' },
    select: { songId: true, content: true, sourceProvider: true },
  });
  console.log('\nSample filled lyrics:');
  for (const s of samples) {
    console.log(`  ${s.songId} (${s.sourceProvider}): ${(s.content ?? '').substring(0, 80)}...`);
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
