import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const migrations = await prisma.$queryRawUnsafe<any[]>(
    'SELECT migration_name, started_at, finished_at, applied_steps_count FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5'
  );
  console.log('Recent migrations:');
  for (const m of migrations) {
    console.log(`  ${m.migration_name}`);
    console.log(`    Started:  ${m.started_at}`);
    console.log(`    Finished: ${m.finished_at}`);
    console.log(`    Steps:    ${m.applied_steps_count}`);
  }

  const songDates = await prisma.$queryRawUnsafe<any[]>(
    'SELECT DATE("createdAt") as day, COUNT(*) as count FROM "Song" GROUP BY day ORDER BY day DESC'
  );
  console.log('\nSong creation dates:');
  for (const d of songDates) {
    console.log(`  ${d.day}: ${d.count} songs`);
  }

  const artistDates = await prisma.$queryRawUnsafe<any[]>(
    'SELECT DATE("createdAt") as day, COUNT(*) as count FROM "Artist" GROUP BY day ORDER BY day DESC'
  );
  console.log('\nArtist creation dates:');
  for (const d of artistDates) {
    console.log(`  ${d.day}: ${d.count} artists`);
  }

  await prisma.$disconnect();
  await pool.end();
}
main();
