require('dotenv').config();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

async function cleanup() {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.delete('channel_binding');
  const pool = new Pool({ connectionString: url.toString() });
  const adapter = new PrismaPg(pool, { schema: url.searchParams.get('schema') || undefined });
  const prisma = new PrismaClient({ adapter });

  const pending = await prisma.translation.findMany({ where: { status: 'PENDING' } });
  console.log('Found', pending.length, 'PENDING translations');
  for (const t of pending) {
    console.log('  ID:', t.id, 'song:', t.songId, 'created:', t.createdAt.toISOString());
    if (!t.translatedLyrics) {
      await prisma.translation.delete({ where: { id: t.id } });
      console.log('    -> Deleted (no translated text)');
    } else {
      await prisma.translation.update({ where: { id: t.id }, data: { status: 'APPROVED' } });
      console.log('    -> Approved (has translated text)');
    }
  }
  const remaining = await prisma.translation.count({ where: { status: 'PENDING' } });
  console.log('Remaining PENDING:', remaining);
  await prisma.$disconnect();
  await pool.end();
}

cleanup().catch(e => { console.error(e.message); process.exit(1); });
