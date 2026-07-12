/**
 * Backfill Song.spotifyId from Spotify API.
 *
 * For every Song that is missing a spotifyId, search Spotify by
 * "{artistName} {trackTitle}" and update the Song with the matched
 * Spotify track ID, preview URL, and duration.
 *
 * Usage:
 *   npx tsx scripts/backfillSpotifyIds.ts [--dry-run] [--limit N] [--batch-size N]
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const SPOTIFY_ACCOUNTS_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const batchSizeIdx = args.indexOf('--batch-size');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) || 500 : 500;
const batchSize = batchSizeIdx !== -1 ? parseInt(args[batchSizeIdx + 1], 10) || 5 : 5;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

let spotifyToken: string | null = null;

async function getSpotifyToken(): Promise<string> {
  if (spotifyToken) return spotifyToken;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set');
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(SPOTIFY_ACCOUNTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    throw new Error(`Failed to get Spotify token: ${response.status}`);
  }

  const data = (await response.json()) as { access_token: string };
  spotifyToken = data.access_token;
  return spotifyToken;
}

async function searchSpotifyTrack(query: string): Promise<{
  id: string;
  uri: string;
  preview_url: string | null;
  duration_ms: number;
} | null> {
  const token = await getSpotifyToken();
  const url = `${SPOTIFY_API_BASE}/search?q=${encodeURIComponent(query)}&type=track&limit=3`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const waitMs = (parseInt(retryAfter || '5', 10) + 1) * 1000;
      console.log(`  Rate limited, waiting ${waitMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, waitMs));
      return searchSpotifyTrack(query);
    }
    console.error(`  Spotify search failed (${response.status})`);
    return null;
  }

  const data = (await response.json()) as {
    tracks?: { items: Array<{ id: string; uri: string; preview_url: string | null; duration_ms: number; name: string; artists: Array<{ name: string }> }> };
  };

  const tracks = data.tracks?.items ?? [];
  return tracks[0] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`Backfill Spotify IDs (dryRun=${dryRun}, limit=${limit}, batchSize=${batchSize})`);

  const songs = await prisma.song.findMany({
    where: {
      spotifyId: null,
      softDeleted: false,
    },
    include: {
      artist: { select: { name: true } },
    },
    take: limit,
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${songs.length} songs without spotifyId`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < songs.length; i += batchSize) {
    const batch = songs.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (song) => {
        const artistName = song.artist?.name || '';
        const query = `${artistName} ${song.title}`;

        try {
          const match = await searchSpotifyTrack(query);

          if (!match) {
            console.log(`  [${song.id}] No match for: ${query}`);
            failed++;
            return;
          }

          if (!dryRun) {
            await prisma.song.update({
              where: { id: song.id },
              data: {
                spotifyId: match.id,
                spotifyPreviewUrl: match.preview_url,
                previewAvailable: !!match.preview_url,
                durationMs: match.duration_ms || song.durationMs,
              },
            });
          }

          console.log(`  [${song.id}] ${dryRun ? '[DRY] ' : ''}Matched: ${match.id} (${match.uri}) — "${match.artists?.[0]?.name} - ${song.title}"`);
          updated++;
        } catch (err: any) {
          console.error(`  [${song.id}] Error: ${err.message}`);
          failed++;
        }
      }),
    );

    // Brief pause between batches to avoid rate limits
    if (i + batchSize < songs.length) {
      await sleep(500);
    }
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}, Failed: ${failed}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
