const { Client } = require('pg');
const { requireUrls } = require('./scripts/require-db-urls.cjs');

const { SRC, DST } = requireUrls({
  SRC: 'VIOLET_DATABASE_URL',
  DST: 'RICE_DATABASE_URL',
});

function mkClient(conn) { return new Client({ connectionString: conn }); }

async function withClient(conn, fn) {
  const c = mkClient(conn);
  await c.connect();
  try { return await fn(c); }
  finally { await c.end().catch(() => {}); }
}

const buildClean = (insertCols) => (row) => {
  const out = [];
  for (const c of insertCols) {
    let v = row[c];
    if (v === undefined || v === null) { out.push(null); continue; }
    if (Buffer.isBuffer(v)) { out.push(v.toString('hex')); continue; }
    if (typeof v === 'object' && !(v instanceof Date)) { out.push(JSON.stringify(v)); continue; }
    out.push(v);
  }
  return out;
};

async function copyResilient(t, CONC) {
  let srcRows;
  await withClient(SRC, async (src) => {
    const cols = await src.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`,
      [t]);
    const insertCols = cols.rows.map((c) => c.column_name);
    const r = await src.query(`SELECT * FROM "${t}"`);
    srcRows = { insertCols, rows: r.rows };
  });
  const { insertCols, rows } = srcRows;
  console.log(`${t}: ${rows.length} rows to copy`);
  const clean = buildClean(insertCols);
  const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(',');
  const sql = `INSERT INTO "${t}" (${insertCols.map((c) => `"${c}"`).join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

  const doneIds = new Set();
  const dst = mkClient(DST);
  await dst.connect();
  try {
    const got = await dst.query(`SELECT id FROM "${t}"`);
    for (const x of got.rows) doneIds.add(String(x.id));
  } catch (e) { console.log('existing-id scan failed:', e.message); }

  const pending = rows.filter((x) => !doneIds.has(String(x.id)));
  console.log(`${t}: need ${pending.length} (already ${doneIds.size})`);
  let i = 0;
  while (i < pending.length) {
    const chunk = pending.slice(i, i + CONC);
    try {
      await Promise.all(chunk.map((row) => dst.query(sql, clean(row))));
      i += chunk.length;
      if (i % 2000 < CONC) console.log(`${t}: ${i}/${pending.length}`);
    } catch (e) {
      console.log(`  retry @ ${i}: ${e.message}`);
      try { await dst.end().catch(() => {}); } catch (_) {}
      const nd = mkClient(DST);
      await nd.connect();
      dst = nd;
    }
  }
  await dst.end().catch(() => {});
  console.log(`${t}: done`);
}

(async () => {
  await copyResilient('AICallLog', 250);
  await copyResilient('Challenge', 40);
})().catch((e) => { console.error(e); process.exit(1); });