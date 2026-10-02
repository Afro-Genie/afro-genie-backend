const { Client } = require('pg');
const { requireUrls } = require('./scripts/require-db-urls.cjs');

const urls = requireUrls({
  VIOLET: 'VIOLET_DATABASE_URL',
  RICE: 'RICE_DATABASE_URL',
});

const DBs = [
  { label: 'VIOLET', url: urls.VIOLET },
  { label: 'RICE', url: urls.RICE },
];

async function inspect(label, url) {
  const c = new Client({ connectionString: url });
  try {
    await c.connect();
    const tables = await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    console.log(`\n===== ${label} =====`);
    for (const { tablename } of tables.rows) {
      try {
        const r = await c.query(`SELECT COUNT(*)::int AS n FROM "${tablename}"`);
        if (r.rows[0].n > 0) console.log(`  ${tablename.padEnd(40)} ${r.rows[0].n}`);
      } catch (e) {}
    }
  } catch (e) { console.log(label, 'ERR', e.message); }
  try { await c.end(); } catch {}
}

(async () => {
  for (const db of DBs) await inspect(db.label, db.url);
})().catch((e) => { console.error(e); process.exit(1); });