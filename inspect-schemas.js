const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: 'postgresql://neondb_owner:npg_WSt4wEh2mfNi@ep-old-violet-aq9pxmi0-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require' });
  await c.connect();
  const s = await c.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'");
  console.log('schemas:', s.rows.map((r) => r.nspname).join(', '));
  for (const sch of s.rows) {
    try {
      const t = await c.query(`SELECT COUNT(*)::int AS n FROM "${sch.nspname}"."_prisma_migrations"`);
      console.log(`${sch.nspname}: migrations=${t.rows[0].n}`);
    } catch (e) { console.log(`${sch.nspname}: no migrations`); }
  }
  const tr = await c.query('SELECT COUNT(*)::int AS n FROM public."Translation"');
  console.log('public Translation count:', tr.rows[0].n);
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });