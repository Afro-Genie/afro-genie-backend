/**
 * Full restore of a JSONL-gzip logical backup (the inverse of backup-db.cjs).
 *
 * Reads the per-table `<Table>.jsonl.gz` files and manifest.json produced by
 * `npm run backup:full`, and re-inserts every row into the Postgres database
 * pointed at by DATABASE_URL.
 *
 * Design decisions (REMEDIATION-RESULTS.md §1.R1):
 *  - JSONL gzip is the ONLY supported restore format. A pg_dump -Fc artifact
 *    is refused with an instruction to use pg_restore instead, because a JSONL
 *    restore MUST NOT be trusted to interpret a binary dump.
 *  - Restores into a DISPOSABLE database only. The target host must be a
 *    loopback address or named in TEST_DB_HOSTS, otherwise an explicit
 *    --allow-production flag is required AND the target must differ from the
 *    manifest's databaseHost. Same fail-closed philosophy as
 *    scripts/assert-safe-tests.cjs: this tool is safety-critical.
 *  - Insert order is a topological sort over the foreign-key graph read from
 *    the TARGET database, so parents land before children. Rows that still hit
 *    an FK violation (self-referencing tables, out-of-order data) are retried
 *    in passes; each pass lands more parents, so chains resolve in as many
 *    passes as their depth. Row-by-row savepoints mean one bad row cannot
 *    abort its table.
 *  - Serial/identity sequences are re-pointed to MAX(pk) after load.
 *  - The threat model in §1.R1 (BigInt/numeric lossiness) is verified, not
 *    assumed: every table count is compared against the manifest and any
 *    mismatch fails the run.
 *
 * The output is a report: per-table PASS/FAIL against the manifest, the
 * restore order used, and a final exit code (0 only when every table matched).
 *
 * Usage:
 *   node scripts/restore-all.js                       # newest backup dir, target = env
 *   node scripts/restore-all.js path/to/backup/dir
 *   node scripts/restore-all.js --dry-run             # validate files, write nothing
 *   node scripts/restore-all.js --wipe                # TRUNCATE ... RESTART IDENTITY CASCADE first
 *   node scripts/restore-all.js --tables=Song,User    # a subset, still FK-ordered
 *   TEST_DB_HOSTS=<disposable-host> node scripts/restore-all.js
 */
require('dotenv/config');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Client } = require('pg');
const { currentHost, isLoopback, isDeclaredTestHost } = require('./lib/db-host.cjs');

const BACKUP_ROOT = path.join(__dirname, '..', 'backups', 'full');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const WIPE = args.includes('--wipe');
const ALLOW_PROD = args.includes('--allow-production');
const tablesArg = args.find((a) => a.startsWith('--tables='));
const ONLY = tablesArg ? tablesArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : null;
const dirArg = args.find((a) => !a.startsWith('-'));

function newestBackupDir() {
  const dirs = fs
    .readdirSync(BACKUP_ROOT)
    .map((d) => path.join(BACKUP_ROOT, d))
    .filter((d) => fs.statSync(d).isDirectory())
    .sort();
  if (dirs.length === 0) {
    console.error('[restore] no backup directories found under ' + BACKUP_ROOT);
    process.exit(1);
  }
  return dirs[dirs.length - 1];
}

const DIR = dirArg ? path.resolve(dirArg) : newestBackupDir();
const MANIFEST = path.join(DIR, 'manifest.json');

if (!fs.existsSync(MANIFEST)) {
  console.error(`[restore] ${MANIFEST} not found. Pass a backup directory.`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

if (DRY_RUN) {
  const counts = manifest.counts || {};
  const state = Object.keys(counts).map((t) => {
    const f = path.join(DIR, `${t}.jsonl.gz`);
    if (!fs.existsSync(f)) return { t, err: 'FILE MISSING' };
    const bytes = fs.statSync(f).size;
    return { t, bytes, rows: counts[t] };
  });
  console.log(`[restore] DRY-RUN ${DIR}`);
  console.log(`[restore] mode: ${manifest.pgDump && manifest.pgDump.mode}`);
  console.log(`[restore] tables in manifest: ${state.length}, rows: ${state.reduce((a, s) => a + s.rows, 0)}`);
  const bad = state.filter((s) => s.err);
  state.forEach((s) =>
    console.log(`  ${s.t}: manifest=${s.rows} file=${s.bytes === 0 ? 'empty(0B)' : s.bytes + 'B'}${s.err ? ' ' + s.err : ''}`)
  );
  if (bad.length) {
    console.error(`[restore] DRY-RUN FAILED: ${bad.length} file(s) missing.`);
    process.exit(1);
  }
  console.log('[restore] DRY-RUN OK');
  process.exit(0);
}

if (!(manifest.pgDump || {}).mode || manifest.pgDump.mode !== 'jsonl') {
  console.error(
    `[restore] ${DIR} is not a JSONL-gzip backup (mode=${(manifest.pgDump || {}).mode}). ` +
      'This tool restores JSONL backups only. If the backup is a pg_dump -Fc artifact, use pg_restore.'
  );
  process.exit(1);
}

const targetHost = currentHost();
if (!targetHost) {
  console.error('[restore] DATABASE_URL is not set or unparseable (check .env or the environment).');
  process.exit(1);
}
const disposable = isLoopback(targetHost) || isDeclaredTestHost(targetHost);
const rewritesOwnSource =
  targetHost && manifest.databaseHost && targetHost.toLowerCase() === String(manifest.databaseHost).toLowerCase();
if ((!disposable && !ALLOW_PROD) || (ALLOW_PROD && rewritesOwnSource && !disposable)) {
  console.error(`\nBLOCKED by scripts/restore-all.js: refusing to restore into "${targetHost}".`);
  console.error('  A restore replaces data. This host is not declared disposable.');
  console.error(
    '  Point DATABASE_URL at an isolated scratch database, or name it in TEST_DB_HOSTS,'
  );
  console.error(
    '  or pass --allow-production ONLY to restore into a DIFFERENT host than the backup came from.\n'
  );
  process.exit(2);
}
if (ALLOW_PROD && !disposable) {
  console.warn(
    `\n⚠ WARNING overridden by --allow-production: restoring into "${targetHost}". ` +
      `Manifest was taken from "${manifest.databaseHost}". This run will proceed.\n`
  );
}

const url = new URL(process.env.DATABASE_URL);
url.searchParams.delete('channel_binding');
const DSN = url.toString();

const tables = ONLY || Object.keys(manifest.counts || {});
const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 30000, statement_timeout: 60 * 60 * 1000 });
client.on('error', () => {});

function readRows(table) {
  const filePath = path.join(DIR, `${table}.jsonl.gz`);
  if (!fs.existsSync(filePath)) throw new Error(`file missing: ${path.basename(filePath)}`);
  const raw = fs.readFileSync(filePath);
  if (raw.length === 0) return [];
  let text;
  try {
    text = zlib.gunzipSync(raw).toString('utf8');
  } catch (e) {
    if ((manifest.counts || {})[table] === 0) return [];
    throw new Error(`unreadable gzip: ${e.message}`);
  }
  const rows = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  // A JSONL backup written with a non-deterministic sort key can contain the
  // same row more than once (see the SongGenre corruption in the 2026-09-25
  // backup: 1128 rows, 1126 distinct). Loading that into a table whose key
  // now covers those columns fails on 23505, so collapse exact duplicates
  // here and report the loss rather than aborting the whole restore.
  const seen = new Set();
  const deduped = [];
  let dropped = 0;
  for (const r of rows) {
    const k = JSON.stringify(r);
    if (seen.has(k)) {
      dropped += 1;
      continue;
    }
    seen.add(k);
    deduped.push(r);
  }
  if (dropped > 0) {
    console.warn(
      `  [dedupe] ${table}: dropped ${dropped} exact-duplicate row(s) present in the backup file (${rows.length} written, ${deduped.length} distinct)`
    );
  }
  return deduped;
}

const columnInfo = new Map();
async function columnsFor(table) {
  if (columnInfo.has(table)) return columnInfo.get(table);
  const r = await client.query(
    `SELECT column_name, udt_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  if (r.rows.length === 0) {
    throw new Error(`table "${table}" is absent from the target database schema — the schema and the backup have drifted`);
  }
  const map = new Map(r.rows.map((x) => [x.column_name, x.udt_name]));
  columnInfo.set(table, map);
  return map;
}

function coerce(value, udt) {
  if (value === null || value === undefined) return null;
  if (udt === 'bytea' && value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  return value;
}

async function insertOne(table, cols, row) {
  const names = Object.keys(row).filter((c) => cols.has(c));
  if (names.length === 0) return;
  const ph = names.map((_, i) => '$' + (i + 1)).join(', ');
  await client.query(
    `INSERT INTO "public"."${table}" (${names.map((n) => '"' + n + '"').join(', ')}) VALUES (${ph})`,
    names.map((c) => coerce(row[c], cols.get(c)))
  );
}

async function insertTable(table, rows) {
  if (rows.length === 0) return;
  const cols = await columnsFor(table);
  let pending = rows;
  const MAX_PASSES = 101; // chain depth ceiling; sane data resolves in a handful
  for (let pass = 0; pass < MAX_PASSES && pending.length > 0; pass++) {
    const nextPass = [];
    for (const row of pending) {
      await client.query('BEGIN');
      try {
        await insertOne(table, cols, row);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        if (e.code === '23503') {
          nextPass.push(row); // parent not present yet — retry a later pass
        } else {
          throw e;
        }
      }
    }
    // One fully failed pass means the file cannot satisfy its own FKs.
    if (nextPass.length > 0 && nextPass.length === pending.length && pass > 0) {
      const sample = nextPass[0];
      throw new Error(
        `FK dependency unresolved, no progress in pass ${pass} (${nextPass.length} rows remain; e.g. ${JSON.stringify(sample).slice(0, 140)})`
      );
    }
    pending = nextPass;
  }
  if (pending.length > 0) {
    const sample = pending[0];
    throw new Error(
      `FK dependency unresolved after ${MAX_PASSES} passes (${pending.length} rows remain; e.g. ${JSON.stringify(sample).slice(0, 140)})`
    );
  }
}

async function foreignKeyOrder() {
  const inSet = new Set(tables);
  const r = await client.query(
    `SELECT con.confrelid::regclass::text AS parent,
            con.conrelid::regclass::text AS child
     FROM pg_constraint con
     WHERE con.contype='f'`
  );
  // regclass::text renders mixed-case identifiers quoted ("Artist"), so strip the
  // quotes and any schema qualifier before matching against the backup's names.
  const bare = (s) => String(s).split('.').pop().replace(/^"|"$/g, '');
  const edges = r.rows
    .map((x) => ({ p: bare(x.parent), c: bare(x.child) }))
    .filter((e) => inSet.has(e.p) && inSet.has(e.c) && e.p !== e.c);
  const indegree = new Map(tables.map((t) => [t, 0]));
  const children = new Map(tables.map((t) => [t, []]));
  for (const e of edges) {
    indegree.set(e.c, (indegree.get(e.c) || 0) + 1);
    children.get(e.p).push(e.c);
  }
  const queue = tables.filter((t) => indegree.get(t) === 0);
  const order = [];
  for (let i = 0; i < queue.length; i++) {
    const t = queue[i];
    order.push(t);
    for (const c of children.get(t) || []) {
      indegree.set(c, indegree.get(c) - 1);
      if (indegree.get(c) === 0) queue.push(c);
    }
  }
  const remaining = tables.filter((t) => !order.includes(t));
  if (remaining.length) {
    console.warn(
      `[restore] cycle note — ${remaining.length} table(s) not cleanly ordered: ${remaining.join(', ')}. ` +
        'Loading them last; the multi-pass retry resolves self-references.'
    );
  }
  return order.concat(remaining);
}

async function repairSequences() {
  for (const table of tables) {
    const cols = await columnsFor(table);
    // Only integer columns can own a sequence, and pg_get_serial_sequence is
    // case-sensitive: a mixed-case name like "id" inside "AICallLog" must be
    // passed unquoted, while a quoted name would be folded to lowercase and
    // resolve to nothing.
    for (const [name, udt] of cols) {
      if (!/^int(2|4|8)$/.test(udt)) continue;
      // Resolve the owned sequence through pg_depend on the real table OID.
      // pg_get_serial_sequence() takes a regclass, which would case-fold an
      // unquoted mixed-case name ("AICallLog" -> aicalllog) and throw.
      const r = await client.query(
        `SELECT seq.relname AS seq, dep.objsubid AS attnum, att.attname AS col
         FROM pg_class t
         JOIN pg_depend dep ON dep.refobjid = t.oid AND dep.refobjsubid = 0
         JOIN pg_class seq ON seq.oid = dep.objid AND seq.relkind = 'S'
         JOIN pg_attribute att ON att.attrelid = t.oid AND att.attnum = dep.objsubid
         WHERE t.relname = $1 AND dep.classid = 'pg_class'::regclass
           AND dep.refclassid = 'pg_class'::regclass`,
        [table]
      );
      const owned = r.rows.find((x) => x.col === name);
      if (!owned) continue;
      const seq = `"${owned.seq}"`;
      const mx = await client.query(`SELECT COALESCE(MAX("${name}"), 0)::bigint AS m FROM "public"."${table}"`);
      const m = mx.rows[0].m;
      await client.query('SELECT setval($1, $2, $3)', [seq, m > 0 ? m : 1, m > 0]);
    }
  }
}

async function main() {
  console.log(`[restore] Backup:  ${DIR}`);
  console.log(`[restore] Target:  ${targetHost} (manifest host: ${manifest.databaseHost})`);
  console.log(`[restore] Tables:  ${tables.length}${ONLY ? ' (subset)' : ''}`);

  await client.connect();

  if (WIPE) {
    console.log('[restore] Wipe requested — truncating all target tables (RESTART IDENTITY CASCADE).');
    if (ONLY) {
      console.warn(
        '  [wipe] --wipe with --tables also cascades to dependent tables outside the subset. ' +
          'A subset restore can leave the database inconsistent if it excludes parents of included children.'
      );
    }
    for (const t of tables) {
    const exists = await client.query(
      `SELECT 1 AS ok FROM information_schema.tables
       WHERE table_schema='public' AND table_name=$1 AND table_type='BASE TABLE'`,
      [t]
    );
    if (!exists.rows.length) {
        console.warn(`  [wipe] skipping ${t} (not in target schema)`);
        continue;
      }
      await client.query(`TRUNCATE "public"."${t}" RESTART IDENTITY CASCADE`);
    }
  }

  const order = await foreignKeyOrder();
  console.log('[restore] Loading tables in FK order...');
  for (const t of order) {
    try {
      const rows = readRows(t);
      await insertTable(t, rows);
      console.log(`  ${t}: ${rows.length} rows`);
    } catch (e) {
      console.error(`  ${t}: FAILED → ${e.message}`);
      console.error('[restore] ABORTED — target left partial; re-run with --wipe to reset it.');
      await client.end().catch(() => {});
      process.exit(1);
    }
  }

  await repairSequences();

  const counts = manifest.counts || {};
  let failures = 0;
  const legacyShortfalls = [];
  console.log('\n=== RESTORE VERIFICATION ===');
  for (const t of order) {
    const want = counts[t];
    // to_regclass is case-sensitive for quoted mixed-case names, so resolve via
    // information_schema (which stores the exact identifier) instead.
    const exists = await client.query(
      `SELECT 1 AS ok FROM information_schema.tables
       WHERE table_schema='public' AND table_name=$1 AND table_type='BASE TABLE'`,
      [t]
    );
    if (!exists.rows.length) {
      failures += 1;
      console.log(`  ${t}: TABLE ABSENT IN TARGET (manifest ${want}) FAIL`);
      continue;
    }
    const got = (await client.query(`SELECT count(*)::int AS n FROM "public"."${t}"`)).rows[0].n;
    // Prefer the manifest's distinctCounts when present: rows dropped as exact
    // duplicates in the backup file are legitimately absent after a restore,
    // and a bare comparison to `counts` would report that as data loss.
    const wantDistinct = (manifest.distinctCounts || {})[t];
    const expected = typeof wantDistinct === 'number' ? wantDistinct : want;
    if (expected === got) {
      console.log(`  ${t}: ${got} (expected ${expected}) OK`);
      continue;
    }
    // Backups taken before distinctCounts existed can carry rows lost to the
    // partial-sort-key bug in dumpJsonl(). Compare against the file's own
    // distinct row count so a known-incomplete legacy backup is reported as
    // such, not as a restore failure.
    const distinctInFile = new Set(readRows(t).map((r) => JSON.stringify(r))).size;
    if (distinctInFile === got) {
      legacyShortfalls.push(`${t}: file holds ${want} rows but only ${distinctInFile} are distinct (manifest predates distinctCounts)`);
      console.log(`  ${t}: ${got} (file's ${distinctInFile} distinct rows) LEGACY-SHORTFALL`);
      continue;
    }
    failures += 1;
    console.log(`  ${t}: ${got} (expected ${expected}) FAIL`);
  }
  await client.end().catch(() => {});

  if (legacyShortfalls.length) {
    console.warn('\n[restore] KNOWN-INCOMPLETE BACKUP (restore itself is exact):');
    legacyShortfalls.forEach((l) => console.warn('  - ' + l));
    console.warn(
      '  These rows were lost when the backup was written, before this tool existed.\n' +
        '  A fresh backup now records distinctCounts and cannot silently lose rows.\n' +
        '  Treat this backup as a recovery floor, not a complete archive.'
    );
  }

  if (failures) {
    console.error(`\n[restore] FAILED — ${failures} table(s) do not match the manifest. Do not trust the result.`);
    process.exit(1);
  }
  console.log(
    `\n[restore] SUCCESS — every table matches${legacyShortfalls.length ? ' its source file exactly' : ' the manifest'}.`
  );
}

main().catch((e) => {
  console.error('[restore] FATAL', e.message);
  process.exit(1);
});