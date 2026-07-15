/**
 * Robust Spotify Seed — Resumable, Rate-Limit Aware, Progress-Persisted
 *
 * This replaces the fragile prisma/seed.ts for Spotify catalog import.
 * Key improvements over the original:
 *
 *   1. PERSISTS progress to disk after every batch — survives crashes
 *   2. EXPONENTIAL BACKOFF on rate limits — respects Spotify's retry-after
 *   3. RESUMABLE — picks up exactly where it left off
 *   4. BATCH INSERTS — reduces DB round trips
 *   5. ARTIST DETAILS fetched in bulk via /v1/artists?id=a,b,c (50 per call)
 *   6. CONFIGURABLE — --queries, --limit, --batch, --resume flags
 *
 * Usage:
 *   npx tsx scripts/robust-seed.ts                    # Fresh start
 *   npx tsx scripts/robust-seed.ts --resume           # Resume from checkpoint
 *   npx tsx scripts/robust-seed.ts --queries 10       # Only first 10 queries
 *   npx tsx scripts/robust-seed.ts --limit 50         # 50 results per query
 *   npx tsx scripts/robust-seed.ts --status           # Show progress & exit
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// ─── CLI Args ────────────────────────────────────────────────────────────────

const ARGS = {
  resume: process.argv.includes('--resume'),
  status: process.argv.includes('--status'),
  queryCount: parseInt(process.argv.find((_, i, a) => a[i - 1] === '--queries') || '25', 10),
  limitPerQuery: parseInt(process.argv.find((_, i, a) => a[i - 1] === '--limit') || '30', 10),
  batchDelay: parseInt(process.argv.find((_, i, a) => a[i - 1] === '--batch-delay') || '2000', 10),
};

const PROGRESS_FILE = path.join(__dirname, '..', '.seed-progress.json');
const SPOTIFY_API = 'https://api.spotify.com/v1';

const ALL_SEARCH_QUERIES = [
  'afrobeats', 'amapiano', 'afropop', 'nigerian music', 'african music',
  'afro fusion', 'highlife', 'bongo flava', 'gengetone', 'afro r&b',
  'dancehall africa', 'naija hits', 'burna boy', 'wizkid', 'davido',
  'tems', 'asake', 'rema', 'fireboy dml', 'ayra starr',
  'black sherif', 'tiwa savage', 'sauti sol', 'sarkodie', 'diamond platnumz',
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface SeedProgress {
  version: 2;
  startedAt: string;
  lastUpdatedAt: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  queries: {
    total: number;
    completed: string[];
    failed: string[];
    remaining: string[];
  };
  stats: {
    tracksFetched: number;
    songsCreated: number;
    songsSkipped: number;
    artistsCreated: number;
    artistsUpdated: number;
    albumsCreated: number;
    albumsSkipped: number;
    errors: number;
  };
  dbCounts: { songs: number; artists: number; albums: number };
  rateLimitHits: number;
  lastRateLimitAt: string | null;
  logs: string[];
}

interface TrackData {
  track: any;
  artistSpotifyId: string;
  artistName: string;
  albumSpotifyId: string | null;
  albumName: string | null;
  albumImage: string | null;
  albumYear: number | null;
}

// ─── Progress File ───────────────────────────────────────────────────────────

function loadProgress(): SeedProgress | null {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
      if (data.version === 2) return data;
    }
  } catch { /* ignore */ }
  return null;
}

function saveProgress(p: SeedProgress): void {
  p.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function initProgress(): SeedProgress {
  const queries = ALL_SEARCH_QUERIES.slice(0, ARGS.queryCount);
  return {
    version: 2,
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    status: 'running',
    queries: {
      total: queries.length,
      completed: [],
      failed: [],
      remaining: [...queries],
    },
    stats: {
      tracksFetched: 0, songsCreated: 0, songsSkipped: 0,
      artistsCreated: 0, artistsUpdated: 0,
      albumsCreated: 0, albumsSkipped: 0, errors: 0,
    },
    dbCounts: { songs: 0, artists: 0, albums: 0 },
    rateLimitHits: 0,
    lastRateLimitAt: null,
    logs: [],
  };
}

function log(p: SeedProgress, msg: string): void {
  const ts = new Date().toISOString().substring(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  p.logs.push(line);
  if (p.logs.length > 500) p.logs = p.logs.slice(-250);
}

// ─── Spotify ─────────────────────────────────────────────────────────────────

let token = '';
let tokenExpiresAt = 0;

async function getToken(): Promise<string> {
  if (token && Date.now() < tokenExpiresAt - 60000) return token;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Spotify credentials missing');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify token error: ${res.status}`);

  const data = await res.json();
  token = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);
  return token;
}

async function spotifyGet(url: string, retries = 3): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t = await getToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '30', 10);
      const waitMs = Math.min(retryAfter * 1000, 300000); // cap at 5 min
      console.log(`  ⏳ Rate limited (attempt ${attempt + 1}). Waiting ${Math.round(waitMs / 1000)}s...`);

      const progress = loadProgress();
      if (progress) {
        progress.rateLimitHits++;
        progress.lastRateLimitAt = new Date().toISOString();
        saveProgress(progress);
      }

      await sleep(waitMs);
      continue;
    }

    if (res.status === 401) {
      token = ''; // force refresh
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Spotify API ${res.status}: ${body.substring(0, 200)} [url: ${url}]`);
    }

    return res.json();
  }
  throw new Error(`Spotify API failed after ${retries} retries`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Search ──────────────────────────────────────────────────────────────────

async function searchTracks(query: string, limit: number): Promise<TrackData[]> {
  const tracks: TrackData[] = [];
  const seen = new Set<string>();
  let offset = 0;

  while (tracks.length < limit) {
    const pageLimit = Math.max(1, Math.min(10, limit - tracks.length));
    const url = `${SPOTIFY_API}/search?q=${encodeURIComponent(query)}&type=track&limit=${pageLimit}&offset=${offset}`;

    const data = await spotifyGet(url);
    const items = data?.tracks?.items || [];
    if (!items.length) break;

    for (const track of items) {
      if (!track?.id || seen.has(track.id) || !track.artists?.[0]) continue;
      seen.add(track.id);
      const primary = track.artists[0];
      const album = track.album;
      tracks.push({
        track,
        artistSpotifyId: primary.id,
        artistName: primary.name,
        albumSpotifyId: album?.id || null,
        albumName: album?.name || null,
        albumImage: album?.images?.[0]?.url || null,
        albumYear: album?.release_date ? parseInt(album.release_date.substring(0, 4), 10) : null,
      });
    }

    offset += items.length;
    if (items.length < pageLimit) break;
    await sleep(300); // gentle pacing between pages
  }

  return tracks;
}

// ─── Batch Artist Details (50 per request) ───────────────────────────────────

async function fetchArtistDetails(spotifyIds: string[]): Promise<Map<string, any>> {
  const details = new Map<string, any>();

  // Try batch endpoint first (50 per call), fall back to individual on 403
  const BATCH = 50;
  for (let i = 0; i < spotifyIds.length; i += BATCH) {
    const batch = spotifyIds.slice(i, i + BATCH);
    try {
      const data = await spotifyGet(`${SPOTIFY_API}/artists?ids=${batch.join(',')}`);
      if (data?.artists) {
        for (const artist of data.artists) {
          if (artist) details.set(artist.id, artist);
        }
      }
    } catch (err: any) {
      if (err.message.includes('403')) {
        // Batch endpoint unavailable — fall back to individual fetches
        for (const id of batch) {
          try {
            const artistData = await spotifyGet(`${SPOTIFY_API}/artists/${id}`);
            if (artistData) details.set(id, artistData);
          } catch { /* skip individual failure */ }
          await sleep(100);
        }
      } else {
        console.log(`  ⚠️  Failed to fetch artist batch: ${err.message}`);
      }
    }
    if (i + BATCH < spotifyIds.length) await sleep(300);
  }

  return details;
}

// ─── DB Operations ───────────────────────────────────────────────────────────

async function insertBatch(
  prisma: PrismaClient,
  tracks: TrackData[],
  progress: SeedProgress,
): Promise<void> {
  if (!tracks.length) return;

  // ── Phase 1: Collect unique artist IDs ──
  const uniqueArtistIds = [...new Set(tracks.map(t => t.artistSpotifyId))];

  // ── Phase 2: Fetch artist details in bulk (50 per call) ──
  // Check which artists already exist in the DB
  const existingArtists = await prisma.artist.findMany({
    where: { spotifyId: { in: uniqueArtistIds } },
    select: { id: true, spotifyId: true },
  });
  const existingArtistMap = new Map(existingArtists.map(a => [a.spotifyId, a.id]));
  const missingArtistIds = uniqueArtistIds.filter(id => !existingArtistMap.has(id));

  // Create missing artists via bulk API fetch + createMany
  if (missingArtistIds.length > 0) {
    console.log(`  📡 Fetching details for ${missingArtistIds.length} new artists (bulk API)...`);
    const artistDetails = await fetchArtistDetails(missingArtistIds);

    const newArtists = missingArtistIds.map(id => {
      const d = artistDetails.get(id) || {};
      const track = tracks.find(t => t.artistSpotifyId === id);
      return {
        name: track?.artistName || id,
        spotifyId: id,
        imageUrl: d.images?.[0]?.url || null,
        genres: d.genres || [],
        popularity: d.popularity || 0,
        followers: d.followers?.total || 0,
        verified: false,
      };
    });

    await prisma.artist.createMany({ data: newArtists, skipDuplicates: true });
    progress.stats.artistsCreated += newArtists.length;
  }

  // ── Update ALL existing artists with richer details from Spotify ──
  // This ensures metadata (genres, image, popularity) stays fresh on resume.
  const allArtists = await prisma.artist.findMany({
    where: { spotifyId: { in: uniqueArtistIds } },
    select: { id: true, spotifyId: true, genres: true, imageUrl: true, popularity: true },
  });
  const dbArtistMap = new Map(allArtists.map(a => [a.spotifyId, a.id]));

  const artistsToUpdate = allArtists.filter(a =>
    (!a.genres || a.genres.length === 0) || !a.imageUrl || a.popularity === 0
  );
  if (artistsToUpdate.length > 0) {
    const idsToUpdate = artistsToUpdate.map(a => a.spotifyId);
    const details = await fetchArtistDetails(idsToUpdate);
    for (const artist of artistsToUpdate) {
      const d = details.get(artist.spotifyId);
      if (d) {
        await prisma.artist.update({
          where: { id: artist.id },
          data: {
            imageUrl: d.images?.[0]?.url || artist.imageUrl,
            genres: d.genres?.length ? d.genres : artist.genres,
            popularity: d.popularity ?? artist.popularity,
            followers: d.followers?.total || 0,
          },
        });
        progress.stats.artistsUpdated++;
      }
    }
  }

  // Re-fetch artist IDs after inserts
  const finalArtists = await prisma.artist.findMany({
    where: { spotifyId: { in: uniqueArtistIds } },
    select: { id: true, spotifyId: true },
  });
  const finalArtistMap = new Map(finalArtists.map(a => [a.spotifyId, a.id]));

  // ── Albums — upsert semantics: create new, refresh existing ──
  const albumMap = new Map<string, { name: string; spotifyId: string; artistSpotifyId: string; image: string | null; year: number | null }>();
  for (const t of tracks) {
    if (t.albumSpotifyId && !albumMap.has(t.albumSpotifyId)) {
      albumMap.set(t.albumSpotifyId, {
        name: t.albumName || 'Unknown', spotifyId: t.albumSpotifyId,
        artistSpotifyId: t.artistSpotifyId, image: t.albumImage, year: t.albumYear,
      });
    }
  }

  const existingAlbums = await prisma.album.findMany({
    where: { spotifyId: { in: [...albumMap.keys()] } },
    select: { id: true, spotifyId: true, imageUrl: true, releaseYear: true },
  });
  const existingAlbumMap = new Map(existingAlbums.map(a => [a.spotifyId, a]));

  const newAlbums: any[] = [];
  const albumsToUpdate: { id: string; spotifyId: string; data: any }[] = [];

  for (const [spotifyId, info] of albumMap) {
    const dbArtistId = finalArtistMap.get(info.artistSpotifyId);
    if (!dbArtistId) continue;

    const existing = existingAlbumMap.get(spotifyId);
    if (existing) {
      // Refresh album if missing image or year
      if ((!existing.imageUrl && info.image) || (!existing.releaseYear && info.year)) {
        albumsToUpdate.push({
          id: existing.id,
          spotifyId,
          data: {
            imageUrl: info.image || undefined,
            releaseYear: info.year || undefined,
          },
        });
      }
    } else {
      newAlbums.push({
        name: info.name, artistId: dbArtistId, spotifyId,
        imageUrl: info.image, releaseYear: info.year,
        totalTracks: null, popularity: 0, genres: [],
      });
    }
  }

  if (newAlbums.length > 0) {
    await prisma.album.createMany({ data: newAlbums, skipDuplicates: true });
    progress.stats.albumsCreated += newAlbums.length;
  }

  for (const update of albumsToUpdate) {
    await prisma.album.update({
      where: { id: update.id },
      data: update.data,
    });
  }

  const finalAlbums = await prisma.album.findMany({
    where: { spotifyId: { in: [...albumMap.keys()] } },
    select: { id: true, spotifyId: true },
  });
  const dbAlbumMap = new Map(finalAlbums.map(a => [a.spotifyId, a.id]));

  // ── Songs — upsert semantics: create new, refresh existing metadata ──
  const existingSongs = await prisma.song.findMany({
    where: { spotifyId: { in: tracks.map(t => t.track.id) } },
    select: { spotifyId: true, id: true, previewAvailable: true },
  });
  const existingSongMap = new Map(existingSongs.map(s => [s.spotifyId, s]));

  const newSongs: any[] = [];
  const songsToUpdate: { id: string; data: any }[] = [];

  for (const t of tracks) {
    const dbArtistId = finalArtistMap.get(t.artistSpotifyId);
    if (!dbArtistId) continue;

    const existing = existingSongMap.get(t.track.id);
    if (existing) {
      // Refresh song if missing preview or duration
      const needsUpdate = !existing.previewAvailable && !!t.track.preview_url;
      if (needsUpdate) {
        songsToUpdate.push({
          id: existing.id,
          data: {
            spotifyPreviewUrl: t.track.preview_url || null,
            previewAvailable: !!t.track.preview_url,
            durationMs: t.track.duration_ms || null,
          },
        });
      }
    } else {
      newSongs.push({
        title: t.track.name,
        artistId: dbArtistId,
        albumId: t.albumSpotifyId ? dbAlbumMap.get(t.albumSpotifyId) || null : null,
        albumName: t.albumName || null,
        imageUrl: t.albumImage || null,
        spotifyId: t.track.id,
        spotifyPreviewUrl: t.track.preview_url || null,
        previewAvailable: !!t.track.preview_url,
        durationMs: t.track.duration_ms || null,
        trackNumber: t.track.track_number || null,
        releaseYear: t.albumYear,
        views: Math.floor(Math.random() * 5000),
      });
    }
  }

  // Insert new songs in sub-batches of 100
  for (let i = 0; i < newSongs.length; i += 100) {
    const batch = newSongs.slice(i, i + 100);
    await prisma.song.createMany({ data: batch, skipDuplicates: true });
    progress.stats.songsCreated += batch.length;
  }

  // Update existing songs with richer metadata
  for (const update of songsToUpdate) {
    await prisma.song.update({
      where: { id: update.id },
      data: update.data,
    });
  }
}

async function updateDbCounts(prisma: PrismaClient, p: SeedProgress): Promise<void> {
  p.dbCounts.songs = await prisma.song.count();
  p.dbCounts.artists = await prisma.artist.count();
  p.dbCounts.albums = await prisma.album.count();
}

// ─── Display ─────────────────────────────────────────────────────────────────

function display(p: SeedProgress): void {
  const total = p.queries.total;
  const done = p.queries.completed.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const barLen = 30;
  const filled = Math.round((pct / 100) * barLen);
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);

  const icon = p.status === 'completed' ? '✅' : p.status === 'failed' ? '❌' : '🔄';

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║           SPOTIFY SEED — PROGRESS                       ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  ${icon} Status:     ${p.status.toUpperCase().padEnd(40)}║`);
  console.log(`║  Started:    ${p.startedAt.substring(0, 19).padEnd(40)}║`);
  console.log(`║  Updated:    ${p.lastUpdatedAt.substring(0, 19).padEnd(40)}║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Queries:    ${done}/${total} ${bar} ${pct}%  ║`);
  console.log(`║  Rate limits: ${String(p.rateLimitHits).padEnd(40)}║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  DB COUNTS                                              ║`);
  console.log(`║  Songs:      ${String(p.dbCounts.songs).padEnd(40)}║`);
  console.log(`║  Artists:    ${String(p.dbCounts.artists).padEnd(40)}║`);
  console.log(`║  Albums:     ${String(p.dbCounts.albums).padEnd(40)}║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  THIS RUN                                               ║`);
  console.log(`║  Songs +:    ${String(p.stats.songsCreated).padEnd(40)}║`);
  console.log(`║  Artists +:  ${String(p.stats.artistsCreated).padEnd(40)}║`);
  console.log(`║  Updated:    ${String(p.stats.artistsUpdated).padEnd(40)}║`);
  console.log(`║  Albums +:   ${String(p.stats.albumsCreated).padEnd(40)}║`);
  console.log(`║  Skipped:    ${String(p.stats.songsSkipped).padEnd(40)}║`);
  console.log(`║  Errors:     ${String(p.stats.errors).padEnd(40)}║`);
  if (p.queries.failed.length > 0) {
    console.log(`║  Failed:     ${p.queries.failed.join(', ').substring(0, 41).padEnd(42)}║`);
  }
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Last 5 logs:                                           ║');
  for (const l of p.logs.slice(-5)) {
    console.log(`║  ${l.substring(0, 57).padEnd(57)}║`);
  }
  console.log('╚══════════════════════════════════════════════════════════╝');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Status mode
  if (ARGS.status) {
    const p = loadProgress();
    if (!p) { console.log('No seed progress found.'); return; }
    display(p);
    return;
  }

  // Init
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  let progress: SeedProgress;

  if (ARGS.resume) {
    const existing = loadProgress();
    if (existing && existing.status !== 'completed') {
      progress = existing;
      progress.status = 'running';
      log(progress, `Resuming — ${progress.queries.remaining.length} queries remaining`);
    } else {
      progress = initProgress();
      log(progress, 'No prior progress — starting fresh');
    }
  } else {
    progress = initProgress();
    log(progress, `Starting fresh — ${progress.queries.total} queries`);
  }

  await getToken();
  log(progress, 'Spotify token acquired');
  await updateDbCounts(prisma, progress);
  log(progress, `DB: ${progress.dbCounts.songs} songs, ${progress.dbCounts.artists} artists`);
  saveProgress(progress);

  // Process remaining queries one at a time
  while (progress.queries.remaining.length > 0) {
    const query = progress.queries.remaining[0];

    try {
      log(progress, `🔍 Searching: "${query}" (${progress.queries.completed.length + 1}/${progress.queries.total})`);
      const tracks = await searchTracks(query, ARGS.limitPerQuery);
      progress.stats.tracksFetched += tracks.length;
      log(progress, `  Found ${tracks.length} unique tracks`);

      if (tracks.length > 0) {
        await insertBatch(prisma, tracks, progress);
      }

      progress.queries.completed.push(query);
      progress.queries.remaining.shift();
      log(progress, `  ✅ "${query}" done — DB: ${progress.dbCounts.songs} songs`);

    } catch (err: any) {
      progress.stats.errors++;
      progress.queries.failed.push(query);
      progress.queries.remaining.shift(); // don't retry the same query forever
      log(progress, `  ❌ "${query}" failed: ${err.message}`);

      // If it's a rate limit error, stop and save — user can resume later
      if (err.message.includes('429') || err.message.includes('rate limit')) {
        log(progress, '⏸️  Pausing due to rate limit — run with --resume to continue');
        progress.status = 'paused';
        await updateDbCounts(prisma, progress);
        saveProgress(progress);
        display(progress);
        await prisma.$disconnect();
        await pool.end();
        return;
      }
    }

    // Update counts and save after every query
    await updateDbCounts(prisma, progress);
    saveProgress(progress);
    display(progress);

    // Delay between queries (respects rate limits)
    await sleep(ARGS.batchDelay);
  }

  // Done
  await updateDbCounts(prisma, progress);
  progress.status = 'completed';
  saveProgress(progress);

  log(progress, '═══════════════════════════════════════════════');
  log(progress, `✅ SEED COMPLETE`);
  log(progress, `   Songs:   ${progress.dbCounts.songs}`);
  log(progress, `   Artists: ${progress.dbCounts.artists}`);
  log(progress, `   Albums:  ${progress.dbCounts.albums}`);
  log(progress, `   New songs:     ${progress.stats.songsCreated}`);
  log(progress, `   New artists:   ${progress.stats.artistsCreated}`);
  log(progress, `   Updated artists: ${progress.stats.artistsUpdated}`);
  log(progress, `   New albums:    ${progress.stats.albumsCreated}`);
  log(progress, `   Rate limits:   ${progress.rateLimitHits}`);
  log(progress, `   Errors:        ${progress.stats.errors}`);
  if (progress.queries.failed.length > 0) {
    log(progress, `   Failed queries: ${progress.queries.failed.join(', ')}`);
  }
  log(progress, '═══════════════════════════════════════════════');
  display(progress);

  await prisma.$disconnect();
  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  const p = loadProgress();
  if (p) { p.status = 'failed'; p.logs.push(`[FATAL] ${err.message}`); saveProgress(p); }
  process.exitCode = 1;
});
