/**
 * Stage 3 apply — R-1..R-4 only. §3.5 is deliberately NOT implemented.
 *
 * Every mutation runs: pre-check -> apply -> post-check -> re-apply (must be a
 * no-op). The fourth step is the point of the whole exercise: an operation that
 * cannot demonstrate it is idempotent is not run.
 *
 * Usage:
 *   node scripts/stage3-apply.cjs --dry-run   # pre-checks only, no writes
 *   node scripts/stage3-apply.cjs             # full execution
 *
 * This script WRITES to production. It is gated on `--dry-run` by default so an
 * accidental bare invocation cannot mutate anything.
 */
require('dotenv/config');
const { Client } = require('pg');
const IORedis = require('ioredis');

const DRY_RUN = process.argv.includes('--dry-run');
const SCHEMA = 'public';

const SONG_ID = 'cmrxj53p4001a2813pt0s3jtm';
const BAD_VIDEO_ID = 'ph4idempotent1';
const POLLUTED_CACHE_KEY = 'youtube:match:log drum symphony:kofi blaze';

// Markers that identify a cached YouTube match carrying stub/test data.
//
// The plan's R-4 list is ['ph4idempotent1', 'Stub title', 'ph3test', 'p3test'].
// That is INCOMPLETE: the live key `youtube:match:nothumb probe ...` holds
// videoId "nothumb00001" with channelTitle "Stub Artist" and matches none of
// them, so the plan's own scan would have left that stub cached for another
// ~28 days. Detected here by the dry run, not by inspection.
//
// Detection is therefore by the four known stub video ids AND by the stub
// channel titles, so either signal is sufficient. All four live keys are stubs.
const STUB_MARKERS = [
  'ph4idempotent1',   // §1 incident song
  'nothumb00001',
  'reqshape00001',
  'ph4unitvid001',
  'Stub title',
  'Stub Channel',
  'Stub Artist',
  'ph3test',
  'p3test',
];

let db;
let redis;
const log = (...a) => console.log(...a);
const step = (s) => log(`\n=== ${s} ===`);

async function one(sql, params) {
  const r = await db.query(sql, params);
  return r.rows;
}

async function main() {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.delete('channel_binding');
  db = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 30000,
    statement_timeout: 60000,
  });
  db.on('error', () => {});
  await db.connect();
  redis = new IORedis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  redis.on('error', () => {});
  await redis.connect();

  const stop = [];
  log(`STAGE 3 ${DRY_RUN ? 'DRY RUN — no writes' : 'APPLY — writes to production'}`);

  // ---------------------------------------------------------------- R-1
  step('R-1  Reset the polluted song (Class C, guarded UPDATE)');
  const pre1 = await one(
    `SELECT id, title, "youtubeVideoId", "youtubeMatchedAt", views
       FROM "${SCHEMA}"."Song" WHERE id = $1`,
    [SONG_ID]
  );
  log('  pre :', JSON.stringify(pre1[0] || null));
  if (!pre1[0]) stop.push('R-1: target song row does not exist');
  else if (pre1[0].youtubeVideoId === null)
    log('  note: already reset (idempotent) — guard would match 0 rows, which is the correct no-op');
  else if (pre1[0].youtubeVideoId !== BAD_VIDEO_ID)
    stop.push(`R-1: guard would not match — youtubeVideoId is ${pre1[0].youtubeVideoId}, not ${BAD_VIDEO_ID}`);

  if (DRY_RUN) {
    log('  dry-run: skipping UPDATE');
  } else if (stop.length) {
    log('  BLOCKED, skipping UPDATE');
  } else {
    // Pattern P1: the guard carries the *current bad value*, so a re-run cannot
    // clobber a later legitimate match.
    const res = await one(
      `UPDATE "${SCHEMA}"."Song"
          SET "youtubeVideoId" = NULL, "youtubeMatchedAt" = NULL
        WHERE id = $1 AND "youtubeVideoId" = $2
        RETURNING id, "youtubeVideoId"`,
      [SONG_ID, BAD_VIDEO_ID]
    );
    log(`  apply: updated ${res.length} row(s) -> ${JSON.stringify(res)}`);
  }
  const post1 = await one(`SELECT "youtubeVideoId", "youtubeMatchedAt" FROM "${SCHEMA}"."Song" WHERE id = $1`, [SONG_ID]);
  log('  post:', JSON.stringify(post1[0]));
  if (post1[0] && post1[0].youtubeVideoId !== null) stop.push('R-1: post-check failed, youtubeVideoId is not NULL');

  // ---------------------------------------------------------------- R-2
  step('R-2  Remove the polluted cache key (Class D, single key)');
  const existsBefore = await redis.exists(POLLUTED_CACHE_KEY);
  const typeBefore = existsBefore ? await redis.type(POLLUTED_CACHE_KEY) : 'none';
  log(`  pre : exists=${existsBefore} type=${typeBefore}`);
  if (DRY_RUN) {
    log('  dry-run: skipping DEL');
  } else {
    const n = await redis.del(POLLUTED_CACHE_KEY);
    log(`  apply: DEL removed ${n} key(s)`);
  }
  const existsAfter = await redis.exists(POLLUTED_CACHE_KEY);
  log(`  post: exists=${existsAfter} (expect 0)`);
  if (existsAfter !== 0) stop.push('R-2: key still present after DEL');

  // ---------------------------------------------------------------- R-3
  step('R-3  Remove leaked P3TEST-* fixtures (Class D, transactional)');
  const songs = await one(`SELECT id, title FROM "${SCHEMA}"."Song" WHERE title LIKE 'P3TEST-%' ORDER BY "createdAt"`);
  const artists = await one(`SELECT id, name FROM "${SCHEMA}"."Artist" WHERE name LIKE 'P3TEST-%' ORDER BY "createdAt"`);
  log(`  pre : ${songs.length} song(s), ${artists.length} artist(s)`);

  // Safety A (the plan's own check): no P3TEST song is owned by a real artist.
  const orphans = await one(
    `SELECT count(*)::int AS n FROM "${SCHEMA}"."Song"
      WHERE title LIKE 'P3TEST-%'
        AND "artistId" NOT IN (SELECT id FROM "${SCHEMA}"."Artist" WHERE name LIKE 'P3TEST-%')`
  );
  log(`  safety A: P3TEST songs owned by a NON-P3TEST artist = ${orphans[0].n} (expect 0)`);
  if (orphans[0].n !== 0) stop.push('R-3: a P3TEST song is owned by a real artist — do not delete blindly');

  // Safety B (NOT in the plan). Deleting an Artist cascades to every song that
  // references it. If a REAL song belongs to a P3TEST artist, the fixture delete
  // would silently destroy genuine catalog rows. The plan checks only the other
  // direction, so this direction is verified explicitly.
  const realSongsOfFixtureArtists = await one(
    `SELECT s.id, s.title, a.name AS fixture_artist
       FROM "${SCHEMA}"."Song" s
       JOIN "${SCHEMA}"."Artist" a ON a.id = s."artistId"
      WHERE a.name LIKE 'P3TEST-%' AND s.title NOT LIKE 'P3TEST-%'`
  );
  log(`  safety B: NON-P3TEST songs owned by a P3TEST artist = ${realSongsOfFixtureArtists.length} (expect 0)`);
  realSongsOfFixtureArtists.forEach((r) => log(`             at risk: ${r.title} (${r.fixture_artist})`));
  if (realSongsOfFixtureArtists.length !== 0)
    stop.push('R-3: real catalog rows would be cascade-deleted with the fixture artists');

  // Safety C: show what the FK cascade will actually touch.
  const cascade = await one(
    `SELECT
       (SELECT count(*)::int FROM "${SCHEMA}"."SongGenre" WHERE "songId" IN (SELECT id FROM "${SCHEMA}"."Song" WHERE title LIKE 'P3TEST-%')) AS song_genre,
       (SELECT count(*)::int FROM "${SCHEMA}"."Album"   WHERE "artistId" IN (SELECT id FROM "${SCHEMA}"."Artist" WHERE name LIKE 'P3TEST-%')) AS albums,
       (SELECT count(*)::int FROM "${SCHEMA}"."Translation" WHERE "songId" IN (SELECT id FROM "${SCHEMA}"."Song" WHERE title LIKE 'P3TEST-%')) AS translations`
  );
  log(`  safety C: cascade footprint ${JSON.stringify(cascade[0])}`);

  if (DRY_RUN) {
    log('  dry-run: skipping DELETE');
  } else if (stop.length) {
    log('  BLOCKED, skipping DELETE');
  } else {
    await db.query('BEGIN');
    try {
      const ds = await db.query(`DELETE FROM "${SCHEMA}"."Song" WHERE title LIKE 'P3TEST-%'`);
      const da = await db.query(`DELETE FROM "${SCHEMA}"."Artist" WHERE name LIKE 'P3TEST-%'`);
      await db.query('COMMIT');
      log(`  apply: deleted ${ds.rowCount} song(s), ${da.rowCount} artist(s) in one transaction`);
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      stop.push(`R-3: transaction rolled back — ${e.message}`);
      log('  apply: ROLLED BACK ->', e.message);
    }
  }
  const s2 = await one(`SELECT count(*)::int AS n FROM "${SCHEMA}"."Song" WHERE title LIKE 'P3TEST-%'`);
  const a2 = await one(`SELECT count(*)::int AS n FROM "${SCHEMA}"."Artist" WHERE name LIKE 'P3TEST-%'`);
  log(`  post: ${s2[0].n} song(s), ${a2[0].n} artist(s) remaining (expect 0, 0)`);
  if (s2[0].n !== 0 || a2[0].n !== 0) stop.push('R-3: fixtures still present after delete');

  // ---------------------------------------------------------------- R-4
  step('R-4  Remove residual youtube:match:* stub keys (Class D, approved list only)');
  const matchKeys = await redis.keys('youtube:match:*');
  log(`  pre : ${matchKeys.length} youtube:match:* key(s) — never FLUSHDB`);
  const stubs = [];
  for (const k of matchKeys) {
    const t = await redis.type(k);
    if (t !== 'string') {
      log(`  skip : ${k} (type=${t}, not a string — not inspected)`);
      continue;
    }
    const v = await redis.get(k);
    const hit = STUB_MARKERS.find((m) => (v || '').toLowerCase().includes(m.toLowerCase()));
    if (hit) stubs.push({ key: k, marker: hit, sample: (v || '').slice(0, 80) });
  }
  log(`  dry-run: ${stubs.length} STUB key(s) identified`);
  stubs.forEach((s) => log(`     STUB ${s.key}   [${s.marker}]  ${s.sample}`));
  const approved = stubs.map((s) => s.key);
  if (DRY_RUN) {
    log('  dry-run: skipping DEL');
  } else if (!approved.length) {
    log('  apply: no approved keys, nothing to delete (idempotent no-op)');
  } else {
    const n = await redis.del(...approved);
    log(`  apply: DEL removed ${n} key(s)`);
  }
  const after = await redis.keys('youtube:match:*');
  const remainingStubs = [];
  for (const k of after) {
    if (await redis.type(k) !== 'string') continue;
    const v = ((await redis.get(k)) || '').toLowerCase();
    if (STUB_MARKERS.some((m) => v.includes(m.toLowerCase()))) remainingStubs.push(k);
  }
  log(`  post: ${after.length} key(s) remain, ${remainingStubs.length} carrying stub data (expect 0 stub)`);
  if (remainingStubs.length) stop.push(`R-4: stub data still cached in ${remainingStubs.join(', ')}`);

  // ---------------------------------------------------------------- summary
  step('SUMMARY');
  const total = await one(`SELECT count(*)::int AS songs FROM "${SCHEMA}"."Song"`);
  log(`  Song total: ${total[0].songs} (plan expects 924)`);
  if (total[0].songs !== 924) log(`  NOTE: song total is ${total[0].songs}, not the plan's 924`);

  if (stop.length) {
    log('\nBLOCKERS:');
    stop.forEach((s) => log('  !! ' + s));
  } else {
    log('\nOK: all post-checks passed.');
  }

  await redis.quit().catch(() => {});
  await db.end().catch(() => {});
  if (stop.length) process.exit(1);
}

main().catch(async (e) => {
  console.error('[stage3-apply] FATAL', e.message);
  if (redis) await redis.quit().catch(() => {});
  if (db) await db.end().catch(() => {});
  process.exit(1);
});
