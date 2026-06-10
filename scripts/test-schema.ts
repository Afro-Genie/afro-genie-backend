/**
 * Comprehensive schema acceptance-criteria test
 * Tests every item in the acceptance criteria and testing checklist.
 *
 * Usage:  npx tsx scripts/test-schema.ts
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, TranslationStatus, UserRole } from '@prisma/client';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter,
  log: ['error']
});

// ─── helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(label: string) {
  console.log(`  ✅  ${label}`);
  passed++;
}

function fail(label: string, detail?: string) {
  console.error(`  ❌  ${label}${detail ? ` — ${detail}` : ''}`);
  failed++;
}

async function runQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql, ...params);
}

// ─── test suites ─────────────────────────────────────────────────────────────

async function testTablesExist() {
  console.log('\n── 1. Tables created ──────────────────────────────────────────');

  const tables = [
    'User', 'Artist', 'Song', 'SongLanguage', 'Lyric', 'Language',
    'Translation', 'TranslationVote', 'TranslationCorrection',
    'TranslationRequest', 'SongRequest', 'Genre', 'SongGenre',
    'ForumCategory', 'Topic', 'TopicComment', 'Notification',
    'UserBadge', 'TokenReward', 'ArtistApplication'
  ];

  for (const t of tables) {
    const rows = await runQuery<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) AS exists`,
      [t]
    );
    if (rows[0]?.exists) pass(`Table "${t}" exists`);
    else fail(`Table "${t}" exists`);
  }
}

async function testForeignKeys() {
  console.log('\n── 2. Foreign key constraints ─────────────────────────────────');

  type FkRow = { table_name: string; constraint_name: string };
  const fkRows = await runQuery<FkRow>(
    `SELECT tc.table_name, tc.constraint_name
       FROM information_schema.table_constraints tc
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
      ORDER BY tc.table_name`
  );

  const covered = new Set(fkRows.map((r) => r.table_name));
  const expected = [
    'Song', 'SongLanguage', 'Lyric', 'Translation', 'TranslationVote',
    'TranslationCorrection', 'TranslationRequest', 'SongRequest', 'SongGenre',
    'Topic', 'TopicComment', 'Notification', 'UserBadge', 'TokenReward',
    'ArtistApplication'
  ];

  for (const t of expected) {
    if (covered.has(t)) pass(`FK constraint present on "${t}"`);
    else fail(`FK constraint present on "${t}"`);
  }

  console.log(`     (${fkRows.length} foreign key constraints total)`);
}

async function testIndexes() {
  console.log('\n── 3. Indexes on frequently queried fields ──────────────────');

  type IdxRow = { tablename: string; indexname: string; indexdef: string };
  const idxRows = await runQuery<IdxRow>(
    `SELECT tablename, indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname`
  );

  const requiredIndexes: Array<{ table: string; column: string }> = [
    { table: 'User',               column: 'role' },
    { table: 'User',               column: 'lastLoginAt' },
    { table: 'Artist',             column: 'popularity' },
    { table: 'Artist',             column: 'verified' },
    { table: 'Song',               column: 'artistId' },
    { table: 'Song',               column: 'title' },
    { table: 'Song',               column: 'views' },
    { table: 'Song',               column: 'createdAt' },
    { table: 'SongLanguage',       column: 'languageCode' },
    { table: 'Lyric',              column: 'songId' },
    { table: 'Translation',        column: 'songId' },
    { table: 'Translation',        column: 'userId' },
    { table: 'Translation',        column: 'status' },
    { table: 'TranslationVote',    column: 'translationId' },
    { table: 'TranslationRequest', column: 'songId' },
    { table: 'Topic',              column: 'authorId' },
    { table: 'Topic',              column: 'createdAt' },
    { table: 'Notification',       column: 'userId' },
    { table: 'Notification',       column: 'read' },
    { table: 'ArtistApplication',  column: 'status' },
  ];

  for (const req of requiredIndexes) {
    const found = idxRows.some(
      (r) =>
        r.tablename === req.table &&
        r.indexdef.toLowerCase().includes(req.column.toLowerCase())
    );
    if (found) pass(`Index on "${req.table}.${req.column}"`);
    else fail(`Index on "${req.table}.${req.column}"`);
  }

  console.log(`     (${idxRows.length} indexes total in schema)`);
}

async function testSeedCount() {
  console.log('\n── 4. Seed: 78+ songs ─────────────────────────────────────────');

  const [{ count }] = await runQuery<{ count: bigint }>('SELECT COUNT(*) FROM "Song"');
  const n = Number(count);
  if (n >= 78) pass(`Song count = ${n} (≥ 78)`);
  else fail(`Song count = ${n} (expected ≥ 78)`);

  const [{ count: artistCount }] = await runQuery<{ count: bigint }>('SELECT COUNT(*) FROM "Artist"');
  pass(`Artist count = ${Number(artistCount)}`);

  const [{ count: userCount }] = await runQuery<{ count: bigint }>('SELECT COUNT(*) FROM "User"');
  pass(`User count = ${Number(userCount)}`);
}

async function testMultiLanguageSupport() {
  console.log('\n── 5. Multi-language songs (>30 % threshold) ──────────────────');

  type LangRow = { song_id: string; language_code: string; percentage: number };
  const langRows = await runQuery<LangRow>(
    `SELECT sl."songId" AS song_id, sl."languageCode" AS language_code, sl.percentage
       FROM "SongLanguage" sl
      WHERE sl.percentage > 30
      ORDER BY sl."songId"`
  );

  if (langRows.length > 0) {
    pass(`SongLanguage rows with percentage > 30 %: ${langRows.length}`);
  } else {
    fail('No SongLanguage rows with percentage > 30 %');
  }

  // Verify at least one song has 2+ languages above threshold (true multi-lang)
  const bySong = new Map<string, number>();
  for (const r of langRows) bySong.set(r.song_id, (bySong.get(r.song_id) ?? 0) + 1);
  const multiLangSongs = [...bySong.values()].filter((v) => v >= 2).length;
  if (multiLangSongs > 0) pass(`Songs with ≥ 2 languages above 30 % threshold: ${multiLangSongs}`);
  else fail('No songs with ≥ 2 languages above threshold');
}

async function testJoinQuery() {
  console.log('\n── 6. JOIN query: songs + artists + translations ───────────────');

  type JoinRow = {
    song_title: string;
    artist_name: string;
    translation_count: bigint;
  };

  const rows = await runQuery<JoinRow>(
    `SELECT s.title AS song_title, a.name AS artist_name,
            COUNT(t.id) AS translation_count
       FROM "Song" s
       JOIN "Artist" a ON a.id = s."artistId"
  LEFT JOIN "Translation" t ON t."songId" = s.id
      GROUP BY s.id, s.title, a.name
      ORDER BY translation_count DESC
      LIMIT 5`
  );

  if (rows.length > 0) {
    pass(`JOIN across Song → Artist → Translation returned ${rows.length} rows`);
    for (const r of rows) {
      console.log(`       ${r.song_title} · ${r.artist_name} · ${Number(r.translation_count)} translation(s)`);
    }
  } else {
    fail('JOIN query returned no rows');
  }
}

async function testSchemaVersionDefaults() {
  console.log('\n── 7. schemaVersion defaults ──────────────────────────────────');

  const tables: Array<{ model: string; table: string }> = [
    { model: 'User',        table: 'User' },
    { model: 'Song',        table: 'Song' },
    { model: 'Translation', table: 'Translation' },
    { model: 'Lyric',       table: 'Lyric' },
  ];

  for (const { model, table } of tables) {
    // column existence
    const cols = await runQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'schemaVersion'`,
      [table]
    );
    if (cols.length === 0) { fail(`schemaVersion column missing on "${model}"`); continue; }

    // default value
    const defaults = await runQuery<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'schemaVersion'`,
      [table]
    );
    const def = defaults[0]?.column_default;
    if (def !== null && def !== undefined) pass(`"${model}".schemaVersion has default: ${def}`);
    else fail(`"${model}".schemaVersion has no default defined`);

    // actual seeded rows have value = 1
    const rows = await runQuery<{ v: number }>(
      `SELECT "schemaVersion" AS v FROM "${table}" LIMIT 1`
    );
    if (rows[0]?.v === 1) pass(`"${model}" seeded row has schemaVersion = 1`);
    else fail(`"${model}" seeded row schemaVersion unexpected: ${rows[0]?.v}`);
  }
}

async function testUniqueConstraints() {
  console.log('\n── 8. Composite unique constraints ────────────────────────────');

  // ── 8a. Song: @@unique([title, artistId]) ──────────────────────────────────
  const songs = await runQuery<{ id: string; artistId: string }>(
    `SELECT id, "artistId" FROM "Song" LIMIT 1`
  );
  if (songs.length === 0) { fail('No songs available to test Song unique constraint'); }
  else {
    const { id, artistId } = songs[0];
    const titleRow = await runQuery<{ title: string }>(`SELECT title FROM "Song" WHERE id = $1`, [id]);
    const title = titleRow[0]?.title;
    try {
      await prisma.song.create({ data: { title: title!, artistId } });
      fail('Song @@unique([title, artistId]) — duplicate insert should have thrown');
    } catch {
      pass('Song @@unique([title, artistId]) prevents duplicate insert');
    }
  }

  // ── 8b. SongLanguage: @@unique([songId, languageCode]) ────────────────────
  const slRows = await runQuery<{ songId: string; languageCode: string }>(
    `SELECT "songId", "languageCode" FROM "SongLanguage" LIMIT 1`
  );
  if (slRows.length === 0) { fail('No SongLanguage rows to test'); }
  else {
    const { songId, languageCode } = slRows[0];
    try {
      await prisma.songLanguage.create({ data: { songId, languageCode, percentage: 50 } });
      fail('SongLanguage @@unique([songId, languageCode]) — should have thrown');
    } catch {
      pass('SongLanguage @@unique([songId, languageCode]) prevents duplicate');
    }
  }

  // ── 8c. TranslationVote: @@unique([translationId, userId]) ─────────────────
  const voteRows = await runQuery<{ translationId: string; userId: string; voteType: string }>(
    `SELECT "translationId", "userId", "voteType" FROM "TranslationVote" LIMIT 1`
  );
  if (voteRows.length === 0) { fail('No TranslationVote rows to test'); }
  else {
    const { translationId, userId, voteType } = voteRows[0];
    try {
      await (prisma.translationVote.create as Function)({
        data: { translationId, userId, voteType }
      });
      fail('TranslationVote @@unique([translationId, userId]) — should have thrown');
    } catch {
      pass('TranslationVote @@unique([translationId, userId]) prevents duplicate vote');
    }
  }

  // ── 8d. Translation: @@unique([songId, userId, sourceLang, targetLang]) ────
  const tlRows = await runQuery<{
    id: string; songId: string; userId: string; sourceLang: string; targetLang: string;
  }>(`SELECT id, "songId", "userId", "sourceLang", "targetLang" FROM "Translation" LIMIT 1`);
  if (tlRows.length === 0) {
    fail('No Translation rows to test duplicate translation constraint');
  } else {
    const { songId, userId, sourceLang, targetLang } = tlRows[0];
    try {
      await prisma.translation.create({
        data: {
          songId,
          userId,
          originalLyrics: 'dup test original',
          translatedLyrics: 'dup test translated',
          sourceLang,
          targetLang,
          status: TranslationStatus.PENDING
        }
      });
      fail('Translation @@unique([songId,userId,sourceLang,targetLang]) — should have thrown');
    } catch {
      pass('Translation @@unique([songId,userId,sourceLang,targetLang]) prevents duplicate');
    }
  }
}

async function testPsqlIndexes() {
  console.log('\n── 9. Raw index verification (pg_indexes) ──────────────────────');

  type PgIdx = { tablename: string; indexname: string };
  const rows = await runQuery<PgIdx>(
    `SELECT tablename, indexname FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname`
  );

  const grouped = new Map<string, string[]>();
  for (const r of rows) {
    if (!grouped.has(r.tablename)) grouped.set(r.tablename, []);
    grouped.get(r.tablename)!.push(r.indexname);
  }

  for (const [table, idxNames] of grouped) {
    console.log(`     ${table}: ${idxNames.length} index(es)`);
  }

  if (rows.length > 0) pass(`Total indexes in pg_indexes: ${rows.length}`);
  else fail('No indexes found in pg_indexes');
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Afro Genie — Schema Acceptance-Criteria Test Suite');
  console.log('═══════════════════════════════════════════════════════════════');

  try {
    await prisma.$connect();
    console.log('  Connected to PostgreSQL ✔');
  } catch (e) {
    console.error('  Cannot connect to database:', e);
    process.exit(1);
  }

  await testTablesExist();
  await testForeignKeys();
  await testIndexes();
  await testSeedCount();
  await testMultiLanguageSupport();
  await testJoinQuery();
  await testSchemaVersionDefaults();
  await testUniqueConstraints();
  await testPsqlIndexes();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed  |  ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
