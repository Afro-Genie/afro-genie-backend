/**
 * Automate remaining remediation tasks:
 * 1. Last.fm artist backfill (for artists missing bio/popularity/followers)
 * 2. Lyrics backfill via LrcLib (direct API, bypasses pipeline)
 * 3. Report final DB state
 */

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { fetchLastFmArtist } from '../src/services/lastfmService';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const LRCLIB_BASE = 'https://lrclib.net/api';
const LRCLIB_TIMEOUT = 15000;

function parseLrc(lrc: string): Array<{ time: number; text: string }> {
  const result: Array<{ time: number; text: string }> = [];
  for (const line of lrc.split('\n')) {
    const m = line.trim().match(/^\[(\d{1,3}):(\d{2})\.(\d{2,3})\]\s*(.*)$/);
    if (!m) continue;
    const ms = m[3].length === 2 ? parseInt(m[3]) * 10 : parseInt(m[3]);
    const time = parseInt(m[1]) * 60 + parseInt(m[2]) + ms / 1000;
    if (m[4].trim()) result.push({ time, text: m[4].trim() });
  }
  return result;
}

async function backfillLastFmArtists() {
  console.log('\n═══ LAST.FM ARTIST BACKFILL ═══\n');

  const artists = await prisma.artist.findMany({
    where: {
      softDeleted: false,
      spotifyId: { not: null },
      OR: [
        { popularity: 0 },
        { followers: 0 },
        { bio: null },
      ],
    },
    select: { id: true, name: true, popularity: true, followers: true, bio: true, genres: true, imageUrl: true },
    orderBy: { updatedAt: 'asc' },
  });

  console.log(`Artists needing enrichment: ${artists.length}`);

  if (artists.length === 0) {
    console.log('All artists already enriched.');
    return { updated: 0, skipped: 0 };
  }

  let updated = 0, skipped = 0;

  for (let i = 0; i < artists.length; i++) {
    const artist = artists[i];
    const pct = `[${i + 1}/${artists.length}]`;

    try {
      const data = await fetchLastFmArtist(artist.name);
      if (!data) { skipped++; console.log(`  ${pct} ⏭ ${artist.name} (not found)`); }
      else {
        const update: Record<string, unknown> = {};
        if (data.listeners > 0 && artist.popularity === 0) update.popularity = data.listeners;
        if (data.playcount > 0 && artist.followers === 0) update.followers = data.playcount;
        if (data.bio && !artist.bio) update.bio = data.bio;
        if (data.imageUrl && !artist.imageUrl) update.imageUrl = data.imageUrl;
        if (data.tags.length > 0 && (!artist.genres || artist.genres.length === 0)) update.genres = data.tags;

        if (Object.keys(update).length > 0) {
          await prisma.artist.update({ where: { id: artist.id }, data: update });
          updated++;
          console.log(`  ${pct} ✅ ${artist.name} (${Object.keys(update).join(', ')})`);
        } else {
          skipped++;
          console.log(`  ${pct} ⏭ ${artist.name} (no updates needed)`);
        }
      }
    } catch (e: any) {
      skipped++;
      console.log(`  ${pct} ❌ ${artist.name}: ${e.message}`);
    }

    if (i < artists.length - 1) await new Promise(r => setTimeout(r, 250));
  }

  console.log(`\nLast.fm done: ${updated} updated, ${skipped} skipped`);
  return { updated, skipped };
}

async function backfillLyricsLrcLib() {
  console.log('\n═══ LYRICS BACKFILL (LRCLIB DIRECT) ═══\n');

  const songs = await prisma.$queryRawUnsafe<{ id: string; title: string; artistName: string }[]>(
    `SELECT s."id", s."title", a."name" as "artistName"
     FROM "Song" s
     JOIN "Artist" a ON a.id = s."artistId"
     JOIN "Lyric" l ON l."songId" = s."id"
     WHERE l."content" IS NULL
     ORDER BY RANDOM()`
  );

  console.log(`Songs needing lyrics: ${songs.length}`);

  if (songs.length === 0) {
    console.log('All songs already have lyrics.');
    return { filled: 0, skipped: 0, failed: 0 };
  }

  let filled = 0, skipped = 0, failed = 0;

  for (let i = 0; i < songs.length; i++) {
    const s = songs[i];
    const pct = `[${i + 1}/${songs.length}]`;

    const params = new URLSearchParams({ artist_name: s.artistName, track_name: s.title });
    const url = `${LRCLIB_BASE}/search?${params}`;

    let data: any[];
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(LRCLIB_TIMEOUT),
        headers: { 'User-Agent': 'AfroGenie/1.0 (afro-genie-backend)' },
      });
      if (!resp.ok) { skipped++; continue; }
      data = await resp.json() as any[];
      if (!Array.isArray(data) || data.length === 0) { skipped++; continue; }
    } catch {
      skipped++;
      continue;
    }

    const viable = data.filter((r: any) => !r.instrumental && (r.plainLyrics || r.syncedLyrics));
    if (viable.length === 0) { skipped++; continue; }

    const first = viable[0];
    const content = (first.syncedLyrics || first.plainLyrics || '').trim();
    if (!content) { skipped++; continue; }

    const synced = first.syncedLyrics?.trim() || null;
    const lyricLines = synced ? parseLrc(synced) : null;

    try {
      await prisma.lyric.update({
        where: { songId: s.id },
        data: {
          content,
          syncedLyrics: synced,
          lyricLines: lyricLines ? (lyricLines as any) : undefined,
          sourceProvider: 'LRCLIB',
          licenseStatus: 'LICENSED',
        },
      });
      filled++;
      console.log(`  ${pct} ✅ ${s.artistName} - ${s.title} (${content.length} chars)`);
    } catch (e: any) {
      failed++;
      console.log(`  ${pct} ❌ ${s.artistName} - ${s.title}: ${e.message}`);
    }

    if ((i + 1) % 10 === 0) await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\nLyrics done: ${filled} filled, ${skipped} skipped, ${failed} failed`);
  return { filled, skipped, failed };
}

async function reportFinalState() {
  console.log('\n═══ FINAL DB STATE ═══\n');

  const totalSongs = await prisma.song.count();
  const totalArtists = await prisma.artist.count();
  const totalLyrics = await prisma.lyric.count();
  const lyricsWithContent = await prisma.lyric.count({ where: { content: { not: null } } });
  const artistsWithBio = await prisma.artist.count({ where: { bio: { not: null } } });
  const translations = await prisma.translation.count();
  const genres = await prisma.genre.count();
  const songLanguages = await prisma.songLanguage.count();

  console.log(`Songs:            ${totalSongs}`);
  console.log(`Artists:          ${totalArtists} (${artistsWithBio} with bio)`);
  console.log(`Lyrics:           ${totalLyrics} (${lyricsWithContent} with content, ${totalLyrics - lyricsWithContent} null)`);
  console.log(`Translations:     ${translations}`);
  console.log(`Genres:           ${genres}`);
  console.log(`Song Languages:   ${songLanguages}`);
  console.log(`\nLyrics coverage:  ${(lyricsWithContent / totalSongs * 100).toFixed(1)}%`);
  console.log(`Artist bio coverage: ${(artistsWithBio / totalArtists * 100).toFixed(1)}%`);
}

async function main() {
  console.log('=== AFRO-GENIE AUTOMATED BACKFILL ===');

  await backfillLastFmArtists();
  await backfillLyricsLrcLib();
  await reportFinalState();

  console.log('\n=== COMPLETE ===');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect().then(() => pool.end()));
