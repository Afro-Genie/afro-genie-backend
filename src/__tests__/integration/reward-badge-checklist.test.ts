import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const API_URL = process.env.TEST_API_URL || 'http://localhost:3001/api';

async function apiGet(path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { headers });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function apiPost(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function apiDelete(path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { method: 'DELETE', headers });
  return { status: res.status, data: await res.json().catch(() => null) };
}

describe('Reward & Badge System Integration', () => {
  let adminToken = '';
  let testUserId = '';

  before(async () => {
    // Register a test user for admin operations
    const registerRes = await apiPost('/auth/register', {
      email: `reward-test-${Date.now()}@example.com`,
      password: 'TestPassword123!',
      displayName: 'Reward Test User',
    });

    if (registerRes.status === 201 && registerRes.data?.accessToken) {
      adminToken = registerRes.data.accessToken;
      testUserId = registerRes.data.user?.id || '';
    }
  });

  describe('Health Endpoint - Reward Queue', () => {
    it('GET /health includes rewards.queue stats', async () => {
      const res = await apiGet('/health');
      assert.equal(res.status, 200);
      assert.ok(res.data.rewards, 'health response should include rewards field');
      assert.ok(typeof res.data.rewards.queue.waiting === 'number', 'queue should have waiting count');
      assert.ok(typeof res.data.rewards.queue.active === 'number', 'queue should have active count');
      assert.ok(typeof res.data.rewards.queue.completed === 'number', 'queue should have completed count');
      assert.ok(typeof res.data.rewards.queue.failed === 'number', 'queue should have failed count');
    });
  });

  describe('Leaderboard - Time Filtering', () => {
    it('GET /community/leaderboard returns array', async () => {
      const res = await apiGet('/community/leaderboard');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data), 'leaderboard should be an array');
    });

    it('GET /community/leaderboard?period=week returns array', async () => {
      const res = await apiGet('/community/leaderboard?period=week');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data));
    });

    it('GET /community/leaderboard?period=month returns array', async () => {
      const res = await apiGet('/community/leaderboard?period=month');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data));
    });

    it('GET /community/leaderboard?period=invalid returns 400', async () => {
      const res = await apiGet('/community/leaderboard?period=year');
      assert.equal(res.status, 400);
    });
  });

  describe('Leaderboard - My Rank', () => {
    it('GET /community/leaderboard/me requires auth', async () => {
      const res = await apiGet('/community/leaderboard/me');
      assert.equal(res.status, 401);
    });

    it('GET /community/leaderboard/me returns rank for authenticated user', async () => {
      if (!adminToken) return; // skip if registration failed
      const res = await apiGet('/community/leaderboard/me', adminToken);
      assert.equal(res.status, 200);
      assert.ok('totalTokens' in res.data, 'response should have totalTokens');
      assert.ok('rewardCount' in res.data, 'response should have rewardCount');
    });

    it('GET /community/leaderboard/me?period=week works', async () => {
      if (!adminToken) return;
      const res = await apiGet('/community/leaderboard/me?period=week', adminToken);
      assert.equal(res.status, 200);
      assert.ok('totalTokens' in res.data);
    });
  });

  describe('Admin Token Adjustment', () => {
    it('POST /admin/tokens/adjust requires ADMIN role', async () => {
      if (!adminToken) return;
      const res = await apiPost('/admin/tokens/adjust', {
        userId: testUserId,
        amount: 10,
        reason: 'Test adjustment',
      }, adminToken);
      // Regular user should get 403
      assert.ok([403, 401].includes(res.status), `Expected 403 or 401, got ${res.status}`);
    });
  });

  describe('Admin Rewards Audit Log', () => {
    it('GET /admin/rewards requires ADMIN role', async () => {
      if (!adminToken) return;
      const res = await apiGet('/admin/rewards', adminToken);
      // Regular user should get 403
      assert.ok([403, 401].includes(res.status), `Expected 403 or 401, got ${res.status}`);
    });
  });

  describe('Admin Badge Revocation', () => {
    it('DELETE /admin/badges/:id requires ADMIN role', async () => {
      if (!adminToken) return;
      const res = await apiDelete('/admin/badges/fake-badge-id', adminToken);
      assert.ok([403, 401, 404].includes(res.status));
    });
  });

  describe('User Profile - Tokens & Badges', () => {
    it('GET /users/:id/profile includes tokenBalance and badges', async () => {
      // Use a known user ID or skip
      const res = await apiGet('/community/leaderboard');
      if (res.status !== 200 || !res.data?.length) return;

      const topUser = res.data[0];
      const profileRes = await apiGet(`/users/${topUser.userId}/profile`);
      assert.equal(profileRes.status, 200);
      assert.ok(typeof profileRes.data.tokenBalance === 'number', 'profile should have tokenBalance');
      assert.ok(Array.isArray(profileRes.data.badges), 'profile should have badges array');
    });
  });
});
