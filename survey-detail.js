const { Client } = require('pg');

(async () => {
  const configs = [
    { label: 'VIOLET', url: 'postgresql://neondb_owner:npg_WSt4wEh2mfNi@ep-old-violet-aq9pxmi0-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require' },
    { label: 'RICE', url: 'postgresql://neondb_owner:npg_Li12PMrIHnZC@ep-old-rice-ataoe41y-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require' }
  ];
  const checks = ['Translation','TranslationVote','TranslationCorrection','Lyric','Favorite','UserHistory','SongPlay','Playlist','PlaylistLike','StoreItem','StorePurchase','Referral','SeasonalSnapshot','ContentReport','ModerationLog','Challenge','RoleRequest','TokenLedger','UserWallet','UserTier','UserStreak','ModPool','AICallLog','SyncRun','User','Topic','TopicComment','TopicVote','TopicCommentVote','ForumCategory','UserBadge','Notification','ArtistApplication','SongRequest','Genre','Language','Album','Artist','Song','SongGenre'];
  for (const cfg of configs) {
    const c = new Client({ connectionString: cfg.url });
    try {
      await c.connect();
      console.log('\n===== ' + cfg.label + ' =====');
      for (const t of checks) {
        try { const r = await c.query('SELECT COUNT(*)::int AS n FROM "' + t + '"'); if (r.rows[0].n > 0) console.log('  ' + t.padEnd(28) + r.rows[0].n); }
        catch (e) { console.log('  ' + t.padEnd(28) + 'ERR'); }
      }
    } catch (e) { console.log(cfg.label, 'CONN ERR', e.message); }
    try { await c.end(); } catch {}
  }
})().catch((e) => { console.error(e); process.exit(1); });