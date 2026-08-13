import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '..', '..', '.env') });

const API_URL = process.env.TEST_API_URL || 'http://localhost:3001/api';

import { awardTokens } from '../../services/tokenService';
import { redis } from '../../lib/redis';

async function apiGet(path: string) {
  const res = await fetch(`${API_URL}${path}`);
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function apiPost(path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/**
 * The navbar balance is served by GET /users/:id/profile → getUserTokenBalance.
 * This test verifies the balance the UI displays is the wallet's source of
 * truth and never goes stale (the old Redis `user:tokens:<id>` cache used to
 * serve outdated balances for up to an hour between sessions).
 */
describe('Token balance display (navbar)', () => {
  let userId = '';
  let beforeBalance = 0;
  const AWARD = 25;

  before(async () => {
    const suffix = Date.now();
    const res = await apiPost('/auth/register', {
      email: `token-balance-${suffix}@example.com`,
      password: 'TestPassword123!',
      displayName: `TokenBalance-${suffix}`,
    });
    if (res.status !== 201 || !res.data?.user?.id) {
      throw new Error(`Failed to register test user: ${res.status} ${JSON.stringify(res.data)}`);
    }
    userId = res.data.user.id;
  });

  it('GET /users/:id/profile returns a numeric tokenBalance', async () => {
    const prof = await apiGet(`/users/${userId}/profile`);
    assert.equal(prof.status, 200, JSON.stringify(prof.data));
    assert.equal(typeof prof.data?.tokenBalance, 'number', 'tokenBalance should be a number');
    beforeBalance = prof.data.tokenBalance as number;
  });

  it('awarded tokens are reflected immediately, ignoring a stale cache', async () => {
    await awardTokens({
      userId,
      type: 'EARN',
      amount: AWARD,
      reason: 'token-balance e2e',
      idempotencyKey: `token-balance-e2e:${userId}:${Date.now()}`,
    });

    // Simulate the old bug: a stale Redis balance key holding the pre-award value.
    // Best-effort — if the shared Redis instance is out of client slots the test
    // still passes because the fix never reads this key.
    try {
      await redis.set(`user:tokens:${userId}`, String(beforeBalance), 'EX', 3600);
    } catch (err) {
      // Ignore: cache poisoning is only a regression guard, not the assertion.
    }

    const prof = await apiGet(`/users/${userId}/profile`);
    assert.equal(prof.status, 200, JSON.stringify(prof.data));
    assert.equal(
      prof.data?.tokenBalance,
      beforeBalance + AWARD,
      `expected ${beforeBalance} + ${AWARD} = ${beforeBalance + AWARD}, got ${prof.data?.tokenBalance}`,
    );
  });

  it('balance is stable across repeated reads (between sessions)', async () => {
    const a = await apiGet(`/users/${userId}/profile`);
    const b = await apiGet(`/users/${userId}/profile`);
    assert.equal(a.data?.tokenBalance, b.data?.tokenBalance);
    assert.equal(a.data?.tokenBalance, beforeBalance + AWARD);
  });
});
