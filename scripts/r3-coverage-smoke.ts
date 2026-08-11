import 'dotenv/config';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import { app } from '../src/app';
import { env } from '../src/lib/env';
import { prisma } from '../src/lib/prisma';
import { freezeSeason } from '../src/services/seasonService';

// ---------------------------------------------------------------------------
// R3.1 coverage smoke
//
// Exercises every endpoint on the §5 coverage matrix (plus authz gates and the
// §4 reward-event paths) against the live dev DB via a real HTTP server.
// All rows created here are cleaned up afterward.
// ---------------------------------------------------------------------------

type Result = { name: string; pass: boolean; details: string };
const results: Result[] = [];
const addResult = (name: string, pass: boolean, details: string) => {
  results.push({ name, pass, details });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} :: ${details}`);
};

const seed = Date.now();
const ids: Record<string, string> = {};
const uid = (): string => `r3-${seed}-${Math.random().toString(36).slice(2, 8)}`;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const json = async <T = Record<string, unknown>>(base: string, path: string, init?: RequestInit) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...JSON_HEADERS, ...(init?.headers || {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  return { status: res.status, body };
};

const ledgerCount = async (userId: string, sourceType: string, sourceId?: string) =>
  prisma.tokenLedger.count({
    where: { userId, sourceType, ...(sourceId ? { sourceId } : {}) },
  });

const cleanup = async () => {
  try {
    if (ids.period) {
      await prisma.seasonalSnapshot.deleteMany({ where: { period: ids.period } }).catch(() => undefined);
      await prisma.tokenLedger.deleteMany({ where: { sourceType: 'SEASON_BONUS', sourceId: ids.period } }).catch(() => undefined);
      await prisma.tokenLedger.deleteMany({ where: { sourceType: 'SEASON_TEST' } }).catch(() => undefined);
    }

    await prisma.moderationLog.deleteMany({ where: { targetType: 'MOD_POOL' } }).catch(() => undefined);
    if (ids.translation) {
      await prisma.moderationLog.deleteMany({ where: { targetId: ids.translation } }).catch(() => undefined);
    }

    if (ids.guideline) {
      await prisma.guideline.deleteMany({ where: { content: { startsWith: 'R3-smoke' } } }).catch(() => undefined);
    }

    const userIds = Object.entries(ids)
      .filter(([k]) => k.startsWith('user'))
      .map(([, v]) => v);

    if (ids.purchase) {
      await prisma.storePurchase.deleteMany({ where: { id: ids.purchase } }).catch(() => undefined);
    }
    if (ids.purchase2) {
      await prisma.storePurchase.deleteMany({ where: { id: ids.purchase2 } }).catch(() => undefined);
    }
    if (ids.itemAdmin) {
      await prisma.storeItem.deleteMany({ where: { id: ids.itemAdmin } }).catch(() => undefined);
    }
    if (ids.itemDigital) {
      await prisma.storeItem.deleteMany({ where: { id: ids.itemDigital } }).catch(() => undefined);
    }
    if (ids.itemPhysical) {
      await prisma.storeItem.deleteMany({ where: { id: ids.itemPhysical } }).catch(() => undefined);
    }

    if (ids.topic) {
      await prisma.topic.deleteMany({ where: { id: ids.topic } }).catch(() => undefined);
    }
    if (ids.category) {
      await prisma.forumCategory.deleteMany({ where: { id: ids.category } }).catch(() => undefined);
    }
    if (ids.song) {
      await prisma.song.deleteMany({ where: { id: ids.song } }).catch(() => undefined);
    }
    if (ids.artist) {
      await prisma.artist.deleteMany({ where: { id: ids.artist } }).catch(() => undefined);
    }

    for (const userId of userIds) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
  } catch (err) {
    console.log('cleanup error (non-fatal):', err);
  }
};

const main = async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api`;

  try {
    // ── Seed users ─────────────────────────────────────────────────────────
    const user = await prisma.user.create({ data: { email: `r3_u_${seed}@afrogenie.local`, displayName: 'R3 User' } });
    const moderator = await prisma.user.create({ data: { email: `r3_m_${seed}@afrogenie.local`, displayName: 'R3 Mod', role: 'MODERATOR' } });
    const admin = await prisma.user.create({ data: { email: `r3_a_${seed}@afrogenie.local`, displayName: 'R3 Admin', role: 'ADMIN' } });
    const referrer = await prisma.user.create({ data: { email: `r3_r_${seed}@afrogenie.local`, displayName: 'R3 Referrer' } });
    ids.user = user.id;
    ids.userMod = moderator.id;
    ids.userAdmin = admin.id;
    ids.userReferrer = referrer.id;

    const tkn = (u: { id: string; email: string; role: string }) =>
      jwt.sign({ userId: u.id, email: u.email, role: u.role }, env.JWT_SECRET, { expiresIn: '5m' });
    const userToken = tkn(user);
    const modToken = tkn(moderator);
    const adminToken = tkn(admin);
    const referrerToken = tkn(referrer);

    // ── Seed catalog ───────────────────────────────────────────────────────
    const artist = await prisma.artist.create({ data: { name: `R3 Artist ${seed}` } });
    ids.artist = artist.id;
    const song = await prisma.song.create({ data: { title: `R3 Song ${seed}`, artistId: artist.id } });
    ids.song = song.id;
    const category = await prisma.forumCategory.create({ data: { name: `R3 Cat ${seed}` } });
    ids.category = category.id;
    const topic = await prisma.topic.create({
      data: { title: `R3 Topic ${seed}`, content: 'content', authorId: user.id, category: 'GENERAL', forumCategoryId: category.id },
    });
    ids.topic = topic.id;

    const mkTranslation = async (sourceLang: string, targetLang: string, status: string) =>
      prisma.translation.create({
        data: {
          songId: song.id,
          userId: moderator.id,
          sourceLang,
          targetLang,
          originalLyrics: `Original ${targetLang}`,
          translatedLyrics: `Translated ${targetLang}`,
          status,
          ...(status === 'APPROVED'
            ? { approvedById: admin.id, approvedAt: new Date(), reviewedById: admin.id, reviewedAt: new Date() }
            : {}),
        },
      });

    const tPending = await mkTranslation('en', 'es', 'PENDING');
    ids.translationPending = tPending.id;
    const tReject = await mkTranslation('en', 'pt', 'PENDING');
    ids.translationReject = tReject.id;
    const tApproved = await mkTranslation('en', 'fr', 'APPROVED');
    ids.translation = tApproved.id;

    // Store items
    const itemDigital = await prisma.storeItem.create({
      data: { name: `R3 Digital ${seed}`, description: 'digital', tokenCost: 25, category: 'perks', metadata: { digital: true, entitlementType: 'TRANSLATION_PASS' } },
    });
    ids.itemDigital = itemDigital.id;
    const itemPhysical = await prisma.storeItem.create({
      data: { name: `R3 Physical ${seed}`, description: 'physical', tokenCost: 40, category: 'merch' },
    });
    ids.itemPhysical = itemPhysical.id;

    // Badge for the revoke check
    const badge = await prisma.userBadge.create({ data: { userId: user.id, badgeType: 'EARLY_ADOPTER' } });
    ids.badge = badge.id;

    // ── Authz gates ────────────────────────────────────────────────────────
    let r = await json(base, '/users/me/tokens');
    addResult('GET /users/me/tokens (anon) -> 401', r.status === 401, `status=${r.status}`);

    r = await json(base, '/users/me/tokens', { headers: { Authorization: 'Bearer not-a-token' } });
    addResult('GET /users/me/tokens (bad token) -> 401', r.status === 401, `status=${r.status}`);

    r = await json(base, '/store/purchase', {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-token' },
      body: JSON.stringify({ itemId: itemDigital.id }),
    });
    addResult('POST /store/purchase (anon) -> 401', r.status === 401, `status=${r.status}`);

    r = await json(base, '/admin/tokens/adjust', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ userId: user.id, amount: 10, reason: 'hax' }),
    });
    addResult('POST /admin/tokens/adjust (user) -> 403', r.status === 403, `status=${r.status}`);

    r = await json(base, '/admin/moderation/pool/distribute', { method: 'POST', headers: { Authorization: `Bearer ${userToken}` } });
    addResult('POST /admin/moderation/pool/distribute (user) -> 403', r.status === 403, `status=${r.status}`);

    r = await json(base, '/admin/store/items', { headers: { Authorization: `Bearer ${modToken}` } });
    addResult('GET /admin/store/items (moderator) -> 403', r.status === 403, `status=${r.status}`);

    r = await json(base, '/admin/moderation/translations/' + tApproved.id + '/overturn', { method: 'PATCH', headers: { Authorization: `Bearer ${modToken}` } });
    addResult('PATCH .../overturn (moderator) -> 403', r.status === 403, `status=${r.status}`);

    // ── Section A: token economy endpoints ─────────────────────────────────
    r = await json(base, `/users/${user.id}/profile`);
    addResult('GET /users/:id/profile -> 200 + tokenBalance', r.status === 200 && typeof r.body.tokenBalance === 'number', JSON.stringify(r.body));

    r = await json(base, '/users/me/tokens?page=1&limit=5', { headers: { Authorization: `Bearer ${userToken}` } });
    addResult('GET /users/me/tokens (auth) -> 200 + rewards', r.status === 200 && Array.isArray(r.body.rewards) && r.body.pagination?.total !== undefined, JSON.stringify(r.body.pagination));

    r = await json(base, '/community/leaderboard?period=all&scope=tokens');
    addResult('GET /community/leaderboard?period=all&scope=tokens -> 200', r.status === 200 && Array.isArray(r.body), `entries=${Array.isArray(r.body) ? r.body.length : 'n/a'}`);

    r = await json(base, '/community/leaderboard?period=week&scope=quality');
    addResult('GET /community/leaderboard?period=week&scope=quality -> 200', r.status === 200 && Array.isArray(r.body), `entries=${Array.isArray(r.body) ? r.body.length : 'n/a'}`);

    r = await json(base, '/community/leaderboard?period=bogus', { headers: { Authorization: `Bearer ${userToken}` } });
    addResult('GET /community/leaderboard?period=bogus -> 400', r.status === 400, `status=${r.status}`);

    r = await json(base, '/community/leaderboard/me', { headers: { Authorization: `Bearer ${userToken}` } });
    addResult('GET /community/leaderboard/me (auth) -> 200', r.status === 200 && 'rank' in r.body, JSON.stringify(r.body));

    // ── Section B: store ───────────────────────────────────────────────────
    r = await json(base, '/admin/tokens/adjust', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ userId: user.id, amount: 100, reason: 'R3 smoke funding' }),
    });
    addResult('POST /admin/tokens/adjust (admin) -> 200', r.status === 200 && r.body.success === true, JSON.stringify(r.body));

    r = await json(base, '/store/items');
    addResult('GET /store/items (public) -> 200 + owned flag', r.status === 200 && Array.isArray(r.body) && 'owned' in r.body[0], `items=${Array.isArray(r.body) ? r.body.length : 'n/a'}`);

    const purchaseToken = `r3-purchase-${seed}`;
    r = await json<{ id: string; status: string; spentAmount: number }>(base, '/store/purchase', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ itemId: itemDigital.id, purchaseToken }),
    });
    const purchaseId = r.body.id;
    ids.purchase = purchaseId;
    addResult('POST /store/purchase (digital) -> 201 + ledger debit', r.status === 201 && r.body.spentAmount === 25, JSON.stringify(r.body));

    const debitRows = await ledgerCount(user.id, 'STORE_PURCHASE', purchaseToken);
    addResult('Purchase wrote exactly 1 SPEND ledger row', debitRows === 1, `rows=${debitRows}`);

    const entitlement = await prisma.userEntitlement.findUnique({ where: { userId_type: { userId: user.id, type: 'TRANSLATION_PASS' } } });
    addResult('Digital purchase granted TRANSLATION_PASS entitlement', !!entitlement, entitlement ? entitlement.type : 'missing');

    r = await json(base, '/store/purchase', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ itemId: itemDigital.id, purchaseToken }),
    });
    addResult('Purchase replay with same token -> same id (idempotent)', r.status === 201 && r.body.id === purchaseId, `id=${r.body.id}`);

    r = await json(base, '/store/purchases/me', { headers: { Authorization: `Bearer ${userToken}` } });
    addResult('GET /store/purchases/me -> 200 + history', r.status === 200 && Array.isArray(r.body) && r.body.some((p: { id: string }) => p.id === purchaseId), `count=${Array.isArray(r.body) ? r.body.length : 'n/a'}`);

    r = await json(base, '/store/entitlements', { headers: { Authorization: `Bearer ${userToken}` } });
    addResult('GET /store/entitlements -> 200', r.status === 200 && Array.isArray(r.body), `count=${Array.isArray(r.body) ? r.body.length : 'n/a'}`);

    r = await json(base, '/store/purchase', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ itemId: itemPhysical.id }),
    });
    ids.purchase2 = r.body.id;
    addResult('POST /store/purchase (physical) -> 201 + PENDING_FULFILLMENT', r.status === 201 && r.body.status === 'PENDING_FULFILLMENT', JSON.stringify(r.body));

    // Admin store CRUD
    r = await json(base, '/admin/store/items', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: `R3 AdminItem ${seed}`, description: 'x', tokenCost: 5, category: 'admin' }),
    });
    const adminItemId = r.body.id;
    ids.itemAdmin = adminItemId;
    addResult('POST /admin/store/items (admin) -> 201', r.status === 201 && !!adminItemId, JSON.stringify(r.body));

    r = await json(base, `/admin/store/items/${adminItemId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ tokenCost: 7 }),
    });
    addResult('PATCH /admin/store/items/:id (admin) -> 200', r.status === 200 && r.body.tokenCost === 7, JSON.stringify(r.body));

    r = await json(base, '/admin/store/items', { headers: { Authorization: `Bearer ${adminToken}` } });
    addResult('GET /admin/store/items (admin) -> 200', r.status === 200 && Array.isArray(r.body), `items=${Array.isArray(r.body) ? r.body.length : 'n/a'}`);

    r = await json(base, `/admin/store/purchases`, { headers: { Authorization: `Bearer ${adminToken}` } });
    addResult('GET /admin/store/purchases (admin) -> 200 + physical purchase', r.status === 200 && Array.isArray(r.body.data) && r.body.data.some((p: { id: string }) => p.id === ids.purchase2), JSON.stringify(r.body.pagination));

    r = await json(base, `/admin/store/purchases/${ids.purchase2}/fulfill`, { method: 'PATCH', headers: { Authorization: `Bearer ${adminToken}` } });
    addResult('PATCH /admin/store/purchases/:id/fulfill (admin) -> 200 + FULFILLED', r.status === 200 && r.body.status === 'FULFILLED', JSON.stringify(r.body));

    r = await json(base, `/admin/store/items/${adminItemId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
    addResult('DELETE /admin/store/items/:id (admin) -> 200 (soft-hide)', r.status === 200 && r.body.success === true, JSON.stringify(r.body));

    const hidden = await prisma.storeItem.findUnique({ where: { id: adminItemId } });
    addResult('Deleted admin item is soft-hidden (active=false)', hidden?.active === false, `active=${hidden?.active}`);

    // ── Section C: moderation / reports / arbitration ──────────────────────
    r = await json(base, '/moderation/report', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ targetType: 'TOPIC', targetId: topic.id, reason: 'R3 smoke report', description: 'needs review' }),
    });
    const reportId = r.body.id;
    ids.report = reportId;
    addResult('POST /moderation/report (user) -> 201 + PENDING', r.status === 201 && r.body.status === 'PENDING', JSON.stringify(r.body));

    r = await json(base, '/admin/moderation/reports', { headers: { Authorization: `Bearer ${modToken}` } });
    addResult('GET /admin/moderation/reports (mod) -> 200', r.status === 200 && Array.isArray(r.body.data), JSON.stringify(r.body.pagination));

    r = await json(base, `/admin/moderation/reports/${reportId}/resolve`, { method: 'PATCH', headers: { Authorization: `Bearer ${modToken}` } });
    addResult('PATCH .../reports/:id/resolve (mod) -> 200 + RESOLVED', r.status === 200 && r.body.status === 'RESOLVED', JSON.stringify(r.body));

    const reportReward = await ledgerCount(moderator.id, 'REPORT_RESOLVED', reportId);
    addResult('Resolve wrote +REPORT_RESOLVED ledger row', reportReward === 1, `rows=${reportReward}`);

    r = await json(base, `/admin/moderation/reports/${reportId}/resolve`, { method: 'PATCH', headers: { Authorization: `Bearer ${modToken}` } });
    addResult('Double-resolve is a no-op (still 1 reward row)', r.status === 200 && r.body.status === 'RESOLVED' && (await ledgerCount(moderator.id, 'REPORT_RESOLVED', reportId)) === 1, JSON.stringify(r.body));

    r = await json(base, '/admin/moderation/reports/stats', { headers: { Authorization: `Bearer ${modToken}` } });
    addResult('GET /admin/moderation/reports/stats (mod) -> 200', r.status === 200 && r.body.total !== undefined, JSON.stringify(r.body));

    r = await json(base, `/admin/moderation/translations/${tApproved.id}/overturn`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ reason: 'R3 smoke overturn' }),
    });
    addResult('PATCH .../translations/:id/overturn (admin) -> 200 + overturned', r.status === 200 && r.body.overturned === true && r.body.status === 'PENDING', JSON.stringify(r.body));

    const clawback = await ledgerCount(admin.id, 'OVERTURN_CLAWBACK', tApproved.id);
    const penalty = await ledgerCount(admin.id, 'OVERTURN_PENALTY', tApproved.id);
    addResult('Overturn wrote clawback + penalty ledger rows', clawback === 1 && penalty === 1, `clawback=${clawback} penalty=${penalty}`);

    r = await json(base, `/admin/moderation/translations/${tApproved.id}/overturn`, { method: 'PATCH', headers: { Authorization: `Bearer ${adminToken}` } });
    addResult('Double-overturn is a no-op (overturned=false)', r.status === 200 && r.body.overturned === false, JSON.stringify(r.body));

    r = await json(base, '/admin/moderation/overturn-rate?days=30', { headers: { Authorization: `Bearer ${adminToken}` } });
    addResult('GET /admin/moderation/overturn-rate (admin) -> 200 + rate', r.status === 200 && typeof r.body.rate === 'number', JSON.stringify(r.body));

    r = await json(base, `/admin/moderation/moderator/${moderator.id}/stats`, { headers: { Authorization: `Bearer ${modToken}` } });
    addResult('GET /admin/moderation/moderator/:id/stats (mod) -> 200', r.status === 200, JSON.stringify(r.body));

    r = await json(base, '/admin/moderation/guidelines', { headers: { Authorization: `Bearer ${modToken}` } });
    addResult('GET /admin/moderation/guidelines (mod) -> 200', r.status === 200, JSON.stringify(r.body));

    r = await json(base, '/admin/moderation/guidelines', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${modToken}` },
      body: JSON.stringify({ content: 'R3-smoke guideline v1' }),
    });
    ids.guideline = r.body.id;
    addResult('PUT /admin/moderation/guidelines (mod) -> 200 + version bump', r.status === 200 && r.body.content === 'R3-smoke guideline v1' && r.body.version >= 1, JSON.stringify(r.body));

    r = await json(base, `/admin/moderation/users/${user.id}/welcome`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${modToken}` },
      body: JSON.stringify({ message: 'R3 smoke welcome' }),
    });
    addResult('POST /admin/moderation/users/:id/welcome (mod) -> 200', r.status === 200, JSON.stringify(r.body));

    const welcomeNotif = await prisma.notification.count({ where: { userId: user.id, title: 'Welcome to Afro Genie!' } });
    addResult('Welcome created a SYSTEM notification', welcomeNotif >= 1, `count=${welcomeNotif}`);

    r = await json(base, '/admin/moderation/new-users?days=30', { headers: { Authorization: `Bearer ${modToken}` } });
    addResult('GET /admin/moderation/new-users (mod) -> 200', r.status === 200, JSON.stringify(r.body));

    r = await json(base, '/admin/moderation/artist-applications', { headers: { Authorization: `Bearer ${modToken}` } });
    addResult('GET /admin/moderation/artist-applications (mod) -> 200', r.status === 200, JSON.stringify(r.body));

    r = await json(base, '/admin/moderation/correction-requests', { headers: { Authorization: `Bearer ${modToken}` } });
    addResult('GET /admin/moderation/correction-requests (mod) -> 200', r.status === 200, JSON.stringify(r.body));

    // ── Section D: translation moderation + corrections ────────────────────
    r = await json(base, '/admin/moderation/translations?status=PENDING', { headers: { Authorization: `Bearer ${modToken}` } });
    addResult('GET /admin/moderation/translations?status=PENDING (mod) -> 200', r.status === 200 && Array.isArray(r.body.data), JSON.stringify(r.body.pagination));

    r = await json(base, `/admin/moderation/translations/${tPending.id}/approve`, { method: 'PATCH', headers: { Authorization: `Bearer ${modToken}` } });
    addResult('PATCH .../translations/:id/approve (mod) -> 200 + APPROVED', r.status === 200 && r.body.status === 'APPROVED', JSON.stringify(r.body));

    const approveReward = await ledgerCount(moderator.id, 'TRANSLATION_APPROVED', tPending.id);
    const taxRows = await ledgerCount(moderator.id, 'MOD_POOL_TAX', tPending.id);
    addResult('Approve wrote +reward and -tax ledger rows', approveReward === 1 && taxRows === 1, `reward=${approveReward} tax=${taxRows}`);

    r = await json(base, `/admin/moderation/translations/${tPending.id}/approve`, { method: 'PATCH', headers: { Authorization: `Bearer ${modToken}` } });
    addResult('Double-approve is a no-op (still 1 reward row)', r.status === 200 && (await ledgerCount(moderator.id, 'TRANSLATION_APPROVED', tPending.id)) === 1, JSON.stringify(r.body));

    r = await json(base, `/admin/translations/${tReject.id}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${modToken}` },
      body: JSON.stringify({ reason: 'R3 smoke reject' }),
    });
    addResult('POST /admin/translations/:id/reject (mod) -> 200 + REJECTED', r.status === 200 && r.body.status === 'REJECTED', JSON.stringify(r.body));

    r = await json(base, `/translations/${tApproved.id}/correction-request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ suggestedText: 'R3 smoke corrected translation text here', reason: 'R3 smoke correction' }),
    });
    const correctionId = r.body.id;
    ids.correction = correctionId;
    addResult('POST /translations/:id/correction-request (user) -> 201 + PENDING', r.status === 201 && r.body.status === 'PENDING', JSON.stringify(r.body));

    r = await json(base, `/translations/${tApproved.id}/correction-history`);
    addResult('GET /translations/:id/correction-history -> 200', r.status === 200, JSON.stringify(r.body));

    r = await json(base, '/admin/moderation/corrections?status=PENDING', { headers: { Authorization: `Bearer ${modToken}` } });
    addResult('GET /admin/moderation/corrections?status=PENDING (mod) -> 200', r.status === 200 && Array.isArray(r.body.data), JSON.stringify(r.body.pagination));

    r = await json(base, `/admin/translations/corrections/${correctionId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${modToken}` },
      body: JSON.stringify({ status: 'APPROVED' }),
    });
    addResult('PATCH /admin/translations/corrections/:id (mod) -> 200 + APPROVED', r.status === 200 && r.body.status === 'APPROVED', JSON.stringify(r.body));

    const correctionReward = await ledgerCount(user.id, 'CORRECTION', correctionId);
    addResult('Correction approval wrote +CORRECTION ledger row', correctionReward === 1, `rows=${correctionReward}`);

    r = await json(base, `/admin/lyrics/${song.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${modToken}` },
      body: JSON.stringify({ content: 'R3 smoke lyrics replacement' }),
    });
    addResult('PATCH /admin/lyrics/:songId (mod) -> 200', r.status === 200, JSON.stringify(r.body));

    // ── Section E: referrals ───────────────────────────────────────────────
    r = await json(base, '/referrals', { headers: { Authorization: `Bearer ${userToken}` } });
    addResult('GET /referrals (auth) -> 200', r.status === 200 && 'referrals' in r.body, JSON.stringify(r.body));

    r = await json(base, '/referrals/code', { method: 'POST', headers: { Authorization: `Bearer ${referrerToken}` } });
    const referralCode = r.body.referralCode;
    addResult('POST /referrals/code (auth) -> 200 + code', r.status === 200 && typeof referralCode === 'string', JSON.stringify(r.body));

    r = await json(base, '/referrals/apply', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ code: referralCode }),
    });
    addResult('POST /referrals/apply (auth) -> 200', r.status === 200, JSON.stringify(r.body));

    const referralReward = await ledgerCount(referrer.id, 'REFERRAL');
    addResult('Referral wrote +REFERRAL ledger row for referrer', referralReward === 1, `rows=${referralReward}`);

    r = await json(base, '/referrals/apply', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ code: referralCode }),
    });
    addResult('Referral replay -> ALREADY_REFERRED (409)', r.status === 409 && r.body.code === 'ALREADY_REFERRED', `status=${r.status} code=${r.body.code}`);

    // ── Section F: seasons ─────────────────────────────────────────────────
    ids.period = '1999-05';
    await prisma.tokenLedger.createMany({
      data: [
        { userId: user.id, type: 'EARN', amount: 30, balanceAfter: 30, reason: 'R3 season seed', sourceType: 'SEASON_TEST', sourceId: `season-${uid()}`, idempotencyKey: `season-${uid()}`, createdAt: new Date(Date.UTC(1999, 4, 2)) },
        { userId: moderator.id, type: 'EARN', amount: 20, balanceAfter: 20, reason: 'R3 season seed', sourceType: 'SEASON_TEST', sourceId: `season-${uid()}`, idempotencyKey: `season-${uid()}`, createdAt: new Date(Date.UTC(1999, 4, 3)) },
      ],
    });

    const snapshot = await freezeSeason(new Date(Date.UTC(1999, 4, 15)));
    addResult('freezeSeason seeded 1999-05 snapshot', snapshot.period === ids.period, `period=${snapshot.period}`);

    r = await json(base, '/community/leaderboard/seasons');
    addResult('GET /community/leaderboard/seasons -> 200 + frozen period', r.status === 200 && Array.isArray(r.body) && r.body.some((s: { period: string }) => s.period === ids.period), JSON.stringify(r.body));

    const seasonId = (r.body as Array<{ period: string; id: string }>).find((s) => s.period === ids.period)?.id;
    r = await json(base, `/community/leaderboard/seasons/${seasonId}`);
    addResult('GET /community/leaderboard/seasons/:id -> 200 + data', r.status === 200 && r.body.period === ids.period && 'data' in r.body, JSON.stringify({ status: r.status, period: r.body.period }));

    // ── Section G: notifications ───────────────────────────────────────────
    r = await json(base, '/users/me/notifications/unread-count', { headers: { Authorization: `Bearer ${userToken}` } });
    addResult('GET /users/me/notifications/unread-count (auth) -> 200', r.status === 200 && typeof r.body.count === 'number' && r.body.count >= 1, JSON.stringify(r.body));

    r = await json(base, '/users/me/notifications?page=1&limit=5', { headers: { Authorization: `Bearer ${userToken}` } });
    addResult('GET /users/me/notifications (auth) -> 200', r.status === 200 && Array.isArray(r.body.data), JSON.stringify(r.body.pagination));

    const firstNotif = r.body.data?.[0];
    if (firstNotif?.id) {
      r = await json(base, `/users/me/notifications/${firstNotif.id}/read`, { method: 'PATCH', headers: { Authorization: `Bearer ${userToken}` } });
      addResult('PATCH /users/me/notifications/:id/read (auth) -> 200', r.status === 200, JSON.stringify(r.body));
    } else {
      addResult('PATCH /users/me/notifications/:id/read (auth) -> 200', false, 'no notification to mark');
    }

    // ── Section H: mod pool distribution ───────────────────────────────────
    const poolBefore = (await prisma.modPool.findUnique({ where: { id: 'default' } }))?.balance ?? 0;
    await prisma.modPool.upsert({ where: { id: 'default' }, update: { balance: 60 }, create: { id: 'default', balance: 60 } });

    r = await json(base, '/admin/moderation/pool/distribute', { method: 'POST', headers: { Authorization: `Bearer ${modToken}` } });
    addResult('POST /admin/moderation/pool/distribute (mod) -> 200 + distributed', r.status === 200 && r.body.distributed > 0, JSON.stringify(r.body));

    const poolDist = await ledgerCount(moderator.id, 'MOD_POOL');
    addResult('Pool distribution wrote +MOD_POOL ledger row', poolDist >= 1, `rows=${poolDist}`);

    await prisma.modPool.upsert({ where: { id: 'default' }, update: { balance: poolBefore }, create: { id: 'default', balance: poolBefore } });

    // ── Section I: translation request (existing translation path) ─────────
    r = await json(base, '/translations/request', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ songId: song.id, sourceLang: 'en', targetLang: 'es' }),
    });
    addResult('POST /translations/request (existing approved) -> 200', r.status === 200 && r.body.status === 'existing', JSON.stringify(r.body));

    r = await json(base, `/translations/${song.id}`);
    addResult('GET /translations/:songId -> 200 + grouped', r.status === 200 && r.body.translations !== undefined, JSON.stringify({ status: r.status }));

    // ── Admin reward manager ───────────────────────────────────────────────
    r = await json(base, '/admin/rewards?page=1&limit=10', { headers: { Authorization: `Bearer ${adminToken}` } });
    addResult('GET /admin/rewards (admin) -> 200', r.status === 200 && Array.isArray(r.body.data), JSON.stringify(r.body.pagination));

    r = await json(base, '/admin/rewards/stats', { headers: { Authorization: `Bearer ${adminToken}` } });
    addResult('GET /admin/rewards/stats (admin) -> 200', r.status === 200 && r.body.totalRewards !== undefined, JSON.stringify(r.body));

    r = await json(base, `/admin/badges/${badge.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
    addResult('DELETE /admin/badges/:id (admin) -> 200', r.status === 200 && r.body.success === true, JSON.stringify(r.body));

    // ── Summary ────────────────────────────────────────────────────────────
    const failed = results.filter((res) => !res.pass).length;
    console.log('\n──────────────────────────────────────────────────────');
    console.log(`${results.length - failed}/${results.length} checks passed`);
    console.log('Coverage: authz gates, token economy, store (user+admin), reports/arbitration,');
    console.log('           translation moderation + corrections, referrals, seasons, notifications, pool.');
    if (failed > 0) process.exitCode = 1;
  } catch (err) {
    console.error('R3 coverage smoke error:', err);
    process.exitCode = 1;
  } finally {
    server.close();
    await cleanup();
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
};

main();
