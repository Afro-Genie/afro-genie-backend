import 'dotenv/config';
import { Redis } from 'ioredis';
import { PrismaClient } from '@prisma/client';

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error('REDIS_URL is required');
  process.exit(1);
}

const redis = new Redis(REDIS_URL);
const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const maxDays = args.includes('--max-days')
    ? parseInt(args[args.indexOf('--max-days') + 1], 10) || 7
    : 7;

  const lastSync = await redis.get('sync:lastSync:popularTracks');
  const daysSince = lastSync
    ? (Date.now() - new Date(lastSync).getTime()) / (1000 * 60 * 60 * 24)
    : 99;

  const [songCount, artistCount, albumCount, songsWithoutLyrics, artistsNeedingLastFm] = await Promise.all([
    prisma.song.count({ where: { softDeleted: false } }),
    prisma.artist.count({ where: { softDeleted: false } }),
    prisma.album.count(),
    prisma.song.count({
      where: {
        softDeleted: false,
        lyrics: { none: {} },
        spotifyId: { not: null },
      },
    }),
    prisma.artist.count({
      where: {
        softDeleted: false,
        spotifyId: { not: null },
        OR: [
          { popularity: 0 },
          { followers: 0 },
          { bio: null },
        ],
      },
    }),
  ]);

  const isHealthy = daysSince <= maxDays;

  console.log(JSON.stringify({
    status: isHealthy ? 'healthy' : 'stale',
    daysSinceLastSync: Math.round(daysSince * 10) / 10,
    maxDays,
    lastSync: lastSync || 'never',
    counts: {
      songs: songCount,
      artists: artistCount,
      albums: albumCount,
    },
    backfillNeeded: {
      songsMissingLyrics: songsWithoutLyrics,
      artistsNeedingLastFm: artistsNeedingLastFm,
    },
  }, null, 2));

  if (!isHealthy) {
    console.error(`\nFAIL: Sync stale — ${daysSince.toFixed(1)} days since last popular tracks sync (max ${maxDays})`);
    process.exit(1);
  }

  if (songsWithoutLyrics > 0) {
    console.warn(`\nWARNING: ${songsWithoutLyrics} songs missing lyrics — run backfill-lyrics job`);
  }

  if (artistsNeedingLastFm > 0) {
    console.warn(`WARNING: ${artistsNeedingLastFm} artists need LastFM enrichment — run backfill-artists-lastfm job`);
  }

  console.log(`\nOK: Sync healthy (${daysSince.toFixed(1)} days since last sync)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
}).finally(async () => {
  await redis.quit();
  await prisma.$disconnect();
});
