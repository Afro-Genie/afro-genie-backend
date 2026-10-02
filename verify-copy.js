const { Client } = require('pg');
const { requireUrls } = require('./scripts/require-db-urls.cjs');
(async () => {
  const { RICE: url } = requireUrls({ RICE: 'RICE_DATABASE_URL' });
  const c = new Client({ connectionString: url });
  await c.connect();
  const tabs = ['User','ForumCategory','Topic','TopicComment','TopicVote','TopicCommentVote','UserBadge','Notification','ArtistApplication','SongRequest','UserWallet','TokenLedger','UserTier','UserStreak','ContentReport','ModerationLog','RoleRequest','ModPool','SeasonalSnapshot','SyncRun','AICallLog','Challenge','Genre','Language','Artist'];
  for (const t of tabs) {
    try { const r = await c.query(`SELECT COUNT(*)::int AS n FROM "${t}"`); console.log(`${t}: ${r.rows[0].n}`); }
    catch (e) { console.log(`${t}: ERR`); }
  }
  const c2 = await c.query('SELECT id, "topicId", "userId", "parentCommentId" FROM "TopicComment" WHERE "parentCommentId" IS NOT NULL');
  console.log('comments w/ parent:', JSON.stringify(c2.rows));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });