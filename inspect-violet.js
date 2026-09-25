const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: 'postgresql://neondb_owner:npg_WSt4wEh2mfNi@ep-old-violet-aq9pxmi0-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require' });
  await c.connect();
  const u = await c.query('SELECT id, email, "displayName", role, "createdAt" FROM "User" ORDER BY "createdAt" ASC LIMIT 8');
  console.log('--- SAMPLE USERS ---');
  u.rows.forEach((r) => console.log(JSON.stringify(r)));
  const t = await c.query('SELECT id, title, "authorId", category, "forumCategoryId", "songId" FROM "Topic"');
  console.log('--- TOPICS ---');
  t.rows.forEach((r) => console.log(JSON.stringify(r)));
  const sg = await c.query('SELECT COUNT(*)::int AS n FROM "Topic" WHERE "songId" IS NOT NULL');
  console.log('topics with songId:', sg.rows[0].n);
  const af = await c.query('SELECT "userId", COUNT(*)::int AS n FROM "Topic" GROUP BY "authorId" LIMIT 10');
  console.log('topic authors:', JSON.stringify(af.rows));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });