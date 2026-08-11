import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { recordLogin } from '../src/services/streakService';
import { getBalance } from '../src/services/tokenService';
import { REWARD_CONFIG } from '../src/config/rewards';
import { createUser, cleanupUser, uid } from './helpers';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('streakService', () => {
  let userId: string;

  before(async () => {
    userId = (await createUser()).id;
  });

  after(async () => {
    await cleanupUser(userId);
  });

  const streakRow = () => prisma.userStreak.findUnique({ where: { userId } });
  const loginCount = async (reason: string) =>
    prisma.tokenLedger.count({ where: { userId, reason: { contains: reason } } });

  test('first login creates a streak of 1 and awards the daily base', async () => {
    await recordLogin(userId);
    const streak = await streakRow();
    assert.equal(streak?.currentStreak, 1);
    assert.equal(streak?.longestStreak, 1);
    assert.equal(await loginCount('Daily login'), 1);
  });

  test('same-day login is a no-op (no bonus, no extra award)', async () => {
    const before = await getBalance(userId);
    await recordLogin(userId);
    await recordLogin(userId);
    assert.equal(await getBalance(userId), before);
    assert.equal(await loginCount('Daily login'), 1);
    assert.equal((await streakRow())?.currentStreak, 1);
  });

  test('consecutive-day login increments streak and pays the bonus', async () => {
    await prisma.userStreak.update({
      where: { userId },
      data: { lastLoginDate: new Date(Date.now() - DAY_MS) },
    });
    await recordLogin(userId);
    const streak = await streakRow();
    assert.equal(streak?.currentStreak, 2);
    assert.equal(streak?.longestStreak, 2);
    assert.equal(await loginCount('streak bonus'), 1);
  });

  test('gap resets the streak to 1', async () => {
    await prisma.userStreak.update({
      where: { userId },
      data: { lastLoginDate: new Date(Date.now() - 3 * DAY_MS) },
    });
    await recordLogin(userId);
    const streak = await streakRow();
    assert.equal(streak?.currentStreak, 1);
    assert.equal(streak?.longestStreak, 2);
  });

  test('ledger award is keyed by calendar day (replay-safe)', async () => {
    const daily = await prisma.tokenLedger.findMany({
      where: { userId, reason: { contains: 'Daily login' } },
    });
    const keys = daily.map((r) => r.idempotencyKey);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.length >= 1);
  });
});
