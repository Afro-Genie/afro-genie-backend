/**
 * Deep audit of Spotify seed data quality.
 * Shows exactly what came from Spotify vs what's placeholder/fallback.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       SPOTIFY SEED DATA QUALITY AUDIT');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── Songs ──
  const totalSongs = await prisma.song.count();
  const songsWithSpotify = await prisma.song.count({ where: { spotifyId: { not: null } } });
  const songsWithPreview = await prisma.song.count({ where: { spotifyPreviewUrl: { not: null } } });
  const songsWithAlbum = await prisma.song.count({ where: { albumId: { not: null } } });
  const songsWithImage = await prisma.song.count({ where: { imageUrl: { not: null } } });
  const songsWithYear = await prisma.song.count({ where: { releaseYear: { not: null } } });
  const songsWithDuration = await prisma.song.count({ where: { durationMs: { not: null } } });

  console.log('  📊 SONGS');
  console.log(`  Total songs:              ${totalSongs}`);
  console.log(`  With Spotify ID:          ${songsWithSpotify} (${pct(songsWithSpotify, totalSongs)})`);
  console.log(`  With preview URL:         ${songsWithPreview} (${pct(songsWithPreview, totalSongs)})`);
  console.log(`  Linked to album:          ${songsWithAlbum} (${pct(songsWithAlbum, totalSongs)})`);
  console.log(`  With image:               ${songsWithImage} (${pct(songsWithImage, totalSongs)})`);
  console.log(`  With release year:        ${songsWithYear} (${pct(songsWithYear, totalSongs)})`);
  console.log(`  With duration:            ${songsWithDuration} (${pct(songsWithDuration, totalSongs)})`);

  // ── Artists ──
  const totalArtists = await prisma.artist.count();
  const artistsWithSpotify = await prisma.artist.count({ where: { spotifyId: { not: null } } });
  const artistsWithImage = await prisma.artist.count({ where: { imageUrl: { not: null } } });
  const artistsWithGenres = await prisma.artist.count({
    where: { genres: { isEmpty: false } },
  });
  const artistsWithFollowers = await prisma.artist.count({ where: { followers: { gt: 0 } } });

  console.log('\n  🎤 ARTISTS');
  console.log(`  Total artists:            ${totalArtists}`);
  console.log(`  With Spotify ID:          ${artistsWithSpotify} (${pct(artistsWithSpotify, totalArtists)})`);
  console.log(`  With image:               ${artistsWithImage} (${pct(artistsWithImage, totalArtists)})`);
  console.log(`  With genres:              ${artistsWithGenres} (${pct(artistsWithGenres, totalArtists)})`);
  console.log(`  With followers > 0:       ${artistsWithFollowers} (${pct(artistsWithFollowers, totalArtists)})`);

  // ── Albums ──
  const totalAlbums = await prisma.album.count();
  const albumsWithSpotify = await prisma.album.count({ where: { spotifyId: { not: null } } });
  const albumsWithImage = await prisma.album.count({ where: { imageUrl: { not: null } } });
  const albumsWithYear = await prisma.album.count({ where: { releaseYear: { not: null } } });

  console.log('\n  💿 ALBUMS');
  console.log(`  Total albums:             ${totalAlbums}`);
  console.log(`  With Spotify ID:          ${albumsWithSpotify} (${pct(albumsWithSpotify, totalAlbums)})`);
  console.log(`  With image:               ${albumsWithImage} (${pct(albumsWithImage, totalAlbums)})`);
  console.log(`  With release year:        ${albumsWithYear} (${pct(albumsWithYear, totalAlbums)})`);

  // ── Junction Tables ──
  const songGenres = await prisma.songGenre.count();
  const songLanguages = await prisma.songLanguage.count();
  const lyricsCount = await prisma.lyric.count();
  const lyricsWithContent = await prisma.lyric.count({ where: { content: { not: null } } });

  console.log('\n  🔗 JUNCTION TABLES');
  console.log(`  SongGenre links:          ${songGenres}`);
  console.log(`  SongLanguage links:       ${songLanguages}`);
  console.log(`  Lyric records:            ${lyricsCount}`);
  console.log(`  Lyrics with content:      ${lyricsWithContent} (${pct(lyricsWithContent, lyricsCount)})`);

  // ── Sample songs to see data quality ──
  console.log('\n  📋 SAMPLE SONGS (first 10):');
  const sampleSongs = await prisma.song.findMany({
    take: 10,
    select: {
      title: true, spotifyId: true, imageUrl: true, releaseYear: true,
      durationMs: true, previewAvailable: true,
      artist: { select: { name: true, spotifyId: true } },
      genres: { include: { genre: { select: { name: true } } } },
      songLanguages: { select: { languageCode: true, percentage: true } },
    },
  });

  for (const s of sampleSongs) {
    const genreNames = s.genres.map(g => g.genre.name).join(', ') || 'NONE';
    const langStr = s.songLanguages.map(l => `${l.languageCode}:${l.percentage}%`).join(', ') || 'NONE';
    console.log(`    ${s.title} — ${s.artist.name}`);
    console.log(`      Spotify: ${s.spotifyId ? '✅' : '❌'} | Album art: ${s.imageUrl ? '✅' : '❌'} | Year: ${s.releaseYear || '❌'} | Preview: ${s.previewAvailable ? '✅' : '❌'}`);
    console.log(`      Genres: ${genreNames}`);
    console.log(`      Languages: ${langStr}`);
  }

  // ── Spotify token test ──
  console.log('\n  🔑 SPOTIFY API STATUS:');
  const hasCreds = !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
  console.log(`  Credentials configured:   ${hasCreds ? '✅ Yes' : '❌ No'}`);

  if (hasCreds) {
    try {
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
        },
        body: 'grant_type=client_credentials',
      });
      if (res.ok) {
        const data = await res.json();
        console.log(`  Token obtainable:         ✅ Yes (expires in ${data.expires_in}s)`);
      } else {
        console.log(`  Token obtainable:         ❌ No (HTTP ${res.status})`);
      }
    } catch (e: any) {
      console.log(`  Token obtainable:         ❌ Error: ${e.message}`);
    }
  }

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  VERDICT');
  console.log('═══════════════════════════════════════════════════════════════');
  if (songsWithSpotify === totalSongs && totalSongs > 0) {
    console.log('  ✅ All songs have Spotify data — seed was successful');
  } else if (songsWithSpotify > 0) {
    console.log(`  ⚠️  ${totalSongs - songsWithSpotify} songs missing Spotify data`);
  } else {
    console.log('  ❌ No songs have Spotify data — seed failed');
  }

  if (lyricsWithContent === 0 && lyricsCount > 0) {
    console.log('  ⚠️  All lyrics are NULL placeholders — enrichment pipeline not run');
  }

  await prisma.$disconnect();
  await pool.end();
}

function pct(part: number, total: number): string {
  if (total === 0) return '0%';
  return Math.round((part / total) * 100) + '%';
}

main().catch(err => { console.error(err); process.exitCode = 1; });
