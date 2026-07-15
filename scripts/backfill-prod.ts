/**
 * Production Lyrics + Language Backfill
 * 
 * Lyrics: LRCLIB direct API (no Redis), 20s timeout, processes songs sorted randomly
 * Language: Gemini 2.5 Flash, chunk-based detection
 * 
 * Usage:
 *   npx tsx scripts/backfill-prod.ts lyrics
 *   npx tsx scripts/backfill-prod.ts lang
 */

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';

const MODE = process.argv[2] || 'lyrics';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const LRCLIB_TIMEOUT = 20000;
const LRCLIB_BASE = 'https://lrclib.net/api';
const CHUNK_SIZE = 600;
const MIN_LANG_PCT = 30;

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

function splitChunks(text: string, max = CHUNK_SIZE): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    if ((cur + '\n' + line).trim().length > max && cur.trim()) {
      chunks.push(cur.trim());
      cur = line;
    } else {
      cur = cur ? cur + '\n' + line : line;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

async function backfillLyrics() {
  console.log('\n═══ LYRICS BACKFILL ═══\n');
  const start = Date.now();

  const songs = await prisma.$queryRawUnsafe<{ id: string; title: string; artistName: string }[]>(
    `SELECT s."id", s."title", a."name" as "artistName"
     FROM "Song" s
     JOIN "Artist" a ON a.id = s."artistId"
     JOIN "Lyric" l ON l."songId" = s."id"
     WHERE l."content" IS NULL
     ORDER BY RANDOM()`
  );

  console.log(`Songs needing lyrics: ${songs.length}\n`);

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

    // LRCLIB search returns full lyrics inline
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
      console.log(`  ${pct} ✅ ${s.artistName} - ${s.title} (${content.length} chars) [${filled} filled]`);
    } catch (e: any) {
      failed++;
      console.log(`  ${pct} ❌ ${s.artistName} - ${s.title}: ${e.message}`);
    }

    // Respect rate limits
    if ((i + 1) % 10 === 0) await new Promise(r => setTimeout(r, 1000));
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`\nDone in ${elapsed}s: ${filled} filled, ${skipped} skipped, ${failed} failed`);
}

async function backfillLang() {
  console.log('\n═══ LANGUAGE BACKFILL ═══\n');
  const start = Date.now();
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

  const songs = await prisma.$queryRawUnsafe<{ songId: string; content: string }[]>(
    `SELECT l."songId", l."content"
     FROM "Lyric" l
     LEFT JOIN "SongLanguage" sl ON sl."songId" = l."songId"
     WHERE sl."id" IS NULL
     AND l."content" IS NOT NULL
     AND LENGTH(l."content") > 10
     ORDER BY RANDOM()`
  );

  console.log(`Songs needing language: ${songs.length}\n`);

  let done = 0, skipped = 0;

  for (let i = 0; i < songs.length; i++) {
    const row = songs[i];
    const chunks = splitChunks(row.content);
    if (chunks.length === 0) { skipped++; continue; }

    const counts = new Map<string, number>();

    for (const chunk of chunks) {
      try {
        const model = genAI.getGenerativeModel({
          model: 'gemini-2.5-flash',
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT' as any,
              properties: {
                languageCode: { type: 'STRING' },
                confidence: { type: 'NUMBER' },
              },
              required: ['languageCode', 'confidence'],
            },
          },
        });
        const prompt = `Identify the primary language of these West African song lyrics. Return JSON: {"languageCode":"<code>","confidence":<0-1>}
Codes: yo=Yoruba, ig=Igbo, ha=Hausa, pcm=Nigerian Pidgin, en=English, fr=French, mixed=code-switching
Lyrics: ${chunk.substring(0, 1200)}`;
        const result = await model.generateContent(prompt);
        const parsed = JSON.parse(result.response.text());
        const code = parsed.languageCode?.trim().toLowerCase();
        if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
      } catch {
        // skip failed chunk
      }
      await new Promise(r => setTimeout(r, 300));
    }

    if (counts.size === 0) { skipped++; continue; }

    const total = chunks.length;
    let anyWritten = false;
    for (const [code, count] of counts.entries()) {
      const pct = Number(((count / total) * 100).toFixed(2));
      if (pct < MIN_LANG_PCT) continue;

      await prisma.language.upsert({
        where: { code },
        create: { code, name: code.toUpperCase() },
        update: {},
      });
      await prisma.songLanguage.upsert({
        where: { songId_languageCode: { songId: row.songId, languageCode: code } },
        create: { songId: row.songId, languageCode: code, percentage: pct },
        update: { percentage: pct },
      });
      anyWritten = true;
    }

    done++;
    const codes = Array.from(counts.entries()).map(([k, v]) => `${k}:${((v / total) * 100).toFixed(0)}%`).join(' ');
    console.log(`  [${i + 1}/${songs.length}] ✅ ${row.songId} → ${codes} [${done} done]`);

    if ((i + 1) % 10 === 0) await new Promise(r => setTimeout(r, 500));
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`\nDone in ${elapsed}s: ${done} categorized, ${skipped} skipped`);
}

async function main() {
  if (MODE === 'lyrics') await backfillLyrics();
  if (MODE === 'lang') await backfillLang();

  const totalSongs = await prisma.song.count();
  const lyricCount = await prisma.lyric.count({ where: { content: { not: null } } });
  const langCount = await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
    `SELECT COUNT(DISTINCT "songId") as cnt FROM "SongLanguage"`
  );
  console.log(`\n═══ FINAL ═══`);
  console.log(`Songs: ${totalSongs} | Lyrics: ${lyricCount} (${(lyricCount / totalSongs * 100).toFixed(1)}%) | Languages: ${Number(langCount[0].cnt)} (${(Number(langCount[0].cnt) / totalSongs * 100).toFixed(1)}%)`);

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
