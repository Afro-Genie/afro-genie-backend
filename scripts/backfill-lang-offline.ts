/**
 * Language Backfill using offline detection (franc-min) + keyword heuristics
 * 
 * No external API needed. Processes all songs with lyrics content.
 * 
 * Usage: npx tsx scripts/backfill-lang-offline.ts
 */

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { franc } from 'franc-min';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const CHUNK_SIZE = 600;
const MIN_LANG_PCT = 30;

// ─── Keyword-based overrides for African languages ───────────────────────────
// franc doesn't detect Yoruba/Igbo/Hausa/Pidgin well, so we check keywords first

const YORUBA_WORDS = new Set([
  'omo', 'omode', 'ode', 'oju', 'ori', 'ife', 'ay', 'aaye', 'eni', 'enian',
  'ni', 'ti', 'si', 'fun', 'pe', 'se', 'ko', 'lo', 'ga', 'wa', 'je', 'sun',
  'omo', 'owo', 'ile', 'ilu', 'oko', 'oba', 'alaye', 'olufe', 'omoluabi',
  'orin', 'igba', 'osun', 'sango', 'shango', 'osa', 'elewa', 'adura',
  'omo', 'aburo', 'egbon', 'iyawo', 'oko', 'baba', 'mama', 'omo', 'ara',
  'ko', 'mo', 'lo', 'se', 'ti', 'wa', 'ni', 'si', 'pe', 'fun', 'lati',
  'ninu', 'nipọn', 'lakoko', 'lẹyin', 'nitori', 'bibosi', 'nigba',
  'joko', 'dide', 'rin', 'sun', 'je', 'mu', 'gbeyin', 'fi', 'mu',
  'eyan', 'okunrin', 'obinrin', 'omo', 'ode', 'onije', 'alagbara',
]);

const IGBO_WORDS = new Set([
  'nna', 'nne', 'nwanne', 'chi', 'ife', 'ndu', 'obi', 'uzo', 'ala',
  'mmadu', 'agha', 'oha', 'Ụmụ', 'umunna', 'umunne', 'ime', 'azu',
  'isi', 'aka', 'egwu', 'ego', 'oha', 'oge', 'oge', 'mba', 'ndi',
  'ka', 'na', 'ga', 'si', 'ya', 'nu', 'emee', 'buru', 'nwere',
  'oge', 'na', 'di', 'nke', 'ile', 'anya', 'ebere', 'udo',
  'isi', 'ohia', 'ala', 'mmiri', 'ani', 'igwe', 'amamihe',
]);

const HAUSA_WORDS = new Set([
  'inna', 'baba', 'uwa', 'rayuwa', 'liman', 'sarki', 'gida', 'daka',
  'ka', 'ki', 'na', 'ta', 'ai', 'da', 'wa', 'ba', 'ma', 'ya',
  'mu', 'su', 'ku', 'ni', 'ce', 'jin', 'zan', 'za', 'kai',
  'lahani', 'addini', 'almajiri', 'wakar', 'wasan', 'gaisuwa',
  'sannu', 'lafiya', 'dorawa', 'zaman', 'ikilashi', 'farin ciki',
  'rana', 'dare', 'safe', 'yamma', 'gabas', 'arewa', 'kudu',
]);

const PIDGIN_MARKERS = [
  'dey', 'wetin', 'no be', 'na so', 'abeg', 'chop', 'wahala',
  'sabi', 'japa', 'oyinbo', 'naija', 'oga', 'mad', 'vex',
  'sha', 'sef', 'wey', 'dem', 'comot', 'gbana', 'yapa',
  'pele', 'how far', 'kuku', 'jare', 'oju', 'bros', 'sis',
  'abeg', 'kilode', 'omo', 'ehen', 'abo', 'wahala', 'gbegbe',
  'ajeji', 'alhaji', 'mallam', 'oga', 'oyibo', 'oyinbo',
];

function detectLanguageFromKeywords(text: string): Map<string, number> {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);
  const total = words.length;
  if (total === 0) return new Map();

  const counts = new Map<string, number>();

  // Check Pidgin markers (multi-word patterns)
  let pidginHits = 0;
  for (const marker of PIDGIN_MARKERS) {
    if (marker.includes(' ')) {
      if (lower.includes(marker)) pidginHits += 3; // multi-word matches count more
    } else {
      if (words.includes(marker)) pidginHits++;
    }
  }
  if (pidginHits > 0) counts.set('pcm', pidginHits);

  // Check single-word African language markers
  let yorubaHits = 0, igboHits = 0, hausaHits = 0;
  for (const w of words) {
    if (YORUBA_WORDS.has(w)) yorubaHits++;
    if (IGBO_WORDS.has(w)) igboHits++;
    if (HAUSA_WORDS.has(w)) hausaHits++;
  }
  if (yorubaHits > 0) counts.set('yo', yorubaHits);
  if (igboHits > 0) counts.set('ig', igboHits);
  if (hausaHits > 0) counts.set('ha', hausaHits);

  // Check for French patterns
  const frenchPatterns = /\b(le|la|les|de|du|des|un|une|et|est|en|je|tu|nous|vous|ils|elles|avec|pour|dans|sur|pas|mais|ou|qui|que|quoi|mon|ton|son|ma|ta|sa)\b/gi;
  const frenchMatches = lower.match(frenchPatterns);
  if (frenchMatches && frenchMatches.length > 3) counts.set('fr', frenchMatches.length);

  return counts;
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

async function main() {
  const start = Date.now();

  const songs = await prisma.$queryRawUnsafe<{ songId: string; content: string }[]>(
    `SELECT l."songId", l."content"
     FROM "Lyric" l
     LEFT JOIN "SongLanguage" sl ON sl."songId" = l."songId"
     WHERE sl."id" IS NULL
     AND l."content" IS NOT NULL
     AND LENGTH(l."content") > 10`
  );

  console.log(`Songs needing language: ${songs.length}\n`);

  let done = 0, skipped = 0;

  for (let i = 0; i < songs.length; i++) {
    const row = songs[i];
    const chunks = splitChunks(row.content);
    if (chunks.length === 0) { skipped++; continue; }

    // Combine keyword detection + franc for each chunk
    const allCounts = new Map<string, number>();

    for (const chunk of chunks) {
      // 1. Try keyword-based African language detection first
      const kwCounts = detectLanguageFromKeywords(chunk);

      if (kwCounts.size > 0) {
        // Use keyword detection
        for (const [code, count] of kwCounts.entries()) {
          allCounts.set(code, (allCounts.get(code) ?? 0) + count);
        }
      } else {
        // 2. Fall back to franc for other languages
        const plainText = chunk.replace(/\[.*?\]/g, '').replace(/[^a-zA-ZÀ-ÿ\s]/g, ' ').trim();
        if (plainText.length < 20) continue;

        const frCode = franc(plainText, { minLength: 20 });
        if (frCode === 'und') {
          // Unknown — default to English for African music
          allCounts.set('en', (allCounts.get('en') ?? 0) + 1);
        } else if (frCode === 'eng') {
          allCounts.set('en', (allCounts.get('en') ?? 0) + 1);
        } else if (frCode === 'fra') {
          allCounts.set('fr', (allCounts.get('fr') ?? 0) + 1);
        } else {
          // Map other franc codes to closest our code
          allCounts.set('en', (allCounts.get('en') ?? 0) + 1); // Default for non-French European languages in African music
        }
      }
    }

    if (allCounts.size === 0) { skipped++; continue; }

    // Check for heavy code-switching (mixed)
    const uniqueLangs = Array.from(allCounts.entries()).filter(([_, v]) => v > 0);
    const totalHits = uniqueLangs.reduce((sum, [_, v]) => sum + v, 0);

    let isMixed = false;
    if (uniqueLangs.length >= 2) {
      const sorted = uniqueLangs.sort((a, b) => b[1] - a[1]);
      const topPct = sorted[0][1] / totalHits;
      // If no single language dominates >60%, it's mixed
      if (topPct < 0.6) isMixed = true;
    }

    const finalCounts = new Map<string, number>();
    if (isMixed) {
      // Mark as mixed but still store individual percentages for reference
      finalCounts.set('mixed', totalHits);
    } else {
      for (const [code, count] of allCounts) {
        finalCounts.set(code, count);
      }
    }

    const total = chunks.length;
    let anyWritten = false;

    for (const [code, count] of finalCounts.entries()) {
      const pct = isMixed ? 100 : Number(((count / total) * 100).toFixed(2));
      if (!isMixed && pct < MIN_LANG_PCT) continue;

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
    const codes = Array.from(allCounts.entries()).map(([k, v]) => {
      const totalHits = Array.from(allCounts.values()).reduce((s, n) => s + n, 0);
      return `${k}:${((v / totalHits) * 100).toFixed(0)}%`;
    }).join(' ');
    console.log(`  [${i + 1}/${songs.length}] ${isMixed ? '🔀' : '✅'} ${row.songId} → ${codes}${isMixed ? ' (mixed)' : ''} [${done} done]`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);

  // Final stats
  const totalSongs = await prisma.song.count();
  const lyricCount = await prisma.lyric.count({ where: { content: { not: null } } });
  const langCount = await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
    `SELECT COUNT(DISTINCT "songId") as cnt FROM "SongLanguage"`
  );

  console.log(`\nDone in ${elapsed}s: ${done} categorized, ${skipped} skipped`);
  console.log(`\n═══ FINAL ═══`);
  console.log(`Songs: ${totalSongs} | Lyrics: ${lyricCount} (${(lyricCount / totalSongs * 100).toFixed(1)}%) | Languages: ${Number(langCount[0].cnt)} (${(Number(langCount[0].cnt) / totalSongs * 100).toFixed(1)}%)`);

  // Language breakdown
  const breakdown = await prisma.songLanguage.groupBy({
    by: ['languageCode'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  });
  console.log('\nLanguage breakdown:');
  for (const row of breakdown) {
    console.log(`  ${row.languageCode}: ${row._count.id}`);
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
