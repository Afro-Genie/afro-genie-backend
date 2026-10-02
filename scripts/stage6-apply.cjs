/**
 * Stage 6 apply — 6.1 / 6.2 / 6.3 only, additive.
 *
 * WHY THIS EXISTS INSTEAD OF `prisma migrate deploy`
 * -----------------------------------------------
 * The production target currently has NO `_prisma_migrations` table. `migrate
 * deploy` would therefore treat all 40 migrations as unapplied and replay them
 * from scratch against a database that already has the tables — 54 CREATE TABLE
 * collisions and 22 enum collisions. Both `package.json` and `railway.toml` run
 * `migrate deploy` on every boot, so this is a live hazard, not a hypothetical.
 *
 * This script applies ONLY the Stage 6 statements, each of which is idempotent
 * and independently reviewable, and it can run against a database with no
 * migration ledger at all.
 *
 * Usage:
 *   node scripts/stage6-apply.cjs --dry-run   # pre-checks only, no writes
 *   node scripts/stage6-apply.cjs             # apply + verify idempotency
 *
 * Every step: pre-check -> apply -> post-check -> RE-APPLY (must be a no-op).
 * A statement that cannot demonstrate idempotency is not trusted.
 */
require('dotenv/config');
const { Client } = require('pg');
const { readFileSync } = require('fs');
const { join } = require('path');
const { currentHost, isProtected } = require('./lib/db-host.cjs');

const DRY_RUN = process.argv.includes('--dry-run');
const MIGRATION = join(
  __dirname, '..', 'prisma', 'migrations',
  '20260929000000_stage6_dead_letter_and_test_accounts', 'migration.sql',
);

const log = (...a) => console.log(...a);
const step = (s) => log(`\n=== ${s} ===`);

/**
 * The Stage 6 statements, in dependency-free order.
 *
 * Kept as an explicit list rather than a SQL splitter because the migration file
 * also carries long explanatory comments and a deliberately-narrowed scope; a
 * naive `split(';')` would be both fragile and hard to audit. Each entry is
 * independently idempotent, which is what lets a partial application recover.
 */
const STATEMENTS = [
  {
    id: '6.1a',
    sql: 'ALTER TABLE "Song" ADD COLUMN IF NOT EXISTS "youtubeMatchAttempts" INTEGER NOT NULL DEFAULT 0',
    check: async (c) => (await one(c, `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name='Song' AND column_name='youtubeMatchAttempts'`))[0] ?? null,
    expect: (r) => !!r && r.column_default === '0' && r.is_nullable === 'NO',
    why: 'ADD COLUMN ... NOT NULL DEFAULT 0 — constant default, no rewrite on PG11+',
  },
  {
    id: '6.1b',
    sql: 'CREATE INDEX IF NOT EXISTS "Song_youtubeMatchAttempts_idx" ON "Song"("youtubeMatchAttempts")',
    check: async (c) => (await one(c, `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename='Song' AND indexname='Song_youtubeMatchAttempts_idx'`))[0]?.n ?? 0,
    expect: (n) => n === 1,
    why: 'CREATE INDEX — supports the dead-letter selection query',
  },
  {
    id: '6.2a',
    sql: 'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isTestAccount" BOOLEAN NOT NULL DEFAULT false',
    check: async (c) => (await one(c, `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name='User' AND column_name='isTestAccount'`))[0] ?? null,
    expect: (r) => !!r && /false/.test(r.column_default ?? '') && r.is_nullable === 'NO',
    // @default(false) is load-bearing: an absent/NULL default would silently
    // reinterpret existing rows, so this is asserted rather than assumed.
    why: 'ADD COLUMN ... NOT NULL DEFAULT false — inert until an operator flags a row',
  },
  {
    id: '6.2b',
    sql: 'CREATE INDEX IF NOT EXISTS "User_isTestAccount_idx" ON "User"("isTestAccount")',
    check: async (c) => (await one(c, `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename='User' AND indexname='User_isTestAccount_idx'`))[0]?.n ?? 0,
    expect: (n) => n === 1,
    why: 'CREATE INDEX — every leaderboard/abuse query filters on it',
  },
  {
    id: '6.3',
    sql: 'CREATE INDEX IF NOT EXISTS "Translation_userId_createdAt_idx" ON "Translation"("userId", "createdAt")',
    check: async (c) => (await one(c, `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename='Translation' AND indexname='Translation_userId_createdAt_idx'`))[0]?.n ?? 0,
    expect: (n) => n === 1,
    why: 'CREATE INDEX — M-10 challenge progress (userId equality + createdAt window)',
  },
];

/** Refuse to write unless the caller is explicit about production. */
function assertWritable() {
  const host = currentHost();
  if (!host) {
    log('  refusing: cannot identify the database host (fail closed)');
    process.exit(1);
  }
  if (isProtected(host) && process.env.ALLOW_PROD_WRITES !== '1') {
    log(`  refusing: ${host} is a protected host.`);
    log('  Stage 6 is 🔒 approval-gated. Set ALLOW_PROD_WRITES=1 to apply deliberately.');
    process.exit(1);
  }
  return host;
}

async function one(c, sql) {
  const r = await c.query(sql);
  return r.rows;
}

/**
 * Remove `--` line comments and `/* *\/` block comments so the safety guards
 * inspect executable SQL only. String literals are preserved as-is; this
 * migration contains none, and a literal containing `DROP` would be a query
 * this script has no reason to run.
 */
function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      // Only strip a `--` that is outside a quoted string.
      let inStr = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inStr) {
          if (ch === inStr) inStr = null;
        } else if (ch === "'" || ch === '"') {
          inStr = ch;
        } else if (ch === '-' && line[i + 1] === '-') {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

async function main() {
  // Read the migration file so the script cannot drift from the reviewed SQL.
  const migrationSql = readFileSync(MIGRATION, 'utf8');

  log(`STAGE 6 APPLY — ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY (writes to the target)'}`);
  log(`migration: ${MIGRATION}`);

  // ── Guard: the reviewed SQL must be provably additive ────────────────────
  // Comments are stripped first. This migration's prose deliberately names the
  // destructive statements it is *avoiding* ("no DROP TABLE", "no DROP
  // CONSTRAINT"), and scanning the raw text made the guard reject the very file
  // it exists to approve. Only executable SQL is scanned.
  const executable = stripSqlComments(migrationSql);
  const destructive = executable.match(
    /\b(DROP\s+TABLE|DROP\s+COLUMN|DROP\s+CONSTRAINT|DROP\s+INDEX|TRUNCATE|ALTER\s+COLUMN\s+\S+\s+TYPE|DELETE\s+FROM|UPDATE\s+)\b/gi,
  );
  if (destructive) {
    log(`\nREFUSING: migration contains non-additive statements: ${[...new Set(destructive)].join(', ')}`);
    log('  REMEDIATION-PLAN.md §8 requires every Stage 6 migration to be ADD COLUMN / CREATE TABLE / CREATE INDEX.');
    process.exit(1);
  }
  log('\nguard: migration file is provably additive (no DROP/TRUNCATE/ALTER TYPE)');

  // ── Guard 2: no drift between the reviewed file and what we execute ──────
  // The STATEMENTS list is a hand-maintained copy of the migration. If someone
  // edits the migration but forgets to update the list, the two drift and the
  // approved file is no longer what actually runs. Fail loudly instead.
  const norm = (s) => s.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
  const fileStatements = executable
    .split(';')
    .map(norm)
    .filter((s) => s && !/^--/.test(s));
  for (const s of STATEMENTS) {
    if (!fileStatements.includes(norm(s.sql))) {
      log(`\nREFUSING: statement ${s.id} does not match the reviewed migration file.`);
      log(`  expected in migration.sql:\n    ${s.sql}`);
      process.exit(1);
    }
  }
  log(`guard: all ${STATEMENTS.length} executed statement(s) match migration.sql (no drift)`);

  const url = new URL(process.env.DATABASE_URL || process.env.DIRECT_URL);
  url.searchParams.delete('channel_binding');
  const host = url.hostname;

  if (!DRY_RUN) assertWritable();
  log(`target: ${host}`);

  const c = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 30000,
    statement_timeout: 120000,
  });
  c.on('error', () => {});
  await c.connect();

  try {
    // ── Context: the reason `migrate deploy` is not used here ──────────────
    step('PRE-FLIGHT');
    const hasLedger = await one(
      c,
      `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS has_ledger`,
    );
    log(`  _prisma_migrations present: ${hasLedger[0].has_ledger}`);
    if (!hasLedger[0].has_ledger) {
      log('  NOTE: no migration ledger. `migrate deploy` would replay all 40 migrations');
      log('        against existing tables (54 CREATE TABLE collisions). Applying');
      log('        only these statements is the safe alternative.');
    }
    for (const t of ['Song', 'User', 'Translation']) {
      const n = (await one(c, `SELECT count(*)::int AS n FROM "${t}"`))[0].n;
      log(`  ${t}: ${n} row(s)`);
    }

    const stop = [];

    // ── Per-statement: pre -> apply -> post -> re-apply ────────────────────
    for (const s of STATEMENTS) {
      step(`${s.id}  ${s.why}`);
      const pre = await s.check(c);
      log(`  pre  : ${JSON.stringify(pre)}`);

      if (DRY_RUN) {
        log('  dry-run: not executing');
        continue;
      }

      await c.query(s.sql);
      const post = await s.check(c);
      log(`  post : ${JSON.stringify(post)}`);
      if (!s.expect(post)) {
        stop.push(`${s.id}: post-check did not match the expected shape`);
        continue;
      }

      // The fourth step: prove idempotency by running it again.
      await c.query(s.sql);
      const again = await s.check(c);
      log(`  re   : ${JSON.stringify(again)}`);
      if (JSON.stringify(again) !== JSON.stringify(post)) {
        stop.push(`${s.id}: NOT idempotent — re-apply changed the result`);
      } else {
        log('  idempotent: re-apply was a no-op');
      }
    }

    step('SUMMARY');
    if (DRY_RUN) {
      log('  DRY RUN complete — nothing was written.');
    } else if (stop.length) {
      log('  BLOCKERS:');
      stop.forEach((s) => log(`    !! ${s}`));
    } else {
      log('  OK: all Stage 6 statements applied and are idempotent.');
    }
    if (stop.length) process.exitCode = 1;
  } finally {
    await c.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error('[stage6-apply] FATAL', e.message);
  process.exit(1);
});
