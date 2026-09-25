const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: 'postgresql://neondb_owner:npg_Li12PMrIHnZC@ep-old-rice-ataoe41y-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require' });
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