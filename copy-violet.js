const { Client } = require('pg');
const { requireUrls } = require('./scripts/require-db-urls.cjs');

const { SRC, DST } = requireUrls({
  SRC: 'VIOLET_DATABASE_URL',
  DST: 'RICE_DATABASE_URL',
});

const TABLES = [
  'User', 'ForumCategory', 'Topic', 'TopicComment', 'TopicVote', 'TopicCommentVote',
  'UserBadge', 'Notification', 'ArtistApplication', 'SongRequest', 'UserWallet',
  'TokenLedger', 'UserTier', 'UserStreak', 'ContentReport', 'ModerationLog',
  'RoleRequest', 'ModPool', 'SeasonalSnapshot', 'SyncRun', 'AICallLog', 'Challenge',
];

const FK_REMAP = {
  Topic: [['artistId', 'Artist'], ['songId', 'Song']],
  TopicComment: [['parentCommentId', 'TopicComment']],
  Notification: [['userId', 'User']],
  ArtistApplication: [['userId', 'User'], ['reviewedByUserId', 'User']],
  SongRequest: [['userId', 'User']],
  UserBadge: [['userId', 'User']],
  UserWallet: [['userId', 'User']],
  TokenLedger: [['userId', 'User']],
  UserTier: [['userId', 'User']],
  UserStreak: [['userId', 'User']],
  ContentReport: [['reporterId', 'User'], ['moderatorId', 'User']],
  ModerationLog: [['moderatorId', 'User']],
  RoleRequest: [['userId', 'User']],
  TopicVote: [['userId', 'User'], ['topicId', 'Topic']],
  TopicCommentVote: [['userId', 'User'], ['commentId', 'TopicComment']],
  Challenge: [['creatorId', 'User']],
};

const NULLMAP = {};

async function copyTable(src, dst, t) {
  const colsRes = await src.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`,
    [t]);
  const insertCols = colsRes.rows.map((c) => c.column_name);
  const r = await src.query(`SELECT * FROM "${t}"`);
  const rows = r.rows;
  if (rows.length === 0) { console.log(`${t}: 0 rows, skip`); return; }

  const remap = FK_REMAP[t] || [];
  const refSetCache = {};
  for (const [col, fkTable] of remap) {
    const ids = [...new Set(rows.map((x) => x[col]).filter((x) => x != null))];
    if (ids.length === 0) continue;
    const ref = await src.query(`SELECT id FROM "${fkTable}" WHERE id = ANY($1)`, [ids]);
    refSetCache[col] = new Set(ref.rows.map((x) => x.id));
  }
  let nulled = 0;
  for (const row of rows) {
    for (const [col] of remap) {
      if (row[col] != null && refSetCache[col] && !refSetCache[col].has(row[col])) {
        console.log(`  ${t}: nulling ${col} (ref missing in SRC)`);
        row[col] = null; nulled++;
      }
    }
  }
  NULLMAP[t] = nulled;

  const buildClean = (row) => {
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

  const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(',');
  const sql = `INSERT INTO "${t}" (${insertCols.map((c) => `"${c}"`).join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
  const CONC = 150;
  let done = 0;

  const order = [];
  if (t === 'TopicComment') {
    const inSet = new Set(rows.map((r) => r.id));
    const pending = [...rows];
    const inserted = new Set();
    let guard = 0;
    while (pending.length && guard++ < 1000) {
      const ready = [];
      const rest = [];
      for (const row of pending) {
        const p = row.parentCommentId;
        if (p == null || inserted.has(p) || !inSet.has(p)) ready.push(row);
        else rest.push(row);
      }
      if (ready.length === 0) { throw new Error('cycle in TopicComment parents'); }
      order.push(...ready);
      for (const r of ready) inserted.add(r.id);
      pending.splice(0, pending.length, ...rest);
    }
    if (pending.length) throw new Error('still orphaned');
  } else {
    order.push(...rows);
  }

  while (order.length > 0) {
    const chunk = order.splice(0, CONC);
    await Promise.all(chunk.map((row) => dst.query(sql, buildClean(row))));
    done += chunk.length;
  }
  console.log(`${t}: inserted ${rows.length} (nulled ${nulled})`);
}

(async () => {
  const src = new Client({ connectionString: SRC });
  const dst = new Client({ connectionString: DST });
  await src.connect();
  await dst.connect();
  for (const t of TABLES) {
    try { await copyTable(src, dst, t); }
    catch (e) { console.error(`FAILED ${t}:`, e.message); process.exit(1); }
  }
  await src.end();
  await dst.end();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });