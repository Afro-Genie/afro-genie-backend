/**
 * Phase 1.2: Audit stale Typesense entries.
 * 
 * Usage: tsx scripts/audit-typesense-stale.ts
 * 
 * Reports:
 *   - IDs in Typesense but NOT in database (stale → need deletion)
 *   - IDs in database but NOT in Typesense (missing → need reindex)
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import Typesense from 'typesense';

const dbUrl = new URL(process.env.DATABASE_URL!);
dbUrl.searchParams.delete('channel_binding');
const pool = new Pool({ connectionString: dbUrl.toString() });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const client = new Typesense.Client({
  nodes: [
    {
      host: process.env.TYPESENSE_HOST!,
      port: Number(process.env.TYPESENSE_PORT) || 8108,
      protocol: process.env.TYPESENSE_PROTOCOL || 'http',
    },
  ],
  apiKey: process.env.TYPESENSE_API_KEY!,
  connectionTimeoutSeconds: 5,
});

const COLLECTIONS = ['songs', 'artists', 'genres'] as const;

async function fetchAllIds(collection: string): Promise<string[]> {
  const ids: string[] = [];
  let page = 1;
  const perPage = 250;

  // Use a searchable field per collection for query_by
  const queryBy: Record<string, string> = {
    songs: 'title',
    artists: 'name',
    genres: 'name',
  };

  while (true) {
    try {
      const result = await client.collections(collection).documents().search({
        q: '*',
        query_by: queryBy[collection] || 'name',
        include_fields: 'id',
        per_page: perPage,
        page,
      });

      const hits = result.hits ?? [];
      for (const hit of hits) {
        const doc = hit.document as { id: string };
        if (doc.id) ids.push(doc.id);
      }

      if (hits.length < perPage) break;
      page++;
    } catch (error: any) {
      if (error.httpStatus === 404) {
        console.log(`  Collection '${collection}' does not exist in Typesense.`);
        break;
      }
      throw error;
    }
  }

  return ids;
}

async function main() {
  console.log('\n=== TYPESENSE STALE AUDIT ===\n');

  // Fetch all IDs from database
  console.log('Fetching database records...');
  const [dbArtists, dbSongs, dbGenres] = await Promise.all([
    prisma.artist.findMany({ select: { id: true }, where: { softDeleted: false } }),
    prisma.song.findMany({ select: { id: true }, where: { softDeleted: false } }),
    prisma.genre.findMany({ select: { id: true } }),
  ]);

  const dbArtistIds = new Set(dbArtists.map((a) => a.id));
  const dbSongIds = new Set(dbSongs.map((s) => s.id));
  const dbGenreIds = new Set(dbGenres.map((g) => g.id));

  console.log(`  Database: ${dbArtistIds.size} artists, ${dbSongIds.size} songs, ${dbGenreIds.size} genres\n`);

  // Fetch all IDs from Typesense
  const results: Record<string, { stale: string[]; missing: string[]; tsCount: number; dbCount: number }> = {};

  for (const collection of COLLECTIONS) {
    console.log(`Auditing Typesense collection: ${collection}...`);
    const tsIds = await fetchAllIds(collection);
    console.log(`  Typesense: ${tsIds.length} documents`);

    const dbIds =
      collection === 'artists' ? dbArtistIds :
      collection === 'songs' ? dbSongIds :
      dbGenreIds;

    const stale = tsIds.filter((id) => !dbIds.has(id));
    const dbIdArray = Array.from(dbIds);
    const missing = dbIdArray.filter((id) => !tsIds.includes(id));

    results[collection] = {
      stale,
      missing,
      tsCount: tsIds.length,
      dbCount: dbIds.size,
    };

    console.log(`  Stale (in TS, not in DB): ${stale.length}`);
    console.log(`  Missing (in DB, not in TS): ${missing.length}\n`);
  }

  // Summary
  console.log('=== AUDIT SUMMARY ===\n');
  console.log('| Collection | DB Count | TS Count | Stale | Missing |');
  console.log('|------------|----------|----------|-------|---------|');
  for (const collection of COLLECTIONS) {
    const r = results[collection];
    console.log(
      `| ${collection.padEnd(10)} | ${String(r.dbCount).padStart(8)} | ${String(r.tsCount).padStart(8)} | ${String(r.stale.length).padStart(5)} | ${String(r.missing.length).padStart(7)} |`
    );
  }

  // Detail: list stale IDs
  for (const collection of COLLECTIONS) {
    const r = results[collection];
    if (r.stale.length > 0) {
      console.log(`\nStale ${collection} IDs (first 20):`);
      r.stale.slice(0, 20).forEach((id) => console.log(`  - ${id}`));
      if (r.stale.length > 20) console.log(`  ... and ${r.stale.length - 20} more`);
    }
  }

  // Detail: list missing IDs
  for (const collection of COLLECTIONS) {
    const r = results[collection];
    if (r.missing.length > 0) {
      console.log(`\nMissing ${collection} IDs (first 20):`);
      r.missing.slice(0, 20).forEach((id) => console.log(`  - ${id}`));
      if (r.missing.length > 20) console.log(`  ... and ${r.missing.length - 20} more`);
    }
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('Audit failed:', error);
  process.exit(1);
});
