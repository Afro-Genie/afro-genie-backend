/**
 * Stage 6 pre-flight: migration/schema drift audit.
 *
 * Read-only. Opens no write transaction, runs no DDL, mutates nothing.
 *
 * Three questions, in the order they must be answered:
 *   A. Which schema models have no CREATE TABLE in any migration?  (Stage 1 open item §1.R9)
 *   B. What does Prisma itself think the diff is, from the migration history to the schema?
 *      Classified by risk so we know whether the repair is Class B (additive) or needs review.
 *   C. What is actually applied in the target database, versus what the folder claims?
 *      A folder that says "applied" and a database that disagrees is the failure that
 *      silently drops a table on the next deploy.
 *
 * Usage:
 *   node scripts/stage6-audit.mjs            # audit the folder vs the schema (no DB)
 *   node scripts/stage6-audit.mjs --live     # also read the live database (SELECT only)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import 'dotenv/config';

const ROOT = join(import.meta.dirname, '..');
const MIGRATIONS = join(ROOT, 'prisma', 'migrations');
const SCHEMA = join(ROOT, 'prisma', 'schema.prisma');

const live = process.argv.includes('--live');

/* ------------------------------------------------------------------ A. folder */

function migrationDirs() {
  return readdirSync(MIGRATIONS)
    .filter((d) => existsSync(join(MIGRATIONS, d, 'migration.sql')))
    .sort();
}

function sqlOf(dir) {
  return readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
}

/** Model names declared in schema.prisma. */
function schemaModels() {
  const src = readFileSync(SCHEMA, 'utf8');
  return [...src.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
}

/** Tables a migration folder actually creates. */
function createdTables() {
  const out = new Map();
  for (const dir of migrationDirs()) {
    const sql = sqlOf(dir);
    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi
    )) {
      const t = m[1];
      if (!out.has(t)) out.set(t, []);
      out.get(t).push(dir);
    }
  }
  return out;
}

/** Destructive tokens present anywhere in the whole migration folder. */
function destructiveStatements() {
  const hits = [];
  const re =
    /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|ALTER\s+COLUMN\s+\S+\s+(?:TYPE|SET\s+NOT\s+NULL|DROP\s+DEFAULT)|RENAME\s+(?:TO|COLUMN))\b/gi;
  for (const dir of migrationDirs()) {
    const sql = sqlOf(dir);
    for (const m of sql.matchAll(re)) {
      const line = sql.slice(0, m.index).split('\n').length;
      hits.push({ dir, line, token: m[0].toUpperCase().replace(/\s+/g, ' ') });
    }
  }
  return hits;
}

/* --------------------------------------------------------- B. prisma's own diff */

function prismaDiff(fromMigrationsToSchema) {
  const bin = join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  const args = [
    bin,
    'migrate',
    'diff',
    ...(fromMigrationsToSchema
      ? ['--from-migrations', join(ROOT, 'prisma', 'migrations')]
      : ['--from-empty']),
    '--to-schema',
    join(ROOT, 'prisma', 'schema.prisma'),
    '--script',
  ];
  try {
    return execFileSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `--DIFF-FAILED--\n${(err.stderr || '').toString()}\n${(err.stdout || '').toString()}`;
  }
}

function classify(sql) {
  const lines = sql.split('\n').filter((l) => l.trim().startsWith('--') === false && l.trim().length);
  const counts = { createTable: 0, addColumn: 0, createIndex: 0, drop: 0, alter: 0, other: 0 };
  const details = [];
  for (const raw of lines) {
    const l = raw.trim();
    let kind = 'other';
    if (/^CREATE TABLE/i.test(l)) kind = 'createTable';
    else if (/^ALTER TABLE .* ADD COLUMN/i.test(l)) kind = 'addColumn';
    else if (/^CREATE (UNIQUE )?INDEX/i.test(l)) kind = 'createIndex';
    else if (/^DROP\b/i.test(l) || /^TRUNCATE\b/i.test(l)) kind = 'drop';
    else if (/^ALTER TABLE/i.test(l)) kind = 'alter';
    counts[kind]++;
    if (kind === 'drop' || kind === 'alter') details.push(l);
  }
  return { counts, details, statementCount: lines.length };
}

/* --------------------------------------------------------------- C. live read */

async function liveFacts() {
  const raw = process.env.DATABASE_URL || process.env.DIRECT_URL;
  if (!raw) return { error: 'DATABASE_URL is not set' };
  const url = new URL(raw);
  url.searchParams.delete('channel_binding');
  const { Client } = await import('pg');
  const c = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 30000,
    statement_timeout: 60000,
  });
  c.on('error', () => {});
  await c.connect();
  try {
    const tables = await c.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
    );
    const applied = await c.query(
      `SELECT migration_name, finished_at IS NOT NULL AS ok, rolled_back_at IS NOT NULL AS rolled_back,
              applied_steps_count
         FROM _prisma_migrations ORDER BY started_at`
    );
    const cols = await c.query(
      `SELECT table_name, column_name, data_type, column_default, is_nullable
         FROM information_schema.columns WHERE table_schema='public'
        ORDER BY table_name, ordinal_position`
    );
    return {
      host: url.hostname,
      tables: tables.rows.map((r) => r.table_name),
      applied: applied.rows,
      columns: cols.rows,
    };
  } finally {
    await c.end().catch(() => {});
  }
}

/* ---------------------------------------------------------------------- main */

const created = createdTables();
const models = schemaModels();
const noCreate = models.filter((m) => !created.has(m));

console.log('=== STAGE 6 PRE-FLIGHT: migration / schema drift ===\n');

console.log('--- A. migration folder ---');
console.log(`migrations:            ${migrationDirs().length}`);
console.log(`tables created:        ${created.size}`);
console.log(`schema models:         ${models.length}`);
console.log(`models with NO CREATE TABLE in any migration: ${noCreate.length}`);
for (const m of noCreate) console.log(`    - ${m}`);

const destruct = destructiveStatements();
console.log(`\ndestructive statements already in folder: ${destruct.length}`);
for (const d of destruct) console.log(`    ${d.dir} :${d.line}  ${d.token}`);

console.log('\n--- B. prisma migrate diff: from-migrations -> schema ---');
const sql = prismaDiff(true);
if (sql.startsWith('--DIFF-FAILED--')) {
  console.log(sql);
} else {
  const { counts, details, statementCount } = classify(sql);
  console.log(`statements: ${statementCount}`);
  console.log(`  CREATE TABLE            ${counts.createTable}`);
  console.log(`  ADD COLUMN              ${counts.addColumn}`);
  console.log(`  CREATE INDEX            ${counts.createIndex}`);
  console.log(`  DROP / TRUNCATE         ${counts.drop}   <-- must be 0 for Class B`);
  console.log(`  other ALTER TABLE       ${counts.alter}   <-- review each`);
  for (const d of details) console.log(`    !! ${d}`);
  const additive = counts.drop === 0 && counts.alter === 0;
  console.log(`\nverdict: ${additive ? 'ADDITIVE ONLY (Class B)' : 'NEEDS REVIEW - contains non-additive statements'}`);
}

if (!live) {
  console.log('\n--- C. live database: skipped (pass --live) ---');
  process.exit(0);
}

console.log('\n--- C. live database (SELECT only) ---');
try {
  const f = await liveFacts();
  if (f.error) {
    console.log(`  ${f.error}`);
  } else {
    console.log(`host: ${f.host}`);
    console.log(`live tables: ${f.tables.length}`);
    const liveSet = new Set(f.tables);

    const folderOnly = [...created.keys()].filter((t) => !liveSet.has(t));
    const liveOnly = f.tables.filter(
      (t) => t !== '_prisma_migrations' && !created.has(t)
    );
    console.log(`\ncreated by a migration but ABSENT live: ${folderOnly.length}`);
    for (const t of folderOnly) console.log(`    - ${t}`);
    console.log(`\nlive but created by NO migration: ${liveOnly.length}`);
    for (const t of liveOnly) console.log(`    - ${t}`);

    const dirNames = new Set(migrationDirs());
    const notApplied = f.applied.filter((r) => !dirNames.has(r.migration_name));
    const notFinished = f.applied.filter((r) => !r.ok);
    console.log(`\n_prisma_migrations rows: ${f.applied.length}`);
    console.log(`  applied names NOT in folder: ${notApplied.length}`);
    for (const r of notApplied) console.log(`    - ${r.migration_name}`);
    console.log(`  unfinished / failed rows: ${notFinished.length}`);
    for (const r of notFinished) {
      console.log(`    - ${r.migration_name} ok=${r.ok} rolledBack=${r.rolled_back}`);
    }
    const folderNotApplied = migrationDirs().filter((d) => !f.applied.some((r) => r.migration_name === d));
    console.log(`  folder migrations NOT recorded as applied: ${folderNotApplied.length}`);
    for (const d of folderNotApplied) console.log(`    - ${d}`);

    console.log('\n  columns requested by Stage 6:');
    for (const [t, col] of [
      ['Song', 'youtubeMatchAttempts'],
      ['User', 'isTestAccount'],
    ]) {
      const hit = f.columns.find((r) => r.table_name === t && r.column_name === col);
      console.log(`    ${t}.${col}: ${hit ? 'EXISTS' : 'absent'}`);
    }
  }
} catch (e) {
  console.log(`  live read failed: ${e.message}`);
}
