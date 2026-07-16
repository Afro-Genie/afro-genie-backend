/**
 * PHASE A — Artist Data Quality Audit
 *
 * READ-ONLY script. Produces a detailed remediation report by querying
 * the Artist table and classifying every record into quality tiers.
 *
 * Usage:
 *   npx tsx scripts/audit-artists.ts
 *   npx tsx scripts/audit-artists.ts --json   (machine-readable output)
 */

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const PRIORITY_ARTISTS = [
  'Burna Boy', 'Wizkid', 'Davido', 'Tems', 'Ayra Starr',
  'Rema', 'Fireboy DML', 'Omah Lay', 'Fola', 'Fido',
  'Shallipopi', 'Blaqbonez', 'Black Sherif', 'Sarkodie',
];

function pct(part: number, total: number): string {
  if (total === 0) return '0%';
  return Math.round((part / total) * 100) + '%';
}

interface ArtistRecord {
  id: string;
  name: string;
  imageUrl: string | null;
  spotifyId: string | null;
  popularity: number;
  followers: number;
  genres: string[];
  verified: boolean;
  softDeleted: boolean;
  songCount: number;
  updatedAt: Date;
}

interface AuditResult {
  total: number;
  active: number;
  softDeleted: number;
  withSpotifyId: number;
  withoutSpotifyId: number;
  withImage: number;
  withoutImage: number;
  withPopularity: number;
  popularityZero: number;
  withFollowers: number;
  followersZero: number;
  withGenres: number;
  genresEmpty: number;
  brokenImages: number;
  priorityArtists: Array<{
    name: string;
    found: boolean;
    id?: string;
    spotifyId?: string | null;
    popularity: number;
    followers: number;
    hasImage: boolean;
    hasGenres: boolean;
    issues: string[];
  }>;
  qualityTiers: {
    excellent: number;   // has spotify + image + pop > 0 + followers > 0 + genres
    good: number;        // has spotify + image, missing some metrics
    fair: number;        // has spotify OR image, but not both
    poor: number;        // no spotify, no image, popularity = 0
  };
  topArtistsByPopularity: Array<{
    name: string;
    popularity: number;
    followers: number;
    hasImage: boolean;
    hasSpotifyId: boolean;
  }>;
  candidatesForBackfill: Array<{
    name: string;
    id: string;
    spotifyId: string | null;
    popularity: number;
    followers: number;
    hasImage: boolean;
    reason: string;
  }>;
}

async function audit(): Promise<AuditResult> {
  const total = await prisma.artist.count();
  const softDeleted = await prisma.artist.count({ where: { softDeleted: true } });
  const active = total - softDeleted;

  const withSpotifyId = await prisma.artist.count({
    where: { spotifyId: { not: null }, softDeleted: false },
  });
  const withoutSpotifyId = active - withSpotifyId;

  const withImage = await prisma.artist.count({
    where: { imageUrl: { not: null }, softDeleted: false },
  });
  const withoutImage = active - withImage;

  const withPopularity = await prisma.artist.count({
    where: { popularity: { gt: 0 }, softDeleted: false },
  });
  const popularityZero = active - withPopularity;

  const withFollowers = await prisma.artist.count({
    where: { followers: { gt: 0 }, softDeleted: false },
  });
  const followersZero = active - withFollowers;

  const withGenres = await prisma.artist.count({
    where: { genres: { isEmpty: false }, softDeleted: false },
  });
  const genresEmpty = active - withGenres;

  // Count broken images (non-Spotify CDN URLs)
  const allActiveArtists = await prisma.artist.findMany({
    where: { softDeleted: false },
    select: { id: true, imageUrl: true },
  });
  const brokenImages = allActiveArtists.filter(a => {
    if (!a.imageUrl) return false;
    return !a.imageUrl.includes('i.scdn.co') && !a.imageUrl.startsWith('data:image/svg+xml');
  }).length;

  // Quality tiers
  let excellent = 0, good = 0, fair = 0, poor = 0;
  const allActive = await prisma.artist.findMany({
    where: { softDeleted: false },
    select: {
      id: true, name: true, imageUrl: true, spotifyId: true,
      popularity: true, followers: true, genres: true, verified: true,
      softDeleted: true, updatedAt: true,
      _count: { select: { songs: true } },
    },
  });

  for (const a of allActive) {
    const hasSpotify = !!a.spotifyId;
    const hasImage = !!a.imageUrl;
    const hasPop = a.popularity > 0;
    const hasFollowers = a.followers > 0;
    const hasGenres = a.genres.length > 0;

    if (hasSpotify && hasImage && hasPop && hasFollowers && hasGenres) {
      excellent++;
    } else if (hasSpotify && hasImage) {
      good++;
    } else if (hasSpotify || hasImage) {
      fair++;
    } else {
      poor++;
    }
  }

  // Top artists by popularity
  const topArtistsByPopularity = allActive
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 20)
    .map(a => ({
      name: a.name,
      popularity: a.popularity,
      followers: a.followers,
      hasImage: !!a.imageUrl,
      hasSpotifyId: !!a.spotifyId,
    }));

  // Priority artist check
  const priorityResults: AuditResult['priorityArtists'] = [];
  for (const pName of PRIORITY_ARTISTS) {
    const match = allActive.find(a =>
      a.name.toLowerCase().includes(pName.toLowerCase()) ||
      pName.toLowerCase().includes(a.name.toLowerCase())
    );
    if (match) {
      const issues: string[] = [];
      if (!match.spotifyId) issues.push('missing spotifyId');
      if (!match.imageUrl) issues.push('missing image');
      if (match.popularity === 0) issues.push('popularity=0');
      if (match.followers === 0) issues.push('followers=0');
      if (match.genres.length === 0) issues.push('no genres');
      priorityResults.push({
        name: match.name,
        found: true,
        id: match.id,
        spotifyId: match.spotifyId,
        popularity: match.popularity,
        followers: match.followers,
        hasImage: !!match.imageUrl,
        hasGenres: match.genres.length > 0,
        issues,
      });
    } else {
      priorityResults.push({
        name: pName,
        found: false,
        popularity: 0,
        followers: 0,
        hasImage: false,
        hasGenres: false,
        issues: ['NOT IN DATABASE'],
      });
    }
  }

  // Candidates for backfill
  const candidatesForBackfill: AuditResult['candidatesForBackfill'] = [];
  for (const a of allActive) {
    const issues: string[] = [];
    if (!a.spotifyId) issues.push('no spotifyId');
    if (!a.imageUrl) issues.push('no image');
    if (a.popularity === 0) issues.push('popularity=0');
    if (a.followers === 0) issues.push('followers=0');
    if (a.genres.length === 0) issues.push('no genres');

    if (issues.length >= 2) {
      const isPriority = PRIORITY_ARTISTS.some(p =>
        a.name.toLowerCase().includes(p.toLowerCase()) ||
        p.toLowerCase().includes(a.name.toLowerCase())
      );
      candidatesForBackfill.push({
        name: a.name,
        id: a.id,
        spotifyId: a.spotifyId,
        popularity: a.popularity,
        followers: a.followers,
        hasImage: !!a.imageUrl,
        reason: isPriority ? `PRIORITY: ${issues.join(', ')}` : issues.join(', '),
      });
    }
  }

  // Sort: priority candidates first, then by number of issues descending
  candidatesForBackfill.sort((a, b) => {
    const aIsPriority = a.reason.startsWith('PRIORITY');
    const bIsPriority = b.reason.startsWith('PRIORITY');
    if (aIsPriority && !bIsPriority) return -1;
    if (!aIsPriority && bIsPriority) return 1;
    return b.reason.split(', ').length - a.reason.split(', ').length;
  });

  return {
    total,
    active,
    softDeleted,
    withSpotifyId,
    withoutSpotifyId,
    withImage,
    withoutImage,
    withPopularity,
    popularityZero,
    withFollowers,
    followersZero,
    withGenres,
    genresEmpty,
    brokenImages,
    priorityArtists: priorityResults,
    qualityTiers: { excellent, good, fair, poor },
    topArtistsByPopularity,
    candidatesForBackfill,
  };
}

function printReport(result: AuditResult) {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       PHASE A — ARTIST DATA QUALITY AUDIT');
  console.log('═══════════════════════════════════════════════════════════════');

  console.log('\n  📊 OVERVIEW');
  console.log(`  Total artists:       ${result.total}`);
  console.log(`  Active:              ${result.active}`);
  console.log(`  Soft-deleted:        ${result.softDeleted}`);

  console.log('\n  🔗 SPOTIFY LINKAGE');
  console.log(`  With Spotify ID:     ${result.withSpotifyId} / ${result.active} (${pct(result.withSpotifyId, result.active)})`);
  console.log(`  Missing Spotify ID:  ${result.withoutSpotifyId} / ${result.active} (${pct(result.withoutSpotifyId, result.active)})`);

  console.log('\n  🖼️  IMAGES');
  console.log(`  With image:          ${result.withImage} / ${result.active} (${pct(result.withImage, result.active)})`);
  console.log(`  Missing image:       ${result.withoutImage} / ${result.active} (${pct(result.withoutImage, result.active)})`);
  console.log(`  Broken image URLs:   ${result.brokenImages}`);

  console.log('\n  📈 POPULARITY & FOLLOWERS');
  console.log(`  Popularity > 0:      ${result.withPopularity} / ${result.active} (${pct(result.withPopularity, result.active)})`);
  console.log(`  Popularity = 0:      ${result.popularityZero} / ${result.active} (${pct(result.popularityZero, result.active)})`);
  console.log(`  Followers > 0:       ${result.withFollowers} / ${result.active} (${pct(result.withFollowers, result.active)})`);
  console.log(`  Followers = 0:       ${result.followersZero} / ${result.active} (${pct(result.followersZero, result.active)})`);

  console.log('\n  🎭 GENRES');
  console.log(`  With genres:         ${result.withGenres} / ${result.active} (${pct(result.withGenres, result.active)})`);
  console.log(`  No genres:           ${result.genresEmpty} / ${result.active} (${pct(result.genresEmpty, result.active)})`);

  console.log('\n  ⭐ QUALITY TIERS');
  console.log(`  Excellent (all data): ${result.qualityTiers.excellent} (${pct(result.qualityTiers.excellent, result.active)})`);
  console.log(`  Good (spotify+image): ${result.qualityTiers.good} (${pct(result.qualityTiers.good, result.active)})`);
  console.log(`  Fair (partial):       ${result.qualityTiers.fair} (${pct(result.qualityTiers.fair, result.active)})`);
  console.log(`  Poor (no data):       ${result.qualityTiers.poor} (${pct(result.qualityTiers.poor, result.active)})`);

  console.log('\n  🏆 TOP 20 ARTISTS BY POPULARITY');
  for (const a of result.topArtistsByPopularity) {
    const spotify = a.hasSpotifyId ? '🔗' : '  ';
    const image = a.hasImage ? '🖼️' : '  ';
    console.log(`    ${spotify} ${image} ${a.name.padEnd(30)} pop=${String(a.popularity).padStart(3)}  followers=${String(a.followers).padStart(8)}`);
  }

  console.log('\n  🎯 PRIORITY ARTIST STATUS');
  for (const p of result.priorityArtists) {
    if (!p.found) {
      console.log(`    ❌ ${p.name.padEnd(25)} — NOT IN DATABASE`);
      continue;
    }
    const issueStr = p.issues.length > 0 ? ` ⚠️  ${p.issues.join(', ')}` : ' ✅ OK';
    console.log(`    ${p.name.padEnd(25)} pop=${String(p.popularity).padStart(3)}  followers=${String(p.followers).padStart(8)}${issueStr}`);
  }

  console.log(`\n  🔧 BACKFILL CANDIDATES (${result.candidatesForBackfill.length} artists with ≥2 issues)`);
  for (const c of result.candidatesForBackfill.slice(0, 30)) {
    console.log(`    ${c.name.padEnd(30)} — ${c.reason}`);
  }
  if (result.candidatesForBackfill.length > 30) {
    console.log(`    ... and ${result.candidatesForBackfill.length - 30} more`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  VERDICT');
  console.log('═══════════════════════════════════════════════════════════════');
  if (result.popularityZero === 0 && result.withoutImage === 0) {
    console.log('  ✅ All artists have complete metadata — no remediation needed');
  } else {
    console.log(`  ⚠️  ${result.popularityZero} artists with popularity=0, ${result.withoutImage} missing images`);
    console.log(`  ⚠️  ${result.candidatesForBackfill.length} artists flagged for backfill`);
    console.log('  ➡️  Run Phase B backfill script after reviewing this report');
  }
  console.log('═══════════════════════════════════════════════════════════════\n');
}

async function main() {
  const jsonMode = process.argv.includes('--json');
  const result = await audit();

  if (jsonMode) {
    const outputPath = path.join(__dirname, '..', 'audit-artists-report.json');
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`Report written to ${outputPath}`);
  } else {
    printReport(result);
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exitCode = 1;
});
