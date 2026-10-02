const { Client } = require('pg');
const { requireUrls } = require('./scripts/require-db-urls.cjs');

(async () => {
  const urls = requireUrls({
    VIOLET: 'VIOLET_DATABASE_URL',
    RICE: 'RICE_DATABASE_URL',
  });
  const configs = [
    { label: 'VIOLET', url: urls.VIOLET },
    { label: 'RICE', url: urls.RICE },
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