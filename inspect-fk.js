const { Client } = require('pg');
const { requireUrls } = require('./scripts/require-db-urls.cjs');

(async () => {
  const { VIOLET: url } = requireUrls({ VIOLET: 'VIOLET_DATABASE_URL' });
  const c = new Client({ connectionString: url });
  await c.connect();

  const r1 = await c.query('SELECT COUNT(*)::int AS n FROM "User" WHERE "referredByUserId" IS NOT NULL');
  console.log('users with referredByUserId:', r1.rows[0].n);

  const r2 = await c.query('SELECT "referredByUserId" FROM "User" WHERE "referredByUserId" IS NOT NULL LIMIT 5');
  console.log('sample:', JSON.stringify(r2.rows));

  const r3 = await c.query(`
    SELECT c.relname AS child, pc.conname, pg_get_constraintdef(pc.oid) AS def
    FROM pg_constraint pc
    JOIN pg_class c ON c.oid = pc.conrelid
    WHERE pc.contype = 'f'
      AND c.relname IN ('User','Topic','TopicComment','TopicVote','TopicCommentVote','Notification',
        'UserBadge','ArtistApplication','SongRequest','UserWallet','TokenLedger','UserTier','UserStreak',
        'Challenge','ContentReport','ModerationLog','RoleRequest','ModPool','SeasonalSnapshot','AICallLog','SyncRun','GameChallenge','GTPass','GTPayment')
    ORDER BY c.relname, pc.conname`);
  for (const row of r3.rows) console.log(JSON.stringify(row));

  const r4 = await c.query(`
    SELECT c.relname AS child, pc.conname, pg_get_constraintdef(pc.oid) AS def
    FROM pg_constraint pc
    JOIN pg_class c ON c.oid = pc.conrelid
    WHERE pc.contype = 'f'
      AND pc.confrelid = 'public."User"'::regclass
    ORDER BY c.relname`);
  console.log('--- things referencing User ---');
  for (const row of r4.rows) console.log(JSON.stringify(row));

  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });