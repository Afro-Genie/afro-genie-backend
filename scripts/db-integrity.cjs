/**
 * Data integrity check: verifies no critical table has lost data.
 *
 * Compares live row counts against a baseline (scripts/db-integrity.baseline.json).
 * Any table whose count drops below its floor (or that no longer exists) fails,
 * which is meant to be wired into cron / CI so you get alerted within minutes of
 * a wipe (e.g. a DROP SCHEMA or truncate).
 *
 * Usage:
 *   npm run db:integrity            # read-only check against DATABASE_URL
 *   DATABASE_URL=... npm run db:integrity
 *
 * Exit codes: 0 = healthy, 1 = a table is missing or below floor.
 */
require('dotenv/config');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const BASELINE_PATH = path.join(__dirname, 'db-integrity.baseline.json');
const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')).baseline;

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  console.error('[integrity] DATABASE_URL is not set.');
  process.exit(1);
}
const url = new URL(rawUrl);
url.searchParams.delete('channel_binding');

const SCHEMA = 'public';

async function main() {
  const c = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 30000,
    statement_timeout: 120000,
  });
  c.on('error', () => {});
  await c.connect();
  const failures = [];
  const result = {};
  try {
    const existing = await c.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='${SCHEMA}' AND table_type='BASE TABLE'`
    );
    const present = new Set(existing.rows.map((r) => r.table_name));

    for (const [table, floor] of Object.entries(baseline)) {
      if (!present.has(table)) {
        result[table] = 'MISSING';
        failures.push(`${table}: table does not exist (expected >= ${floor})`);
        continue;
      }
      const r = await c.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."${table}"`);
      const n = r.rows[0].n;
      result[table] = n;
      if (n < floor) {
        failures.push(`${table}: ${n} rows (floor ${floor})`);
      }
    }

    for (const extra of [...present].sort()) {
      if (!(extra in baseline) && extra !== '_prisma_migrations') {
        result[`_unexpected:${extra}`] = 0;
      }
    }
  } finally {
    await c.end().catch(() => {});
  }

  console.log('=== DB INTEGRITY ===');
  for (const [table, n] of Object.entries(result)) {
    const floor = baseline[table] ?? '';
    console.log(`${table.padEnd(38)} ${n}${floor !== '' ? ` (floor ${floor})` : ''}`);
  }

  if (failures.length > 0) {
    console.error(`\nFAIL ${failures.length} check(s):`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\nOK: all tables within baseline.');
}

main().catch((e) => {
  console.error('[integrity] FATAL', e.message);
  process.exit(1);
});