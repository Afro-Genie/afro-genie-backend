/**
 * Stage 3 dry-run probe — READ ONLY BY CONSTRUCTION.
 *
 * Prints the exact pre-state that `REMEDIATION-PLAN.md` §3 requires before any
 * R-1..R-4 repair is applied. Nothing here writes, and nothing here *can*
 * write: every statement runs inside `BEGIN TRANSACTION READ ONLY`, which
 * Postgres rejects with 25006 on any INSERT/UPDATE/DELETE/DDL. The transaction
 * is rolled back at the end regardless.
 *
 * This exists so the Stage 3 approval decision is made against measured
 * numbers rather than against the plan's expectations, which were written before
 * the current data was known. The plan's own figures are quoted next to each
 * measurement so a divergence is visible immediately.
 *
 * Usage:
 *   node scripts/stage3-dryrun.cjs
 *
 * Exit codes: 0 = probe completed (read the report), 1 = could not run.
 *
 * NOTE: this script performs NO writes. Applying the repairs is a separate,
 * approval-gated operation and is deliberately not implemented here.
 */
require('dotenv/config');
const { Client } = require('pg');

const SCHEMA = 'public';

// The song the §1 incident wrote stub data onto. R-1 resets it.
const POLLUTED_SONG_ID = 'cmrxj53p4001a2813pt0s3jtm';
const POLLUTED_VIDEO_ID = 'ph4idempotent1';

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  console.error('[stage3-dryrun] DATABASE_URL is not set.');
  process.exit(1);
}
const url = new URL(rawUrl);
url.searchParams.delete('channel_binding');

/** Each probe returns rows we print; every one is a SELECT. */
const PROBES = [
  {
    id: 'R-1',
    title: 'Polluted song (reset target)',
    expect: `one row, youtubeVideoId = '${POLLUTED_VIDEO_ID}'`,
    sql: `SELECT id, title, "youtubeVideoId", "youtubeMatchedAt", views, "softDeleted"
          FROM "${SCHEMA}"."Song" WHERE id = $1`,
    params: [POLLUTED_SONG_ID],
  },
  {
    id: 'R-1b',
    title: 'Any OTHER row carrying stub test data',
    expect: '0 rows — if non-zero, R-1 alone will not clean the incident',
    sql: `SELECT id, title, "youtubeVideoId" FROM "${SCHEMA}"."Song"
          WHERE "youtubeVideoId" IN ('${POLLUTED_VIDEO_ID}', 'nothumb00001', 'reqshape00001', 'ph4unitvid001')`,
  },
  {
    id: 'R-3a',
    title: 'Leaked P3TEST fixtures — songs',
    expect: '10 songs, created 2026-09-27 15:09:52-15:10:37 UTC',
    sql: `SELECT id, title, "createdAt" FROM "${SCHEMA}"."Song"
          WHERE title LIKE 'P3TEST-%' ORDER BY "createdAt"`,
  },
  {
    id: 'R-3b',
    title: 'Leaked P3TEST fixtures — artists',
    expect: '10 artists, same window',
    sql: `SELECT id, name, "createdAt" FROM "${SCHEMA}"."Artist"
          WHERE name LIKE 'P3TEST-%' ORDER BY "createdAt"`,
  },
  {
    id: 'R-3c',
    title: 'SAFETY: genuine catalog rows matching the R-3 predicate',
    expect: '0 — non-zero means the R-3 DELETE would hit real data. STOP.',
    sql: `SELECT count(*)::int AS orphans FROM "${SCHEMA}"."Song"
          WHERE title LIKE 'P3TEST-%'
            AND "artistId" NOT IN (SELECT id FROM "${SCHEMA}"."Artist" WHERE name LIKE 'P3TEST-%')`,
  },
  {
    id: 'R-3d',
    title: 'Post-R-3 projected Song count',
    expect: '924 (923 live + 1 soft-deleted) after deleting the fixtures',
    sql: `SELECT count(*)::int AS songs_now,
                 count(*) FILTER (WHERE title LIKE 'P3TEST-%')::int AS to_delete,
                 count(*)::int - count(*) FILTER (WHERE title LIKE 'P3TEST-%') AS projected_after
          FROM "${SCHEMA}"."Song"`,
  },
  {
    id: '3.5a',
    title: 'Test users — DECISION REQUIRED, quantify only',
    expect: 'phase3 + r3 test accounts separated from real ones',
    sql: `SELECT
            count(*) FILTER (WHERE email LIKE 'phase3-%@example.com')::int      AS phase3_test,
            count(*) FILTER (WHERE email LIKE 'r3-test-%@afrogenie.local')::int  AS r3_test,
            count(*) FILTER (WHERE email NOT LIKE 'phase3-%@example.com'
                               AND email NOT LIKE 'r3-test-%@afrogenie.local')::int AS other
          FROM "${SCHEMA}"."User"`,
  },
  {
    id: '3.5b',
    title: 'Blast radius of deleting test users (cascades)',
    expect: 'recorded BEFORE any deletion so a later metric shift is explainable',
    sql: `SELECT
            (SELECT coalesce(sum(amount), 0)::bigint FROM "${SCHEMA}"."TokenLedger")      AS ledger_total,
            (SELECT count(*)::int FROM "${SCHEMA}"."UserWallet")                          AS wallet_rows,
            (SELECT count(*)::int FROM "${SCHEMA}"."SongPlay")                           AS songplay_rows,
            (SELECT count(*)::int FROM "${SCHEMA}"."AbuseFlag")                          AS abuseflag_rows,
            (SELECT count(*)::int FROM "${SCHEMA}"."Notification")                       AS notification_rows`,
  },
  {
    id: '4.1',
    title: 'Challenges — current week state (Stage 4 pre-check)',
    expect: '4 rows for 2026-09-21 -> 2026-09-28, active but expired',
    sql: `SELECT type, title, "startsAt", "expiresAt", active
          FROM "${SCHEMA}"."Challenge" ORDER BY "startsAt"`,
  },
];

async function main() {
  const c = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 30000,
    statement_timeout: 60000,
  });
  c.on('error', () => {});
  await c.connect();

  console.log('=== STAGE 3 DRY RUN (READ ONLY) ===');
  console.log('Every statement below ran inside BEGIN TRANSACTION READ ONLY.\n');

  const divergences = [];

  try {
    // READ ONLY is a Postgres guarantee, not a convention: any write statement
    // issued on this connection now fails with SQLSTATE 25006.
    await c.query('BEGIN TRANSACTION READ ONLY');

    for (const p of PROBES) {
      console.log(`--- [${p.id}] ${p.title}`);
      console.log(`    plan expected: ${p.expect}`);
      const r = await c.query(p.sql, p.params || []);
      if (r.rows.length === 0) {
        console.log('    RESULT: 0 rows\n');
        continue;
      }
      for (const row of r.rows) {
        console.log('    ' + JSON.stringify(row));
      }
      // Surface the two numbers an operator must not misread.
      if (p.id === 'R-3c' && r.rows[0].orphans !== 0) {
        divergences.push('R-3c NON-ZERO — the R-3 DELETE would remove genuine catalog rows. STOP.');
      }
      if (p.id === '3.5a' && r.rows[0].other !== 0) {
        divergences.push('3.5a "other" is non-zero — real users exist; any deletion must target an explicit email list, never a pattern.');
      }
      console.log('');
    }
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
  }

  console.log('--- DIVERGENCES FROM THE PLAN THAT NEED A HUMAN DECISION');
  if (divergences.length === 0) {
    console.log('    none');
  } else {
    for (const d of divergences) console.log('  !! ' + d);
  }

  console.log('\nREAD ONLY: no rows were written, altered, or deleted by this probe.');
  console.log('Stage 3 remains APPROVAL-GATED. Nothing above has been applied.');
}

main().catch((e) => {
  console.error('[stage3-dryrun] FATAL', e.message);
  process.exit(1);
});
