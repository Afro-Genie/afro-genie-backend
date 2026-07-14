/**
 * Playlist-Based Spotify Seed — The Reliable Approach
 *
 * WHY: Search API gets rate-limited after ~300 results. Playlists return
 * 100 tracks per call with minimal rate limiting. This is how the production
 * CatalogSeeder works — we just need to run it standalone.
 *
 * This script imports from curated African Spotify playlists + the catalog
 * seeder's default playlists, giving us 1000+ songs reliably.
 *
 * Usage:
 *   npx tsx scripts/playlist-seed.ts
 *   npx tsx scripts/playlist-seed.ts --resume
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const PROGRESS_FILE = path.join(__dirname, '..', '.playlist-seed-progress.json');
const SPOTIFY_API = 'https://api.spotify.com/v1';

// Curated playlists — each yields 50-100 tracks
const PLAYLISTS = [
  // Afrobeats
  { id: '37i9dQZF1DX70RN3TfWWJh', name: 'Afrobeats Hits', genre: 'Afrobeats' },
  { id: '37i9dQZF1DX48TUlHJFJQy', name: 'African Heat', genre: 'Afrobeats' },
  { id: '37i9dQZF1DX1XfuTID4plq', name: 'Afrobeats Rising', genre: 'Afrobeats' },
  // Amapiano
  { id: '37i9dQZF1DWYn5uZTUxl32', name: 'Amapiano Grooves', genre: 'Amapiano' },
  { id: '37i9dQZF1DWZFmyF5TOM5K', name: 'Amapiano Africa', genre: 'Amapiano' },
  // Bongo Flava / East Africa
  { id: '37i9dQZF1DX7Q6hK1gDMcS', name: 'Bongo Flava', genre: 'Afrobeats' },
  { id: '37i9dQZF1DX9tPFwDMEDy1', name: 'Africa Rising', genre: 'Afropop' },
  // Highlife
  { id: '37i9dQZF1DX1lVhptIYRsa', name: 'Highlife Classics', genre: 'Highlife' },
  // Afro Fusion
  { id: '37i9dQZF1DXcFwqoL3JWZR', name: 'Afro Fusion', genre: 'Afro-fusion' },
  // Dancehall
  { id: '37i9dQZF1DX0SM0LYsmbmt', name: 'Dancehall Official', genre: 'Dancehall' },
  // R&B
  { id: '37i9dQZF1DWVqJMsg4Crbp', name: 'African R&B', genre: 'R&B' },
  // Hip-Hop
  { id: '37i9dQZF1DX4dyzvuaRJ0n', name: 'African Hip-Hop', genre: 'Hip-Hop' },
  // Extra
  { id: '37i9dQZF1DWYJblCnYxQCk', name: 'Naija Hits', genre: 'Afrobeats' },
  { id: '37i9dQZF1DX6VDO8a6cVVZ', name: 'African Gold', genre: 'Afrobeats' },
  { id: '37i9dQZF1DX4XUicVUrl7p', name: 'Afro-Pop', genre: 'Afropop' },
];

// Language mapping based on genre/playlist
const GENRE_LANGUAGE_MAP: Record<string, { code: string; pct: number }[]> = {
  'Afrobeats': [{ code: 'en', pct: 60 }, { code: 'pcm', pct: 40 }],
  'Afropop': [{ code: 'en', pct: 65 }, { code: 'pcm', pct: 35 }],
  'Afro-fusion': [{ code: 'en', pct: 60 }, { code: 'pcm', pct: 40 }],
  'Amapiano': [{ code: 'en', pct: 80 }, { code: 'sw', pct: 20 }],
  'Highlife': [{ code: 'en', pct: 70 }, { code: 'ha', pct: 30 }],
  'Dancehall': [{ code: 'en', pct: 100 }],
  'R&B': [{ code: 'en', pct: 100 }],
  'Hip-Hop': [{ code: 'en', pct: 90 }, { code: 'pcm', pct: 10 }],
};

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

async function spotifyGet(url: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const t = await getToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
    if (res.status === 429) {
      const wait = Math.min(parseInt(res.headers.get('retry-after') || '30', 10) * 1000, 120000);
      console.log(`  ⏳ Rate limited, waiting ${Math.round(wait / 1000)}s...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (res.status === 401) { token = ''; continue; }
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }
  throw new Error('API failed after retries');
}

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8')); } catch { return null; }
}
function saveProgress(p: any) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2)); }

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  PLAYLIST-BASED SPOTIFY SEED');
  console.log('═══════════════════════════════════════════════════════\n');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const resume = process.argv.includes('--resume');
  let progress = resume ? loadProgress() : null;
  if (!progress) {
    progress = {
      completed: [], failed: [],
      songsCreated: 0, artistsCreated: 0, albumsCreated: 0,
      totalSongs: 0, totalArtists: 0, totalAlbums: 0,
    };
  }

  await getToken();
  console.log('  Token acquired\n');

  const playlistSeeder = {
    async seed(playlistId: string, genre: string) {
      let offset = 0;
      const seen = new Set<string>();
      let created = 0;
      let skipped = 0;

      // Fetch up to 200 tracks per playlist (2 pages of 100)
      while (offset < 200) {
        const data = await spotifyGet(`${SPOTIFY_API}/playlists/${playlistId}/tracks?limit=100&offset=${offset}`);
        const items = data.items || [];
        if (!items.length) break;

        for (const item of items) {
          const track = item.track;
          if (!track?.id || seen.has(track.id) || !track.artists?.[0]) continue;
          seen.add(track.id);

          try {
            // Upsert artist
            let artist = await prisma.artist.findFirst({ where: { spotifyId: track.artists[0].id } });
            if (!artist) {
              let artistDetails: any = {};
              try {
                const aRes = await spotifyGet(`${SPOTIFY_API}/artists/${track.artists[0].id}`);
                artistDetails = aRes || {};
              } catch { /* skip details */ }

              artist = await prisma.artist.create({
                data: {
                  name: track.artists[0].name,
                  spotifyId: track.artists[0].id,
                  imageUrl: artistDetails.images?.[0]?.url || null,
                  genres: artistDetails.genres || [],
                  popularity: artistDetails.popularity || 0,
                  followers: artistDetails.followers?.total || 0,
                  verified: false,
                },
              });
              progress.artistsCreated++;
            }

            // Upsert album
            let albumId: string | null = null;
            if (track.album) {
              let album = await prisma.album.findFirst({ where: { spotifyId: track.album.id } });
              if (!album) {
                album = await prisma.album.create({
                  data: {
                    name: track.album.name, artistId: artist.id,
                    spotifyId: track.album.id,
                    imageUrl: track.album.images?.[0]?.url || null,
                    releaseYear: track.album.release_date ? parseInt(track.album.release_date.substring(0, 4), 10) : null,
                    totalTracks: track.album.total_tracks || null,
                    popularity: 0, genres: [],
                  },
                });
                progress.albumsCreated++;
              }
              albumId = album.id;
            }

            // Upsert song
            const existingSong = await prisma.song.findUnique({ where: { spotifyId: track.id } });
            if (!existingSong) {
              const song = await prisma.song.create({
                data: {
                  title: track.name, artistId: artist.id, albumId,
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

              // Link genre
              const genreRecord = await prisma.genre.upsert({
                where: { name: genre }, create: { name: genre }, update: {},
              });
              await prisma.songGenre.create({ data: { songId: song.id, genreId: genreRecord.id } });

              // Link language
              const langs = GENRE_LANGUAGE_MAP[genre] || GENRE_LANGUAGE_MAP['Afrobeats'];
              for (const l of langs) {
                await prisma.language.upsert({ where: { code: l.code }, create: { code: l.code, name: l.code === 'en' ? 'English' : l.code === 'pcm' ? 'Nigerian Pidgin' : l.code === 'sw' ? 'Swahili' : l.code === 'ha' ? 'Hausa' : l.code }, update: {} });
                await prisma.songLanguage.create({ data: { songId: song.id, languageCode: l.code, percentage: l.pct } });
              }

              // Create lyric placeholder
              await prisma.lyric.create({ data: { songId: song.id, content: null, sourceProvider: 'MANUAL', licenseStatus: 'UNKNOWN' } });

              created++;
            } else {
              skipped++;
            }
          } catch (err: any) {
            // Skip individual track errors
          }
        }

        offset += items.length;
        if (!data.next || offset >= 200) break;
        await new Promise(r => setTimeout(r, 500));
      }

      return { created, skipped, total: seen.size };
    }
  };

  // Process playlists
  for (let i = 0; i < PLAYLISTS.length; i++) {
    const pl = PLAYLISTS[i];
    if (progress.completed.includes(pl.id)) {
      console.log(`  ⏭️  ${pl.name} (already done)`);
      continue;
    }

    console.log(`  🎵 [${i + 1}/${PLAYLISTS.length}] ${pl.name} (${pl.genre})`);
    try {
      const result = await playlistSeeder.seed(pl.id, pl.genre);
      progress.songsCreated += result.created;
      console.log(`     → ${result.created} new songs, ${result.skipped} skipped (${result.total} total)`);

      progress.completed.push(pl.id);
    } catch (err: any) {
      console.log(`     ❌ Failed: ${err.message}`);
      progress.failed.push(pl.id);
    }

    saveProgress(progress);
    await new Promise(r => setTimeout(r, 1000)); // pace between playlists
  }

  // Final counts
  const songs = await prisma.song.count();
  const artists = await prisma.artist.count();
  const albums = await prisma.album.count();
  const genreLinks = await prisma.songGenre.count();
  const langLinks = await prisma.songLanguage.count();

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  ✅ PLAYLIST SEED COMPLETE');
  console.log(`  Songs:         ${songs}`);
  console.log(`  Artists:       ${artists}`);
  console.log(`  Albums:        ${albums}`);
  console.log(`  Genre links:   ${genreLinks}`);
  console.log(`  Language links: ${langLinks}`);
  console.log(`  New songs:     ${progress.songsCreated}`);
  console.log(`  New artists:   ${progress.artistsCreated}`);
  console.log(`  New albums:    ${progress.albumsCreated}`);
  console.log('═══════════════════════════════════════════════════════');

  saveProgress(progress);
  await prisma.$disconnect();
  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); process.exitCode = 1; });
