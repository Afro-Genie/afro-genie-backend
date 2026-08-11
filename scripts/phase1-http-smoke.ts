import 'dotenv/config';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import { app } from '../src/app';
import { env } from '../src/lib/env';
import { prisma } from '../src/lib/prisma';

type Result = { name: string; pass: boolean; details: string };
const results: Result[] = [];
const addResult = (name: string, pass: boolean, details: string) => {
  results.push({ name, pass, details });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} :: ${details}`);
};

const seed = Date.now();
const ids: Record<string, string> = {};

const cleanup = async () => {
  try {
    if (ids.badge) await prisma.userBadge.delete({ where: { id: ids.badge } }).catch(() => undefined);
    if (ids.topic) await prisma.topic.delete({ where: { id: ids.topic } }).catch(() => undefined);
    if (ids.category) await prisma.forumCategory.delete({ where: { id: ids.category } }).catch(() => undefined);
    if (ids.song) await prisma.song.delete({ where: { id: ids.song } }).catch(() => undefined);
    if (ids.artist) await prisma.artist.delete({ where: { id: ids.artist } }).catch(() => undefined);
    for (const key of Object.keys(ids)) {
      if (key.startsWith('user')) {
        await prisma.user.delete({ where: { id: ids[key] } }).catch(() => undefined);
      }
    }
  } catch (err) {
    console.log('cleanup error (non-fatal):', err);
  }
};

const main = async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const user = await prisma.user.create({ data: { email: `p1_smoke_u_${seed}@example.com`, displayName: 'Smoke User' } });
    const admin = await prisma.user.create({ data: { email: `p1_smoke_a_${seed}@example.com`, displayName: 'Smoke Admin', role: 'ADMIN' } });
    ids.user = user.id;
    ids.userAdmin = admin.id;

    await awardSmokeEarn(user.id);

    const userToken = jwt.sign({ userId: user.id, email: user.email, role: user.role }, env.JWT_SECRET, { expiresIn: '5m' });
    const adminToken = jwt.sign({ userId: admin.id, email: admin.email, role: admin.role }, env.JWT_SECRET, { expiresIn: '5m' });

    const json = async <T = Record<string, unknown>>(path: string, init?: RequestInit) => {
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
      });
      const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
      return { status: res.status, body };
    };

    // 1. Auth required on /me/tokens
    const anonTokens = await json('/api/users/me/tokens');
    addResult('GET /users/me/tokens (anon) -> 401', anonTokens.status === 401, `status=${anonTokens.status}`);

    // 2. My tokens (auth)
    const myTokens = await json<{ rewards: unknown[]; pagination: { page: number; total: number } }>('/api/users/me/tokens?page=1&limit=2', {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    addResult('GET /users/me/tokens (auth) -> 200', myTokens.status === 200 && Array.isArray(myTokens.body.rewards) && myTokens.body.rewards.length === 1, JSON.stringify({ pagination: myTokens.body.pagination, rewards: myTokens.body.rewards?.length }));

    // 3. Public profile
    const profile = await json<{ id: string; tokenBalance: number; badges: unknown[] }>(`/api/users/${user.id}/profile`);
    addResult('GET /users/:id/profile -> 200', profile.status === 200 && profile.body.tokenBalance >= 5 && Array.isArray(profile.body.badges), JSON.stringify({ balance: profile.body.tokenBalance, badges: profile.body.badges?.length }));

    // 4. Leaderboard (public)
    const board = await json<Array<{ rank: number; userId: string }>>('/api/community/leaderboard?period=all');
    const mine = (board.body as Array<{ rank: number; userId: string }>).find((e) => e.userId === user.id);
    addResult('GET /community/leaderboard?period=all -> 200', board.status === 200 && Array.isArray(board.body) && !!mine, `entries=${Array.isArray(board.body) ? board.body.length : 'n/a'} rank=${mine?.rank}`);

    // 5. My rank (auth)
    const myRank = await json<{ rank: number | null; totalTokens: number }>('/api/community/leaderboard/me', {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    addResult('GET /community/leaderboard/me (auth) -> 200', myRank.status === 200 && myRank.body.rank !== null && myRank.body.totalTokens >= 5, JSON.stringify(myRank.body));

    // 6. Admin adjust (admin)
    const adjust = await json<{ success: boolean; reward?: { amount: number } }>('/api/admin/tokens/adjust', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ userId: user.id, amount: 10, reason: 'smoke bonus' }),
    });
    addResult('POST /admin/tokens/adjust (admin) -> 200', adjust.status === 200 && adjust.body.success === true, JSON.stringify(adjust.body));

    // 7. Admin adjust denied for non-admin
    const adjustDenied = await json('/api/admin/tokens/adjust', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ userId: user.id, amount: 10, reason: 'hax' }),
    });
    addResult('POST /admin/tokens/adjust (user) -> 403', adjustDenied.status === 403, `status=${adjustDenied.status}`);

    // 8. Admin rewards list
    const rewards = await json<{ data: unknown[]; pagination: { total: number } }>('/api/admin/rewards?page=1&limit=10', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    addResult('GET /admin/rewards (admin) -> 200', rewards.status === 200 && Array.isArray(rewards.body.data) && rewards.body.data.length >= 1, JSON.stringify(rewards.body.pagination));

    // 9. Admin rewards stats
    const stats = await json<{ totalRewards: number; totalTokensDistributed: number }>('/api/admin/rewards/stats', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    addResult('GET /admin/rewards/stats (admin) -> 200', stats.status === 200 && stats.body.totalRewards >= 1 && stats.body.totalTokensDistributed >= 5, JSON.stringify(stats.body));

    // 10. Topic share (auth)
    const artist = await prisma.artist.create({ data: { name: `Smoke Artist ${seed}` } });
    ids.artist = artist.id;
    const song = await prisma.song.create({ data: { title: `Smoke Song ${seed}`, artistId: artist.id } });
    ids.song = song.id;
    const category = await prisma.forumCategory.create({ data: { name: `Smoke Cat ${seed}` } });
    ids.category = category.id;
    const topic = await prisma.topic.create({ data: { title: `Smoke Topic ${seed}`, content: 'content', authorId: user.id, category: 'GENERAL', forumCategoryId: category.id } });
    ids.topic = topic.id;
    const share = await json<{ shares: number }>(`/api/community/topics/${topic.id}/share`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    addResult('POST /community/topics/:id/share -> 200', share.status === 200 && share.body.shares === 1, JSON.stringify(share.body));

    // 11. Badge revoke (admin)
    const badge = await prisma.userBadge.create({ data: { userId: user.id, badgeType: 'EARLY_ADOPTER' } });
    ids.badge = badge.id;
    const revoke = await json<{ success: boolean }>(`/api/admin/badges/${badge.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    addResult('DELETE /admin/badges/:id (admin) -> 200', revoke.status === 200 && revoke.body.success === true, JSON.stringify(revoke.body));

    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    if (failed > 0) process.exitCode = 1;
  } catch (err) {
    console.error('HTTP smoke test error:', err);
    process.exitCode = 1;
  } finally {
    server.close();
    await cleanup();
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
};

const awardSmokeEarn = async (userId: string) => {
  await prisma.userWallet.upsert({
    where: { userId },
    update: { balance: { increment: 5 } },
    create: { userId, balance: 5 },
  });
  await prisma.tokenLedger.create({
    data: {
      userId,
      type: 'EARN',
      amount: 5,
      balanceAfter: 5,
      reason: 'Smoke earn',
      sourceType: 'SMOKE',
      sourceId: `smoke-${userId}`,
      idempotencyKey: `smoke-earn:${userId}`,
    },
  });
};

main();
