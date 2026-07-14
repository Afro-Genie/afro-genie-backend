/**
 * Batch Seed Runner with Progress Tracking & Resume Capability
 *
 * Processes Spotify queries in configurable batches, writes progress to
 * seed-progress.json for real-time monitoring, and supports resume from
 * last successful batch.
 *
 * Usage:
 *   npx tsx scripts/batch-seed.ts              # Run all batches
 *   npx tsx scripts/batch-seed.ts --resume     # Resume from last checkpoint
 *   npx tsx scripts/batch-seed.ts --batch 5    # Process 5 queries per batch
 *   npx tsx scripts/batch-seed.ts --monitor    # Show current progress and exit
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// ─── Config ──────────────────────────────────────────────────────────────────

const PROGRESS_FILE = path.join(__dirname, '..', 'seed-progress.json');
const BATCH_SIZE = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--batch') || '5', 10);
const RESUME_MODE = process.argv.includes('--resume');
const MONITOR_ONLY = process.argv.includes('--monitor');
const SPOTIFY_API = 'https://api.spotify.com/v1';

const SEARCH_QUERIES = [
  'afrobeats', 'amapiano', 'afropop', 'nigerian music', 'african music',
  'afro fusion', 'highlife', 'bongo flava', 'gengetone', 'afro r&b',
  'dancehall africa', 'naija hits', 'burna boy', 'wizkid', 'davido',
  'tems', 'asake', 'rema', 'fireboy dml', 'ayra starr',
  'black sherif', 'tiwa savage', 'sauti sol', 'sarkodie', 'diamond platnumz',
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProgressData {
  startedAt: string;
  lastUpdatedAt: string;
  totalQueries: number;
  completedQueries: number;
  failedQueries: string[];
  currentBatch: number;
  totalBatches: number;
  stats: {
    songsCreated: number;
    artistsCreated: number;
    albumsCreated: number;
    songsSkipped: number;
    artistsSkipped: number;
    albumsSkipped: number;
    errors: number;
  };
  dbCounts: {
    songs: number;
    artists: number;
    albums: number;
  };
  status: 'running' | 'paused' | 'completed' | 'failed';
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

// ─── Progress Management ─────────────────────────────────────────────────────

function loadProgress(): ProgressData | null {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

function saveProgress(data: ProgressData): void {
  data.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
}

function initProgress(): ProgressData {
  const totalBatches = Math.ceil(SEARCH_QUERIES.length / BATCH_SIZE);
  return {
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    totalQueries: SEARCH_QUERIES.length,
    completedQueries: 0,
    failedQueries: [],
    currentBatch: 0,
    totalBatches,
    stats: {
      songsCreated: 0, artistsCreated: 0, albumsCreated: 0,
      songsSkipped: 0, artistsSkipped: 0, albumsSkipped: 0,
      errors: 0,
    },
    dbCounts: { songs: 0, artists: 0, albums: 0 },
    status: 'running',
    logs: [],
  };
}

function log(progress: ProgressData, msg: string): void {
  const timestamp = new Date().toISOString().substring(11, 19);
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  progress.logs.push(line);
  if (progress.logs.length > 200) progress.logs = progress.logs.slice(-100);
}

// ─── Spotify Functions ───────────────────────────────────────────────────────

let currentToken = '';

async function getSpotifyToken(): Promise<string> {
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
  currentToken = data.access_token;
  return currentToken;
}

async function spotifyFetch(url: string, retries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res = await fetch(url, { headers: { Authorization: `Bearer ${currentToken}` } });
    if (res.status === 401) {
      await getSpotifyToken();
      res = await fetch(url, { headers: { Authorization: `Bearer ${currentToken}` } });
    }
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '10', 10);
      console.log(`    ⏳ Rate limited, waiting ${retryAfter}s...`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }
    return res;
  }
  throw new Error(`Spotify API failed after ${retries} retries`);
}

// ─── Batch Processing ────────────────────────────────────────────────────────

async function fetchTracksForQuery(query: string, limit = 30): Promise<TrackData[]> {
  const tracks: TrackData[] = [];
  const seen = new Set<string>();
  let offset = 0;

  while (tracks.length < limit) {
    const url = `${SPOTIFY_API}/search?q=${encodeURIComponent(query)}&type=track&limit=10&offset=${offset}`;
    let res: Response;
    try {
      res = await spotifyFetch(url);
    } catch {
      await new Promise(r => setTimeout(r, 2000));
      try { res = await spotifyFetch(url); } catch { break; }
    }
    if (!res.ok) break;

    const data = await res.json();
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
      if (tracks.length >= limit) break;
    }
    offset += items.length;
    if (items.length < 10) break;
    await new Promise(r => setTimeout(r, 500));
  }
  return tracks;
}

async function insertBatch(
  prisma: PrismaClient,
  tracks: TrackData[],
  progress: ProgressData,
): Promise<void> {
  if (!tracks.length) return;

  // ── Artists ──
  const artistMap = new Map<string, string>();
  for (const t of tracks) {
    if (!artistMap.has(t.artistSpotifyId)) artistMap.set(t.artistSpotifyId, t.artistName);
  }

  const existingArtists = await prisma.artist.findMany({
    where: { spotifyId: { in: [...artistMap.keys()] } },
    select: { id: true, spotifyId: true },
  });
  const existingArtistIds = new Map(existingArtists.map(a => [a.spotifyId, a.id]));
  progress.stats.artistsSkipped += existingArtistIds.size;

  const newArtists: any[] = [];
  for (const [spotifyId, name] of artistMap) {
    if (existingArtistIds.has(spotifyId)) continue;
    try {
      const res = await spotifyFetch(`${SPOTIFY_API}/artists/${spotifyId}`);
      const details = res.ok ? await res.json() : {};
      newArtists.push({
        name, spotifyId,
        imageUrl: details.images?.[0]?.url || null,
        genres: details.genres || [],
        popularity: details.popularity || 0,
        followers: details.followers?.total || 0,
        verified: false,
      });
    } catch {
      newArtists.push({ name, spotifyId, genres: [], popularity: 0, followers: 0, verified: false });
    }
  }

  if (newArtists.length > 0) {
    await prisma.artist.createMany({ data: newArtists, skipDuplicates: true });
    progress.stats.artistsCreated += newArtists.length;
  }

  // Re-fetch all artist IDs
  const allArtists = await prisma.artist.findMany({
    where: { spotifyId: { in: [...artistMap.keys()] } },
    select: { id: true, spotifyId: true },
  });
  const dbArtistMap = new Map(allArtists.map(a => [a.spotifyId, a.id]));

  // ── Albums ──
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
    select: { id: true, spotifyId: true },
  });
  const existingAlbumIds = new Set(existingAlbums.map(a => a.spotifyId));
  progress.stats.albumsSkipped += existingAlbumIds.size;

  const newAlbums: any[] = [];
  for (const [spotifyId, info] of albumMap) {
    if (existingAlbumIds.has(spotifyId)) continue;
    const dbArtistId = dbArtistMap.get(info.artistSpotifyId);
    if (!dbArtistId) continue;
    newAlbums.push({
      name: info.name, artistId: dbArtistId, spotifyId,
      imageUrl: info.image, releaseYear: info.year,
      totalTracks: null, popularity: 0, genres: [],
    });
  }

  if (newAlbums.length > 0) {
    await prisma.album.createMany({ data: newAlbums, skipDuplicates: true });
    progress.stats.albumsCreated += newAlbums.length;
  }

  // Re-fetch album IDs
  const allAlbums = await prisma.album.findMany({
    where: { spotifyId: { in: [...albumMap.keys()] } },
    select: { id: true, spotifyId: true },
  });
  const dbAlbumMap = new Map(allAlbums.map(a => [a.spotifyId, a.id]));

  // ── Songs ──
  const existingSongs = await prisma.song.findMany({
    where: { spotifyId: { in: tracks.map(t => t.track.id) } },
    select: { spotifyId: true },
  });
  const existingSongIds = new Set(existingSongs.map(s => s.spotifyId));
  progress.stats.songsSkipped += existingSongIds.size;

  const newSongs: any[] = [];
  for (const t of tracks) {
    if (existingSongIds.has(t.track.id)) continue;
    const dbArtistId = dbArtistMap.get(t.artistSpotifyId);
    if (!dbArtistId) continue;
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

  // Insert songs in sub-batches of 50
  for (let i = 0; i < newSongs.length; i += 50) {
    const batch = newSongs.slice(i, i + 50);
    await prisma.song.createMany({ data: batch, skipDuplicates: true });
    progress.stats.songsCreated += batch.length;
  }
}

async function updateDbCounts(prisma: PrismaClient, progress: ProgressData): Promise<void> {
  progress.dbCounts.songs = await prisma.song.count();
  progress.dbCounts.artists = await prisma.artist.count();
  progress.dbCounts.albums = await prisma.album.count();
}

// ─── Monitor Display ─────────────────────────────────────────────────────────

function displayProgress(progress: ProgressData): void {
  const pct = progress.totalQueries > 0
    ? Math.round((progress.completedQueries / progress.totalQueries) * 100)
    : 0;
  const barLen = 30;
  const filled = Math.round((pct / 100) * barLen);
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);

  console.clear();
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           AFRO-GENIE SEED PROGRESS MONITOR              ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Status:     ${progress.status.toUpperCase().padEnd(42)}║`);
  console.log(`║  Started:    ${progress.startedAt.substring(0, 19).padEnd(42)}║`);
  console.log(`║  Updated:    ${progress.lastUpdatedAt.substring(0, 19).padEnd(42)}║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Queries:    ${progress.completedQueries}/${progress.totalQueries} ${bar} ${pct}%  ║`);
  console.log(`║  Batches:    ${progress.currentBatch}/${progress.totalBatches} complete${' '.repeat(30)}║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  📊 DB COUNTS (live)                                    ║`);
  console.log(`║  Songs:      ${String(progress.dbCounts.songs).padEnd(42)}║`);
  console.log(`║  Artists:    ${String(progress.dbCounts.artists).padEnd(42)}║`);
  console.log(`║  Albums:     ${String(progress.dbCounts.albums).padEnd(42)}║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  📈 THIS RUN                                            ║`);
  console.log(`║  Songs +:    ${String(progress.stats.songsCreated).padEnd(42)}║`);
  console.log(`║  Artists +:  ${String(progress.stats.artistsCreated).padEnd(42)}║`);
  console.log(`║  Albums +:   ${String(progress.stats.albumsCreated).padEnd(42)}║`);
  console.log(`║  Skipped:    ${String(progress.stats.songsSkipped + progress.stats.artistsSkipped + progress.stats.albumsSkipped).padEnd(42)}║`);
  console.log(`║  Errors:     ${String(progress.stats.errors).padEnd(42)}║`);
  if (progress.failedQueries.length > 0) {
    console.log(`║  Failed:     ${progress.failedQueries.join(', ').substring(0, 41).padEnd(42)}║`);
  }
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Last 5 log entries:                                    ║');
  for (const log of progress.logs.slice(-5)) {
    console.log(`║  ${log.substring(0, 57).padEnd(57)}║`);
  }
  console.log('╚══════════════════════════════════════════════════════════╝');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Monitor mode: just show current progress
  if (MONITOR_ONLY) {
    const progress = loadProgress();
    if (!progress) {
      console.log('No seed-progress.json found. Seed has not been started yet.');
      return;
    }
    displayProgress(progress);
    return;
  }

  // Initialize
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  let progress: ProgressData;

  if (RESUME_MODE) {
    const existing = loadProgress();
    if (existing && existing.status !== 'completed') {
      progress = existing;
      progress.status = 'running';
      log(progress, `Resuming from batch ${progress.currentBatch + 1}/${progress.totalBatches}`);
    } else {
      progress = initProgress();
      log(progress, 'Starting fresh seed run');
    }
  } else {
    progress = initProgress();
    log(progress, 'Starting fresh seed run');
  }

  await getSpotifyToken();
  log(progress, 'Spotify token acquired');

  // Get initial DB counts
  await updateDbCounts(prisma, progress);
  log(progress, `Initial DB: ${progress.dbCounts.songs} songs, ${progress.dbCounts.artists} artists, ${progress.dbCounts.albums} albums`);

  // Process batches
  const startBatch = progress.currentBatch;
  for (let batchIdx = startBatch; batchIdx < progress.totalBatches; batchIdx++) {
    progress.currentBatch = batchIdx;
    const batchStart = batchIdx * BATCH_SIZE;
    const batchEnd = Math.min(batchStart + BATCH_SIZE, SEARCH_QUERIES.length);
    const batchQueries = SEARCH_QUERIES.slice(batchStart, batchEnd);

    log(progress, `━━━ Batch ${batchIdx + 1}/${progress.totalBatches}: [${batchQueries.join(', ')}] ━━━`);
    saveProgress(progress);

    for (const query of batchQueries) {
      try {
        log(progress, `  🔍 Searching: "${query}"`);
        const tracks = await fetchTracksForQuery(query, 30);
        log(progress, `  📀 Found ${tracks.length} tracks`);

        if (tracks.length > 0) {
          await insertBatch(prisma, tracks, progress);
          log(progress, `  ✅ Inserted: +${progress.stats.songsCreated} songs total`);
        }

        progress.completedQueries++;
        log(progress, `  ✓ "${query}" complete (${progress.completedQueries}/${progress.totalQueries})`);
      } catch (err: any) {
        progress.stats.errors++;
        progress.failedQueries.push(query);
        log(progress, `  ❌ "${query}" failed: ${err.message}`);
      }

      // Update DB counts every query
      await updateDbCounts(prisma, progress);
      displayProgress(progress);
      saveProgress(progress);

      // Rate limit between queries
      await new Promise(r => setTimeout(r, 800));
    }

    log(progress, `Batch ${batchIdx + 1} complete. DB: ${progress.dbCounts.songs} songs, ${progress.dbCounts.artists} artists`);
    saveProgress(progress);
  }

  // Final
  await updateDbCounts(prisma, progress);
  progress.status = 'completed';
  saveProgress(progress);

  log(progress, '═══════════════════════════════════════════════════════');
  log(progress, `✅ SEED COMPLETE`);
  log(progress, `   Songs:   ${progress.dbCounts.songs}`);
  log(progress, `   Artists: ${progress.dbCounts.artists}`);
  log(progress, `   Albums:  ${progress.dbCounts.albums}`);
  log(progress, `   New songs created: ${progress.stats.songsCreated}`);
  log(progress, `   New artists created: ${progress.stats.artistsCreated}`);
  log(progress, `   New albums created: ${progress.stats.albumsCreated}`);
  log(progress, `   Errors: ${progress.stats.errors}`);
  log(progress, `   Failed queries: ${progress.failedQueries.join(', ') || 'none'}`);
  displayProgress(progress);
  saveProgress(progress);

  await prisma.$disconnect();
  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  const progress = loadProgress();
  if (progress) {
    progress.status = 'failed';
    progress.logs.push(`[FATAL] ${err.message}`);
    saveProgress(progress);
  }
  process.exitCode = 1;
});
