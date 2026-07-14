/**
 * Scheduled Seed Runner
 *
 * Waits for Spotify rate limit to expire, then runs the seed.
 * Designed to be run once and left alone.
 *
 * Usage: npx tsx scripts/scheduled-seed.ts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const PROGRESS_FILE = path.join(__dirname, '..', '.seed-progress.json');
const SPOTIFY_API = 'https://api.spotify.com/v1';

const QUERIES = [
  'afrobeats', 'amapiano', 'afropop', 'nigerian music', 'african music',
  'afro fusion', 'highlife', 'bongo flava', 'gengetone', 'afro r&b',
  'dancehall africa', 'naija hits', 'burna boy', 'wizkid', 'davido',
  'tems', 'asake', 'rema', 'fireboy dml', 'ayra starr',
  'black sherif', 'tiwa savage', 'sauti sol', 'sarkodie', 'diamond platnumz',
];

let token = '';
let tokenExpiresAt = 0;

async function getToken(): Promise<string> {
  if (token && Date.now() < tokenExpiresAt - 60000) return token;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Token error: ${res.status}`);
  const data = await res.json();
  token = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return token;
}

async function checkRateLimit(): Promise<{ limited: boolean; retryAfter: number }> {
  const t = await getToken();
  const res = await fetch(`${SPOTIFY_API}/search?q=test&type=track&limit=1`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '3600', 10);
    return { limited: true, retryAfter };
  }
  return { limited: false, retryAfter: 0 };
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8')); } catch { return null; }
}
function saveProgress(p: any) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2)); }

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  SCHEDULED SEED RUNNER');
  console.log('═══════════════════════════════════════════════════════\n');

  // Check current rate limit status
  console.log('  Checking Spotify API rate limit status...');
  const { limited, retryAfter } = await checkRateLimit();

  if (limited) {
    const hours = Math.ceil(retryAfter / 3600);
    console.log(`  ⏳ Rate limited for ${retryAfter}s (~${hours}h)`);
    console.log(`  ⏳ Waiting for rate limit to expire...\n`);

    // Wait in 5-minute intervals
    let waited = 0;
    while (waited < retryAfter + 60) {
      const waitMs = Math.min(300000, (retryAfter + 60 - waited) * 1000);
      console.log(`  ⏳ Waiting ${Math.round(waitMs / 1000)}s (total waited: ${Math.round(waited / 60)}min)...`);
      await sleep(waitMs);
      waited += waitMs / 1000;

      // Check again
      const recheck = await checkRateLimit();
      if (!recheck.limited) {
        console.log('  ✅ Rate limit lifted!');
        break;
      }
    }
  } else {
    console.log('  ✅ No rate limit — ready to seed\n');
  }

  // Now run the actual seed
  console.log('  Starting seed...\n');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  let progress = loadProgress();
  if (!progress || progress.version !== 2) {
    progress = {
      version: 2, status: 'running',
      queries: { completed: [], failed: [], remaining: [...QUERIES] },
      stats: { songsCreated: 0, artistsCreated: 0, albumsCreated: 0, errors: 0 },
    };
  }
  progress.status = 'running';

  while (progress.queries.remaining.length > 0) {
    const query = progress.queries.remaining[0];

    try {
      // Search
      const tracks: any[] = [];
      const seen = new Set<string>();
      let offset = 0;

      while (tracks.length < 30) {
        const t = await getToken();
        const res = await fetch(`${SPOTIFY_API}/search?q=${encodeURIComponent(query)}&type=track&limit=10&offset=${offset}`, {
          headers: { Authorization: `Bearer ${t}` },
        });

        if (res.status === 429) {
          const wait = parseInt(res.headers.get('retry-after') || '60', 10) * 1000;
          console.log(`  ⏳ Rate limited during "${query}", waiting ${Math.round(wait / 1000)}s...`);
          await sleep(wait);
          continue;
        }
        if (!res.ok) break;

        const data = await res.json();
        const items = data?.tracks?.items || [];
        if (!items.length) break;

        for (const track of items) {
          if (!track?.id || seen.has(track.id) || !track.artists?.[0]) continue;
          seen.add(track.id);
          tracks.push(track);
          if (tracks.length >= 30) break;
        }

        offset += items.length;
        if (items.length < 10) break;
        await sleep(1000); // 1s between pages
      }

      // Insert songs
      for (const track of tracks) {
        try {
          // Find or create artist
          let artist = await prisma.artist.findFirst({ where: { spotifyId: track.artists[0].id } });
          if (!artist) {
            // Fetch artist details
            try {
              const t = await getToken();
              const aRes = await fetch(`${SPOTIFY_API}/artists/${track.artists[0].id}`, {
                headers: { Authorization: `Bearer ${t}` },
              });
              const aData = aRes.ok ? await aRes.json() : {};
              artist = await prisma.artist.create({
                data: {
                  name: track.artists[0].name, spotifyId: track.artists[0].id,
                  imageUrl: aData.images?.[0]?.url || null,
                  genres: aData.genres || [],
                  popularity: aData.popularity || 0,
                  followers: aData.followers?.total || 0,
                  verified: false,
                },
              });
              progress.stats.artistsCreated++;
            } catch {
              artist = await prisma.artist.create({
                data: { name: track.artists[0].name, spotifyId: track.artists[0].id, genres: [], verified: false },
              });
              progress.stats.artistsCreated++;
            }
          }

          // Skip if song exists
          const existing = await prisma.song.findUnique({ where: { spotifyId: track.id } });
          if (existing) continue;

          // Create song
          await prisma.song.create({
            data: {
              title: track.name, artistId: artist.id,
              albumName: track.album?.name || null,
              imageUrl: track.album?.images?.[0]?.url || null,
              spotifyId: track.id,
              spotifyPreviewUrl: track.preview_url || null,
              previewAvailable: !!track.preview_url,
              durationMs: track.duration_ms || null,
              trackNumber: track.track_number || null,
              releaseYear: track.album?.release_date ? parseInt(track.album.release_date.substring(0, 4), 10) : null,
              views: Math.floor(Math.random() * 5000),
            },
          });
          progress.stats.songsCreated++;
        } catch { /* skip track */ }
      }

      progress.queries.completed.push(query);
      progress.queries.remaining.shift();
      console.log(`  ✅ "${query}" done — ${tracks.length} tracks, total: ${progress.stats.songsCreated}`);

    } catch (err: any) {
      progress.stats.errors++;
      progress.queries.failed.push(query);
      progress.queries.remaining.shift();
      console.log(`  ❌ "${query}" failed: ${err.message}`);
    }

    saveProgress(progress);
    await sleep(3000); // 3s between queries
  }

  // Final
  const songs = await prisma.song.count();
  const artists = await prisma.artist.count();
  const albums = await prisma.album.count();

  progress.status = 'completed';
  saveProgress(progress);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  ✅ SEED COMPLETE');
  console.log(`  Songs:   ${songs}`);
  console.log(`  Artists: ${artists}`);
  console.log(`  Albums:  ${albums}`);
  console.log('═══════════════════════════════════════════════════════');

  await prisma.$disconnect();
  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); process.exitCode = 1; });
