/**
 * PHASE B — Artist Metadata Backfill via Last.fm
 *
 * Enriches artist records with listeners, playcount, bio, genres, and images
 * from the Last.fm API. These replace the deprecated Spotify popularity/
 * followers/genres fields.
 *
 * SAFETY:
 *   --dry-run       Preview changes without writing to DB
 *   --priority      Backfill only the 14 high-priority artists
 *   --limit N       Process at most N artists
 *
 * Usage:
 *   npx tsx scripts/backfill-artists.ts --dry-run              (preview all)
 *   npx tsx scripts/backfill-artists.ts --priority --dry-run   (preview priority)
 *   npx tsx scripts/backfill-artists.ts --priority             (write priority)
 *   npx tsx scripts/backfill-artists.ts                        (write all — prompts)
 */

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import * as readline from 'readline';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const PRIORITY_ONLY = args.includes('--priority');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) || 273 : 273;

// ── Last.fm config ──────────────────────────────────────────────────────────
const LASTFM_API_BASE = 'https://ws.audioscrobbler.com/2.0/';
// Public Last.fm demo key — works for basic artist lookups
const LASTFM_API_KEY = 'b25b959554ed76058ac220b7b2e0a026';

// ── Types ───────────────────────────────────────────────────────────────────
interface LastFmData {
  name: string;
  listeners: number;
  playcount: number;
  bio: string;
  tags: string[];
  imageUrl: string;
}

interface BackfillPlan {
  id: string;
  name: string;
  current: {
    popularity: number;
    followers: number;
    bio: string | null;
    genres: string[];
    imageUrl: string | null;
  };
  incoming: {
    popularity: number;   // from listeners
    followers: number;    // from playcount
    bio: string;
    genres: string[];
    imageUrl: string;
  };
}

// ── Priority artists ────────────────────────────────────────────────────────
const PRIORITY_NAMES = [
  'Burna Boy', 'Wizkid', 'Davido', 'Tems', 'Ayra Starr',
  'Rema', 'Fireboy DML', 'Omah Lay', 'Fola', 'Fido',
  'Shallipopi', 'Blaqbonez', 'Black Sherif', 'Sarkodie',
];

// ── Last.fm fetcher ─────────────────────────────────────────────────────────
async function fetchLastFm(artistName: string, retries = 2): Promise<LastFmData | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const params = new URLSearchParams({
        method: 'artist.getinfo',
        artist: artistName,
        format: 'json',
        api_key: LASTFM_API_KEY,
      });
      const res = await fetch(`${LASTFM_API_BASE}?${params}`, {
        headers: { 'User-Agent': 'AfroGenie/1.0 (artist-enrichment)' },
      });

      // Rate limited — back off and retry
      if (res.status === 429 || res.status === 403) {
        const waitMs = Math.pow(2, attempt) * 1000;
        console.warn(`\n  [Last.fm] ${res.status} for "${artistName}", retrying in ${waitMs}ms...`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) return null;

      const data = await res.json() as any;
      if (data.error || !data.artist) return null;

      const artist = data.artist;
      const images = artist.image || [];
      const imageUrl = images.find((i: any) => i.size === 'extralarge')?.['#text']
        || images.find((i: any) => i.size === 'large')?.['#text']
        || '';

      const rawBio = artist.bio?.summary || '';
      const bio = rawBio.replace(/<[^>]*>/g, '').trim();

      const tags = (artist.tags?.tag || [])
        .map((t: any) => (t.name || '').toLowerCase().trim())
        .filter((t: string) => t.length > 0);

      return {
        name: artist.name || artistName,
        listeners: parseInt(artist.stats?.listeners || '0', 10),
        playcount: parseInt(artist.stats?.playcount || '0', 10),
        bio,
        tags,
        imageUrl,
      };
    } catch (err) {
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

// ── Confirmation prompt ─────────────────────────────────────────────────────
function prompt(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${message} (yes/no): `, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       PHASE B — ARTIST METADATA BACKFILL (Last.fm)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Mode:    ${DRY_RUN ? '🔍 DRY RUN (no changes)' : '✍️  LIVE (will write to DB)'}`);
  console.log(`  Scope:   ${PRIORITY_ONLY ? 'Priority artists only' : 'All artists'}`);
  console.log(`  Limit:   ${LIMIT} artists`);
  console.log('');

  // 1. Find artists that need backfill
  const where: any = { softDeleted: false };

  if (PRIORITY_ONLY) {
    where.OR = PRIORITY_NAMES.map(name => ({
      name: { contains: name, mode: 'insensitive' },
    }));
  }

  const artists = await prisma.artist.findMany({
    where,
    select: {
      id: true, name: true, spotifyId: true,
      popularity: true, followers: true, bio: true, imageUrl: true, genres: true,
    },
    orderBy: { name: 'asc' },
    take: LIMIT,
  });

  // Filter to those needing backfill
  const needsBackfill = artists.filter(a =>
    a.popularity === 0 || a.followers === 0 || !a.bio || a.genres.length === 0 || !a.imageUrl
  );

  console.log(`  Found ${artists.length} artists, ${needsBackfill.length} need backfill\n`);

  if (needsBackfill.length === 0) {
    console.log('  ✅ All selected artists already have complete metadata. Nothing to do.');
    await cleanup();
    return;
  }

  // 2. Fetch from Last.fm with rate limiting
  const plan: BackfillPlan[] = [];
  let fetched = 0;
  let failed = 0;

  for (let i = 0; i < needsBackfill.length; i++) {
    const local = needsBackfill[i];
    const fmData = await fetchLastFm(local.name);

    if (fmData && fmData.listeners > 0) {
      fetched++;
      plan.push({
        id: local.id,
        name: local.name,
        current: {
          popularity: local.popularity,
          followers: local.followers,
          bio: local.bio,
          genres: local.genres,
          imageUrl: local.imageUrl,
        },
        incoming: {
          popularity: fmData.listeners,
          followers: fmData.playcount,
          bio: fmData.bio,
          genres: fmData.tags,
          imageUrl: fmData.imageUrl,
        },
      });
    } else {
      failed++;
    }

    // Rate limit: ~2 req/sec for Last.fm (conservative)
    if (i < needsBackfill.length - 1) await sleep(500);

    process.stdout.write(`  Fetched ${Math.min(i + 1, needsBackfill.length)}/${needsBackfill.length} (${fetched} ok, ${failed} miss)...\r`);
  }

  console.log(`\n  Fetched ${fetched} artists from Last.fm, ${failed} not found\n`);

  if (plan.length === 0) {
    console.log('  ⚠️  No artists could be matched on Last.fm.');
    await cleanup();
    return;
  }

  // 3. Preview changes
  console.log('  📋 CHANGE PREVIEW');
  console.log('  ─────────────────────────────────────────────────────────────');

  for (const p of plan.slice(0, 40)) {
    const popDiff = p.incoming.popularity - p.current.popularity;
    const folDiff = p.incoming.followers - p.current.followers;
    const imgNew = !p.current.imageUrl && !!p.incoming.imageUrl;
    const bioNew = !p.current.bio && !!p.incoming.bio;
    const genresNew = p.current.genres.length === 0 && p.incoming.genres.length > 0;

    const changes: string[] = [];
    if (p.current.popularity === 0 && p.incoming.popularity > 0) changes.push(`listeners: 0 → ${formatNum(p.incoming.popularity)}`);
    if (p.current.followers === 0 && p.incoming.followers > 0) changes.push(`playcount: 0 → ${formatNum(p.incoming.followers)}`);
    if (imgNew) changes.push('image: ✅ new');
    if (bioNew) changes.push('bio: ✅ new');
    if (genresNew) changes.push(`genres: ${p.incoming.genres.slice(0, 4).join(', ')}`);

    if (changes.length > 0) {
      console.log(`  ${p.name.padEnd(30)} ${changes.join(' | ')}`);
    }
  }

  if (plan.length > 40) {
    console.log(`  ... and ${plan.length - 40} more artists\n`);
  }

  // Summary of what will change
  const willUpdatePop = plan.filter(p => p.current.popularity === 0 && p.incoming.popularity > 0).length;
  const willUpdateImg = plan.filter(p => !p.current.imageUrl && !!p.incoming.imageUrl).length;
  const willUpdateBio = plan.filter(p => !p.current.bio && !!p.incoming.bio).length;
  const willUpdateGenres = plan.filter(p => p.current.genres.length === 0 && p.incoming.genres.length > 0).length;

  console.log(`\n  📊 SUMMARY`);
  console.log(`  Will update listeners (popularity): ${willUpdatePop} artists`);
  console.log(`  Will update playcount (followers):  ${willUpdatePop} artists`);
  console.log(`  Will update images:                 ${willUpdateImg} artists`);
  console.log(`  Will update bios:                   ${willUpdateBio} artists`);
  console.log(`  Will update genres:                 ${willUpdateGenres} artists`);

  // 4. Confirm before writing
  if (!DRY_RUN) {
    const confirmed = await prompt(
      `\n  ⚠️  This will UPDATE ${plan.length} artist records in the database. Continue?`
    );
    if (!confirmed) {
      console.log('  Aborted. No changes made.');
      await cleanup();
      return;
    }
  }

  // 5. Write to DB
  let updated = 0;
  let skipped = 0;

  for (const p of plan) {
    if (DRY_RUN) {
      updated++;
      continue;
    }

    try {
      const updateData: any = {};

      // Only set popularity if currently 0
      if (p.current.popularity === 0 && p.incoming.popularity > 0) {
        updateData.popularity = p.incoming.popularity;
      }

      // Only set followers if currently 0
      if (p.current.followers === 0 && p.incoming.followers > 0) {
        updateData.followers = p.incoming.followers;
      }

      // Only set image if currently missing
      if (!p.current.imageUrl && p.incoming.imageUrl) {
        updateData.imageUrl = p.incoming.imageUrl;
      }

      // Only set bio if currently missing
      if (!p.current.bio && p.incoming.bio) {
        updateData.bio = p.incoming.bio;
      }

      // Only set genres if currently empty
      if (p.current.genres.length === 0 && p.incoming.genres.length > 0) {
        updateData.genres = p.incoming.genres;
      }

      // Only write if there's something to update
      if (Object.keys(updateData).length > 0) {
        await prisma.artist.update({
          where: { id: p.id },
          data: updateData,
        });
        updated++;
      } else {
        skipped++;
      }
    } catch (err: any) {
      console.error(`  ❌ Failed to update ${p.name}: ${err.message}`);
      skipped++;
    }
  }

  // 6. Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  ${DRY_RUN ? 'Previewed' : 'Updated'}:  ${updated} artists`);
  if (skipped > 0) console.log(`  Skipped:   ${skipped} artists (already complete or errors)`);
  if (DRY_RUN) {
    console.log('\n  ℹ️  This was a dry run. To apply changes, run without --dry-run:');
    console.log('     npx tsx scripts/backfill-artists.ts --priority');
    console.log('     npx tsx scripts/backfill-artists.ts');
  } else {
    console.log('\n  ✅ Artist metadata has been updated in the database.');
    console.log('  ℹ️  Run the audit script to verify:');
    console.log('     npx tsx scripts/audit-artists.ts');
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  await cleanup();
}

async function cleanup() {
  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (err) => {
  console.error('❌ Backfill failed:', err);
  await cleanup();
  process.exitCode = 1;
});
