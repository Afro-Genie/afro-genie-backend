/**
 * Full logical backup of every table in the app's Postgres database.
 *
 *  - Preferred: uses `pg_dump -Fc` (binary/custom format) when available so the
 *    result is a standard, `pg_restore`-able artifact.
 *  - Fallback (no pg_dump on PATH): streams every public table out as
 *    per-table JSONL files, gzipped. Each row is a JSON object keyed by column
 *    name, which the restore path (restore-all.js / copy-table logic) reads
 *    directly.
 *
 * Retention: keeps only the N most recent backup directories (default 14) and
 * deletes the rest. Point BACKUP_KEEP to override.
 *
 * Usage:
 *   npm run backup:full                      # uses .env DATABASE_URL
 *   DATABASE_URL=... BACKUP_KEEP=30 npm run backup:full
 */
require('dotenv/config');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const zlib = require('zlib');
const { Client } = require('pg');
const os = require('os');

const BACKUP_ROOT = path.join(__dirname, '..', 'backups', 'full');
const KEEP = Number(process.env.BACKUP_KEEP || 14);

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  console.error('[backup] DATABASE_URL is not set (check .env or the environment).');
  process.exit(1);
}

const url = new URL(rawUrl);
url.searchParams.delete('channel_binding');
const DSN = url.toString();

function findPgDump() {
  if (process.env.PG_DUMP) {
    console.log(`[backup] using PG_DUMP=${process.env.PG_DUMP}`);
    return process.env.PG_DUMP;
  }
  const probe = spawnSync(/^win/.test(process.platform) ? 'where.exe' : 'which', ['pg_dump'], {
    encoding: 'utf8',
  });
  if (probe.status === 0 && probe.stdout) {
    return probe.stdout.split(/\r?\n/).filter(Boolean)[0].trim();
  }
  return null;
}

async function listTables() {
  const c = new Client({ connectionString: DSN, connectionTimeoutMillis: 30000, statement_timeout: 600000 });
  c.on('error', () => {});
  await c.connect();
  try {
    const r = await c.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE'
         AND table_name <> '_prisma_migrations'
       ORDER BY table_name`
    );
    return r.rows.map((x) => x.table_name);
  } finally {
    await c.end().catch(() => {});
  }
}

async function countRows(c, table) {
  const r = await c.query(`SELECT count(*)::int AS n FROM "${table}"`);
  return r.rows[0].n;
}

async function dumpJsonl(c, table, filePath) {
  // Batched read so arbitrarily large tables do not hold the whole result in
  // memory. Rows are written one JSON object per line.
  const LIMIT = 500;
  const out = fs.createWriteStream(filePath);
  const gz = zlib.createGzip();
  gz.pipe(out);
  let total = 0;
  let offset = 0;
  const seen = new Set();
  // Order by the FULL primary key, not just its first column. With OFFSET
  // pagination a partial sort key is non-deterministic for composite keys
  // (e.g. SongGenre(songId, genreId)): rows sharing a songId have no defined
  // order, so successive pages can repeat or skip them. That silently
  // corrupted SongGenre in the 2026-09-25 backup (1128 rows, 1126 distinct).
  const pk = await c.query(
    `SELECT a.attname AS col
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = '"${table}"'::regclass AND i.indisprimary
     ORDER BY array_position(i.indkey, a.attnum)`
  );
  const orderCols = pk.rows.map((r) => r.col);
  const orderBy = orderCols.length
    ? ` ORDER BY ${orderCols.map((c) => `"${c}"`).join(', ')}`
    : '';
  while (true) {
    const r = await c.query(`SELECT * FROM "${table}"${orderBy} LIMIT ${LIMIT} OFFSET ${offset}`);
    if (r.rows.length === 0) break;
    for (const row of r.rows) {
      const line = JSON.stringify(row);
      gz.write(line + '\n');
      // Pagination can repeat a row if the table is modified mid-backup; track
      // distinct rows so the manifest records what was really captured.
      seen.add(line);
      total += 1;
    }
    offset += r.rows.length;
    if (r.rows.length < LIMIT) break;
  }
  gz.end();
  await new Promise((res, rej) => {
    out.on('finish', res);
    out.on('error', rej);
    gz.on('error', rej);
  });
  return { total, distinct: seen.size };
}

function runPgDump(dir) {
  const pgDump = findPgDump();
  if (!pgDump) return null;
  const dumpFile = path.join(dir, 'pg_dump.dump');
  // Custom/compressed format; -b includes large objects.
  execFileSync(
    pgDump,
    ['-Fc', '-b', '-v', '--no-owner', '--no-privileges', '-f', dumpFile, DSN],
    { stdio: 'inherit', timeout: 30 * 60 * 1000 }
  );
  const bytes = fs.statSync(dumpFile).size;
  console.log(`[backup] pg_dump -Fc -> ${path.basename(dumpFile)} (${bytes} bytes)`);
  return { file: dumpFile, bytes };
}

function pruneOldBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) return;
  const dirs = fs
    .readdirSync(BACKUP_ROOT)
    .map((d) => path.join(BACKUP_ROOT, d))
    .filter((d) => fs.statSync(d).isDirectory())
    .sort();
  while (dirs.length > KEEP) {
    const old = dirs.shift();
    console.log(`[backup] pruning old backup ${path.basename(old)}`);
    fs.rmSync(old, { recursive: true, force: true });
  }
  console.log(`[backup] retention: keeping ${KEEP} newest backup(s) under ${BACKUP_ROOT}`);
}

(async () => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_ROOT, ts);
  fs.mkdirSync(dir, { recursive: true });

  const tables = await listTables();
  console.log(`[backup] found ${tables.length} tables`);

  const counts = {};
  const distinct = {};
  let pgDumpResult = null;
  try {
    pgDumpResult = runPgDump(dir);
  } catch (e) {
    console.error(`[backup] pg_dump failed, falling back to JSONL: ${e.message}`);
    pgDumpResult = null;
  }

  if (!pgDumpResult) {
    const c = new Client({ connectionString: DSN, connectionTimeoutMillis: 30000, statement_timeout: 900000 });
    c.on('error', () => {});
    await c.connect();
    try {
      for (const table of tables) {
        const filePath = path.join(dir, `${table}.jsonl.gz`);
        try {
          const { total: n, distinct: d } = await dumpJsonl(c, table, filePath);
          counts[table] = n;
          distinct[table] = d;
          if (d !== n) {
            console.error(
              `[backup] WARNING ${table}: wrote ${n} rows but only ${d} are distinct — the table changed mid-backup or pagination repeated rows.`
            );
          }
          console.log(`[backup] ${table}: ${n} rows -> ${path.basename(filePath)}`);
        } catch (e) {
          counts[table] = `ERR ${String(e.message).slice(0, 80)}`;
          console.error(`[backup] FAILED ${table}: ${e.message}`);
        }
      }
    } finally {
      await c.end().catch(() => {});
    }
  } else {
    for (const table of tables) {
      const c = new Client({ connectionString: DSN, connectionTimeoutMillis: 30000 });
      c.on('error', () => {});
      try {
        await c.connect();
        counts[table] = await countRows(c, table);
      } catch (e) {
        counts[table] = `ERR ${String(e.message).slice(0, 60)}`;
      } finally {
        await c.end().catch(() => {});
      }
    }
    pgDumpResult.bytes = fs.statSync(pgDumpResult.file).size;
  }

  const manifest = {
    timestamp: new Date().toISOString(),
    databaseHost: url.hostname,
    counts,
    distinctCounts: distinct,
    pgDump: pgDumpResult
      ? { mode: 'pg_dump', file: path.basename(pgDumpResult.file), bytes: pgDumpResult.bytes }
      : { mode: 'jsonl' },
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  pruneOldBackups();

  console.log(`\n=== BACKUP COMPLETE ===`);
  console.log(`Directory: ${dir}`);
  console.log(`Mode:      ${manifest.pgDump.mode}`);
  if (manifest.pgDump.mode === 'pg_dump') {
    console.log(`File:      ${manifest.pgDump.file} (${manifest.pgDump.bytes} bytes)`);
  }
  const total = Object.values(counts)
    .filter((v) => typeof v === 'number')
    .reduce((a, b) => a + b, 0);
  console.log(`Total rows across ${tables.length} tables: ${total}`);
})().catch((e) => {
  console.error('[backup] FATAL', e);
  process.exit(1);
});