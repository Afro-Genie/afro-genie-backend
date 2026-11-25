import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { LicenseStatus, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import {
  estimateCostUsd,
  GeminiProvider,
  SUPPORTED_LANGUAGE_CODES,
} from '../src/services/aiProviders/geminiProvider';

const argv = process.argv.slice(2);
const hasFlag = (name: string): boolean => argv.includes(name);
const getFlagValue = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const apply = hasFlag('--apply');
const classify = hasFlag('--classify');
const confirmed = hasFlag('--yes');
const limit = Math.max(1, Number(getFlagValue('--limit', '50')) || 50);
const offset = Math.max(0, Number(getFlagValue('--offset', '0')) || 0);
const delayMs = Math.max(0, Number(getFlagValue('--delay-ms', '400')) || 0);
const minShare = Math.max(1, Number(getFlagValue('--min-share', '15')) || 15);
const only = getFlagValue('--only', 'missing');
const checkpointPath = path.join(__dirname, '.language-backfill-checkpoint.json');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const provider = new GeminiProvider();
const names = new Map<string, string>(SUPPORTED_LANGUAGE_CODES.map((item) => [item.code, item.name]));

const splitLyrics = (text: string, maxChars = 900): string[] => {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (line.length <= maxChars) {
      current = line;
      continue;
    }
    for (let i = 0; i < line.length; i += maxChars) {
      chunks.push(line.slice(i, i + maxChars));
    }
    current = '';
  }
  if (current) chunks.push(current);
  return chunks;
};

const loadCheckpoint = (): Set<string> => {
  if (!fs.existsSync(checkpointPath)) return new Set<string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as string[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set<string>();
  }
};

const saveCheckpoint = (ids: Set<string>): void => {
  fs.writeFileSync(checkpointPath, `${JSON.stringify([...ids], null, 2)}\n`, 'utf8');
};

const loadSongs = async () => {
  return prisma.song.findMany({
    where: { softDeleted: false },
    select: {
      id: true,
      title: true,
      songLanguages: { select: { languageCode: true, percentage: true } },
      lyrics: {
        where: { licenseStatus: { not: LicenseStatus.TAKEDOWN } },
        select: { content: true },
        take: 1,
      },
    },
    orderBy: { createdAt: 'asc' },
  });
};

const runInventory = async (): Promise<void> => {
  const songs = await loadSongs();
  const perCode = new Map<string, number>();
  const noLanguageWithLyrics: Array<{ id: string; title: string }> = [];
  const onlyEnglish: Array<{ id: string; title: string }> = [];
  let withLyrics = 0;
  let withLanguages = 0;
  let mixedRows = 0;
  let lowPercentageRows = 0;
  let unknownCodes = 0;

  for (const song of songs) {
    const content = song.lyrics[0]?.content?.trim() ?? '';
    if (content.length > 20) withLyrics += 1;
    const codes = song.songLanguages.filter((row) => row.percentage >= 30).map((row) => row.languageCode);
    if (codes.length > 0) withLanguages += 1;
    if (codes.length === 0 && content.length > 20) noLanguageWithLyrics.push({ id: song.id, title: song.title });
    if (codes.length === 1 && codes[0] === 'en') onlyEnglish.push({ id: song.id, title: song.title });
    for (const row of song.songLanguages) {
      perCode.set(row.languageCode, (perCode.get(row.languageCode) ?? 0) + 1);
      if (row.languageCode === 'mixed') mixedRows += 1;
      if (row.percentage < 30) lowPercentageRows += 1;
      if (!names.has(row.languageCode)) unknownCodes += 1;
    }
  }

  const languageRows = await prisma.language.findMany({
    select: { code: true, name: true, isActive: true },
    orderBy: { code: 'asc' },
  });

  console.log('\nLANGUAGE CATEGORIZATION INVENTORY');
  console.log('---------------------------------');
  console.log(`Active songs:                    ${songs.length}`);
  console.log(`Songs with usable lyrics:        ${withLyrics}`);
  console.log(`Songs with a >=30% language:     ${withLanguages}`);
  console.log(`Lyrics but no language:          ${noLanguageWithLyrics.length}`);
  console.log(`Only English:                    ${onlyEnglish.length}`);
  console.log(`"mixed" pseudo-language rows:    ${mixedRows}`);
  console.log(`Rows below 30%:                  ${lowPercentageRows}`);
  console.log(`Non-canonical codes:             ${unknownCodes}`);
  console.log('\nSongLanguage rows per code:');
  for (const [code, count] of [...perCode.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code.padEnd(6)} ${String(count).padStart(5)}  ${names.get(code) ?? '(not in frontend list)'}`);
  }
  console.log('\nLanguage table:');
  for (const row of languageRows) {
    console.log(`  ${row.code.padEnd(6)} ${row.name.padEnd(18)} active=${row.isActive}`);
  }
  console.log('\nFirst 10 songs needing classification:');
  for (const song of noLanguageWithLyrics.slice(0, 10)) {
    console.log(`  ${song.id}  ${song.title}`);
  }
  console.log('\nDry inventory only. No writes performed.\n');
};

const runClassification = async (): Promise<void> => {
  if (apply && !confirmed) {
    console.error('Refusing to write without --yes. Re-run with --apply --yes when ready.');
    process.exit(1);
  }

  const url = new URL(process.env.DATABASE_URL ?? '');
  console.log(`\nTarget database: ${url.protocol}//${url.host}`);
  console.log(apply ? 'APPLY MODE: database writes enabled' : 'DRY RUN: no database writes\n');

  const checkpoint = apply ? loadCheckpoint() : new Set<string>();
  const songs = await loadSongs();
  const eligible = songs.filter((song) => {
    const content = song.lyrics[0]?.content?.trim() ?? '';
    if (content.length <= 20) return false;
    const existing = song.songLanguages
      .filter((row) => row.languageCode !== 'mixed' && names.has(row.languageCode))
      .map((row) => row.languageCode);
    if (only === 'missing' && existing.length > 0) return false;
    return !checkpoint.has(song.id);
  });

  const batch = eligible.slice(offset, offset + limit);
  let processed = 0;
  let addedRows = 0;
  let convertedMixed = 0;
  let failed = 0;
  let tokensInput = 0;
  let tokensOutput = 0;

  console.log(`Eligible songs: ${eligible.length}; processing ${batch.length} (offset ${offset}, limit ${limit})\n`);

  for (const song of batch) {
    const content = song.lyrics[0]?.content?.trim() ?? '';
    const chunks = splitLyrics(content);
    const weights = new Map<string, number>();
    let songTokensIn = 0;
    let songTokensOut = 0;

    try {
      for (const chunk of chunks) {
        const result = await provider.detectLanguage(chunk);
        songTokensIn += result.tokensInput;
        songTokensOut += result.tokensOutput;
        const code = result.languageCode.trim().toLowerCase();
        if (names.has(code) && result.confidence > 0) {
          weights.set(code, (weights.get(code) ?? 0) + result.confidence * chunk.length);
        }
      }
    } catch (error) {
      failed += 1;
      console.warn(`  FAILED ${song.id} ${song.title}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    tokensInput += songTokensIn;
    tokensOutput += songTokensOut;
    const totalWeight = [...weights.values()].reduce((sum, value) => sum + value, 0);
    if (totalWeight <= 0) {
      console.log(`  SKIP   ${song.id} ${song.title} (no languages detected)`);
      continue;
    }

    const detected = [...weights.entries()]
      .map(([code, weight]) => ({ code, percentage: Number(((weight / totalWeight) * 100).toFixed(2)) }))
      .filter((item) => item.percentage >= minShare && names.has(item.code))
      .sort((a, b) => b.percentage - a.percentage);

    if (detected.length === 0) {
      console.log(`  SKIP   ${song.id} ${song.title} (all shares below ${minShare}%)`);
      continue;
    }

    const existing = new Set(song.songLanguages.map((row) => row.languageCode));
    const planned = detected.filter((item) => !existing.has(item.code));
    const summary = detected.map((item) => `${item.code}:${item.percentage}%`).join(' ');

    if (planned.length === 0) {
      console.log(`  OK     ${song.id} ${song.title} (no new codes) ${summary}`);
    } else {
      console.log(`  ${apply ? 'WRITE ' : 'PLAN  '} ${song.id} ${song.title} +${planned.map((item) => item.code).join(',')} ${summary}`);
    }

    if (apply) {
      for (const item of planned) {
        const name = names.get(item.code) ?? item.code.toUpperCase();
        await prisma.language.upsert({
          where: { code: item.code },
          create: { code: item.code, name, isActive: true },
          update: { name, isActive: true },
        });
        await prisma.songLanguage.upsert({
          where: { songId_languageCode: { songId: song.id, languageCode: item.code } },
          create: { songId: song.id, languageCode: item.code, percentage: item.percentage },
          update: { percentage: item.percentage },
        });
        addedRows += 1;
      }
      const mixedRows = await prisma.songLanguage.deleteMany({
        where: { songId: song.id, languageCode: 'mixed' },
      });
      convertedMixed += mixedRows.count;
      checkpoint.add(song.id);
      saveCheckpoint(checkpoint);
    }

    processed += 1;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const cost = estimateCostUsd(tokensInput, tokensOutput);
  console.log('\nSUMMARY');
  console.log(`  Processed:              ${processed}`);
  console.log(`  Failed detections:      ${failed}`);
  console.log(`  New language rows:      ${addedRows}`);
  console.log(`  Removed "mixed" rows:   ${convertedMixed}`);
  console.log(`  Tokens in/out:          ${tokensInput}/${tokensOutput}`);
  console.log(`  Estimated AI cost:      $${cost.toFixed(4)}`);
  console.log(apply ? '  Checkpoint updated.\n' : '  Dry run complete. No writes performed.\n');
};

async function main(): Promise<void> {
  if (classify) {
    await runClassification();
  } else {
    await runInventory();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
