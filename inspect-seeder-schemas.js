const { Client } = require('pg');
const { requireUrls } = require('./scripts/require-db-urls.cjs');

(async () => {
  const { VIOLET: url } = requireUrls({ VIOLET: 'VIOLET_DATABASE_URL' });
  const c = new Client({ connectionString: url });
  await c.connect();
  for (const sch of ['seeder_e2e_20260702_staging_v6', 'seeder_e2e_20260702_staging_v7']) {
    const t = await c.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`, [sch]);
    console.log(`\n== ${sch} ==`);
    for (const row of t.rows) {
      try {
        const n = await c.query(`SELECT COUNT(*)::int AS n FROM "${sch}"."${row.table_name}"`);
        if (n.rows[0].n > 0) console.log(`  ${row.table_name}: ${n.rows[0].n}`);
      } catch (e) { console.log(`  ${row.table_name}: ERR ${e.message}`); }
    }
  }
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });