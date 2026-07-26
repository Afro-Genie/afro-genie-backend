/**
 * Phase 1.4: Clean stale Typesense entries.
 * 
 * Usage:
 *   tsx scripts/clean-typesense-stale.ts              (dry-run by default)
 *   tsx scripts/clean-typesense-stale.ts --apply      (actually delete)
 * 
 * Deletes documents from Typesense that no longer exist in the database.
 * Safe: only deletes IDs present in Typesense but absent from Prisma.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import Typesense from 'typesense';

const DRY_RUN = !process.argv.includes('--apply');

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
        break;
      }
      throw error;
    }
  }

  return ids;
}

async function main() {
  console.log(`\n=== TYPESENSE STALE CLEANUP ${DRY_RUN ? '(DRY RUN)' : '(APPLY)'} ===\n`);

  // Fetch DB IDs
  const [dbArtists, dbSongs, dbGenres] = await Promise.all([
    prisma.artist.findMany({ select: { id: true }, where: { softDeleted: false } }),
    prisma.song.findMany({ select: { id: true }, where: { softDeleted: false } }),
    prisma.genre.findMany({ select: { id: true } }),
  ]);

  const dbMap: Record<string, Set<string>> = {
    artists: new Set(dbArtists.map((a) => a.id)),
    songs: new Set(dbSongs.map((s) => s.id)),
    genres: new Set(dbGenres.map((g) => g.id)),
  };

  let totalDeleted = 0;
  let totalErrors = 0;

  for (const collection of COLLECTIONS) {
    console.log(`Processing Typesense collection: ${collection}...`);
    const tsIds = await fetchAllIds(collection);
    const staleIds = tsIds.filter((id) => !dbMap[collection].has(id));

    console.log(`  Total in Typesense: ${tsIds.length}`);
    console.log(`  Stale to remove:   ${staleIds.length}`);

    if (staleIds.length === 0) {
      console.log('  No stale entries found.\n');
      continue;
    }

    if (DRY_RUN) {
      console.log('  Stale IDs (first 20):');
      staleIds.slice(0, 20).forEach((id) => console.log(`    - ${id}`));
      if (staleIds.length > 20) console.log(`    ... and ${staleIds.length - 20} more`);
      console.log('  [DRY RUN] No deletions performed.\n');
      totalDeleted += staleIds.length;
      continue;
    }

    // Delete stale entries one by one (safer than bulk, allows partial progress)
    let deleted = 0;
    let errors = 0;
    for (const id of staleIds) {
      try {
        await client.collections(collection).documents(id).delete();
        deleted++;
      } catch (error: any) {
        if (error.httpStatus === 404) {
          // Already gone, count as deleted
          deleted++;
        } else {
          console.error(`  Error deleting ${collection}/${id}: ${error.message}`);
          errors++;
        }
      }
    }

    console.log(`  Deleted: ${deleted}, Errors: ${errors}\n`);
    totalDeleted += deleted;
    totalErrors += errors;
  }

  console.log('=== CLEANUP SUMMARY ===\n');
  console.log(`  Mode:            ${DRY_RUN ? 'DRY RUN' : 'APPLIED'}`);
  console.log(`  Total processed: ${totalDeleted}`);
  console.log(`  Errors:          ${totalErrors}`);
  if (DRY_RUN && totalDeleted > 0) {
    console.log(`\n  To apply deletions, run: tsx scripts/clean-typesense-stale.ts --apply`);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('Cleanup failed:', error);
  process.exit(1);
});
