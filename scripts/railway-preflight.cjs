/**
 * Pre-deploy safety check for Railway (or any container start).
 *
 * Before the app boots, verify:
 *   1. The database is reachable and actually has data (not an empty DB that a
 *      destructive deploy would happily call "fresh").
 *   2. `prisma migrate status` reports all migrations applied with no drift.
 *
 * If either check fails the process exits non-zero, Railway's deploy stops, and
 * the previous healthy release stays live instead of booting against a broken
 * DB. This replaces blindly running `prisma migrate deploy` on every start.
 *
 * Usage: node scripts/railway-preflight.cjs
 * Env:   RAILWAY_SKIP_PREFLIGHT=1 to bypass (not recommended).
 */
require('dotenv/config');
const { spawnSync } = require('child_process');

if (process.env.RAILWAY_SKIP_PREFLIGHT === '1') {
  console.log('[preflight] skipped (RAILWAY_SKIP_PREFLIGHT=1)');
  process.exit(0);
}

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  console.error('[preflight] DATABASE_URL is not set — aborting deploy.');
  process.exit(1);
}
const url = new URL(rawUrl);
url.searchParams.delete('channel_binding');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', env: process.env, ...opts });
  return res;
}

// 1) Quick liveness probe that ALSO asserts the DB is not empty.
const pg = require('pg');
(async () => {
  const c = new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 15000,
    statement_timeout: 30000,
  });
  c.on('error', () => {});
  try {
    await c.connect();
    const r = await c.query(`SELECT count(*)::int AS n FROM "User"`);
    if (r.rows[0].n === 0) {
      console.error(
        '[preflight] User table is empty — refusing to deploy against what looks like a wiped or brand-new DB.'
      );
      process.exit(1);
    }
    console.log(`[preflight] DB reachable; ${r.rows[0].n} user(s) present.`);
  } finally {
    await c.end().catch(() => {});
  }

  // 2) Migration status + drift check. `prisma migrate status` exits 0 both
  //    when healthy AND when there are pending/drifted migrations, so the exit
  //    code alone is not trustworthy — parse the output.
  const path = require('path');
  const prismaCli = path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js');
  const status = run(process.execPath, [prismaCli, 'migrate', 'status']);
  const out = `${status.stdout || ''}\n${status.stderr || ''}`;
  if (status.status !== 0) {
    console.error('[preflight] `prisma migrate status` failed — aborting deploy.');
    console.error(out);
    process.exit(1);
  }
  const lower = out.toLowerCase();
  const upToDate = lower.includes('up to date') || lower.includes('schema is up to date');
  const pendingOrDrift =
    lower.includes('not yet applied') ||
    lower.includes('pending') ||
    lower.includes('drift detected') ||
    lower.includes('have not been applied') ||
    lower.includes('different from the migration history');
  if (pendingOrDrift) {
    console.error('[preflight] Migration drift or pending migrations — aborting deploy.');
    console.error(out);
    process.exit(1);
  }
  if (!upToDate) {
    console.warn('[preflight] `prisma migrate status` did not clearly report "up to date":');
    console.warn(out);
    // Conservative: we could not confirm a clean state, so do not auto-apply.
    process.exit(1);
  }
  console.log('[preflight] migrations up to date.');

  console.log('[preflight] OK — safe to start.');
})().catch((e) => {
  console.error('[preflight] FATAL', e.message);
  process.exit(1);
});