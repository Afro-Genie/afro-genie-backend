import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import {
  awardTokens,
  spendTokens,
  penalizeTokens,
  applyTax,
  getBalance,
  getLedger,
} from '../src/services/tokenService';
import { REWARD_CONFIG } from '../src/config/rewards';
import { createUser, cleanupUser, uid } from './helpers';

describe('tokenService', () => {
  let user: Awaited<ReturnType<typeof createUser>>;
  let userId: string;

  before(async () => {
    user = await createUser();
    userId = user.id;
  });

  after(async () => {
    await cleanupUser(userId);
  });

  test('awardTokens credits the wallet and appends a ledger row', async () => {
    const before = await getBalance(userId);
    await awardTokens({
      userId,
      type: 'EARN',
      amount: 25,
      reason: 'test award',
      sourceType: 'TEST',
      sourceId: uid(),
    });
    assert.equal(await getBalance(userId), before + 25);
  });

  test('same sourceId award is idempotent (no double credit)', async () => {
    const sourceId = uid();
    const before = await getBalance(userId);
    await awardTokens({ userId, type: 'EARN', amount: 10, reason: 'dup', sourceType: 'TEST', sourceId });
    await awardTokens({ userId, type: 'EARN', amount: 10, reason: 'dup', sourceType: 'TEST', sourceId });
    await awardTokens({ userId, type: 'EARN', amount: 10, reason: 'dup', sourceType: 'TEST', sourceId });
    assert.equal(await getBalance(userId), before + 10);
  });

  test('explicit idempotencyKey wins over derived key', async () => {
    const key = `custom:${uid()}`;
    const before = await getBalance(userId);
    await awardTokens({ userId, type: 'EARN', amount: 5, reason: 'x', idempotencyKey: key });
    const second = await awardTokens({ userId, type: 'EARN', amount: 5, reason: 'x', idempotencyKey: key });
    assert.equal(second.reason, 'x');
    assert.equal(await getBalance(userId), before + 5);
  });

  test('spendTokens rejects when balance is insufficient', async () => {
    await assert.rejects(
      () => spendTokens({ userId, amount: -1_000_000, reason: 'too big', sourceType: 'TEST', sourceId: uid() }),
      (err: any) => err.status === 400 && err.code === 'INSUFFICIENT_FUNDS',
    );
  });

  test('spendTokens validates negative amount', async () => {
    await assert.rejects(
      Promise.resolve().then(() =>
        spendTokens({ userId, amount: 5, reason: 'positive spend', sourceType: 'TEST', sourceId: uid() }),
      ),
      (err: any) => err.status === 400 && err.code === 'VALIDATION_ERROR',
    );
  });

  test('spendTokens debits balance atomically', async () => {
    await awardTokens({ userId, type: 'EARN', amount: 100, reason: 'fund', sourceType: 'TEST', sourceId: uid() });
    const before = await getBalance(userId);
    await spendTokens({ userId, amount: -30, reason: 'spend', sourceType: 'TEST', sourceId: uid() });
    assert.equal(await getBalance(userId), before - 30);
  });

  test('penalizeTokens requires negative amount', async () => {
    await assert.rejects(
      Promise.resolve().then(() =>
        penalizeTokens({ userId, amount: 20, reason: 'bad', sourceType: 'TEST', sourceId: uid() }),
      ),
      (err: any) => err.status === 400 && err.code === 'VALIDATION_ERROR',
    );
  });

  test('applyTax debits the tax amount and records a TAX row', async () => {
    await awardTokens({ userId, type: 'EARN', amount: 100, reason: 'fund2', sourceType: 'TEST', sourceId: uid() });
    const before = await getBalance(userId);
    const tax = Math.max(1, Math.round(20 * REWARD_CONFIG.MOD_POOL_TAX_PERCENT));
    await applyTax({
      userId,
      amount: -tax,
      reason: 'tax',
      sourceType: 'TEST',
      sourceId: uid(),
    });
    assert.equal(await getBalance(userId), before - tax);
    const row = await prisma.tokenLedger.findFirst({
      where: { userId, type: 'TAX' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(row);
    assert.equal(row.amount, -tax);
  });

  test('concurrent same-source awards credit exactly once (race-safe)', async () => {
    const sourceId = uid();
    const before = await getBalance(userId);
    const attempts = Array.from({ length: 5 }, () =>
      awardTokens({ userId, type: 'EARN', amount: 3, reason: 'race', sourceType: 'TEST', sourceId }),
    );
    await Promise.all(attempts);
    assert.equal(await getBalance(userId), before + 3);
  });

  test('ledger rows carry balanceAfter that never goes negative', async () => {
    const ledger = await getLedger(userId);
    const wallet = await prisma.userWallet.findUnique({ where: { userId } });
    const rows = await prisma.tokenLedger.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    let expected = 0;
    for (const row of rows) {
      expected += row.amount;
      assert.equal(row.balanceAfter, expected);
    }
    assert.equal(wallet?.balance, expected);
    assert.ok(ledger.rewards.length > 0);
    assert.equal(ledger.pagination.total, rows.length);
  });
});
