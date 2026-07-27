import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const LRCLIB_BASE = 'https://lrclib.net/api';

function parseLrc(lrc: string) {
  const r: Array<{ time: number; text: string }> = [];
  for (const line of lrc.split('\n')) {
    const m = line.trim().match(/^\[(\d{1,3}):(\d{2})\.(\d{2,3})\]\s*(.*)$/);
    if (!m) continue;
    const ms = m[3].length === 2 ? parseInt(m[3]) * 10 : parseInt(m[3]);
    const time = parseInt(m[1]) * 60 + parseInt(m[2]) + ms / 1000;
    if (m[4].trim()) r.push({ time, text: m[4].trim() });
  }
  return r;
}

async function main() {
  const songs = await prisma.$queryRawUnsafe<{ id: string; title: string; artistName: string }[]>(
    `SELECT s."id", s."title", a."name" as "artistName"
     FROM "Song" s
     JOIN "Artist" a ON a.id = s."artistId"
     JOIN "Lyric" l ON l."songId" = s."id"
     WHERE l."content" IS NULL
     ORDER BY RANDOM()`
  );

  console.log(`Remaining songs needing lyrics: ${songs.length}`);
  let filled = 0, skipped = 0;

  for (let i = 0; i < songs.length; i++) {
    const s = songs[i];
    const params = new URLSearchParams({ artist_name: s.artistName, track_name: s.title });
    const url = `${LRCLIB_BASE}/search?${params}`;

    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'AfroGenie/1.0 (afro-genie-backend)' },
      });
      if (!resp.ok) { skipped++; continue; }
      const data = await resp.json() as any[];
      if (!Array.isArray(data) || data.length === 0) { skipped++; continue; }

      const viable = data.filter((r: any) => !r.instrumental && (r.plainLyrics || r.syncedLyrics));
      if (viable.length === 0) { skipped++; continue; }

      const content = (viable[0].syncedLyrics || viable[0].plainLyrics || '').trim();
      if (!content) { skipped++; continue; }

      const synced = viable[0].syncedLyrics?.trim() || null;
      const lyricLines = synced ? parseLrc(synced) : null;

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
      if (filled % 10 === 0) console.log(`  [${i + 1}/${songs.length}] filled so far: ${filled}`);
    } catch {
      skipped++;
    }

    if ((i + 1) % 10 === 0) await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\nDone: ${filled} filled, ${skipped} skipped out of ${songs.length}`);

  const totalLyrics = await prisma.lyric.count();
  const withContent = await prisma.lyric.count({ where: { content: { not: null } } });
  console.log(`\nDB state: ${withContent}/${totalLyrics} lyrics have content (${totalLyrics - withContent} still null)`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
