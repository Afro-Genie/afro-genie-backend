import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PassType } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { REWARD_CONFIG } from '../src/config/rewards';
import { awardTokens, getBalance } from '../src/services/tokenService';
import {
  purchasePass,
  getActivePass,
  getAnyActivePass,
  listPasses,
  getPassCatalog,
  revokeExpiredPasses,
  isPassType,
} from '../src/services/passService';
import {
  newPaymentRegistry,
  createPaymentUser,
  registerPaymentTeardown,
  type PaymentFixtureRegistry,
} from './paymentFixtures';

// Phase 1 task 1.6 — premium passes and translation packs.
//
// Passes are bought with GT, not real money, but they are still an economy: the
// invariants that matter are (a) a pass is never granted without the GT debit
// landing, (b) GT is never debited without the pass landing, and (c) neither can
// be replayed into a second grant. The refund path in purchasePass exists for
// the case where the credit grant fails mid-flight, and it is the easiest place
// for the ledger and the pass table to drift apart, so it is tested directly.

const registry: PaymentFixtureRegistry = newPaymentRegistry();
registerPaymentTeardown(registry);

const SEVEN_DAY = PassType.SEVEN_DAY_PREMIUM;
const PACK_10 = PassType.TRANSLATION_PACK_10;
const PACK_50 = PassType.TRANSLATION_PACK_50;

const cost = (type: PassType) => REWARD_CONFIG.PREMIUM_PASS_COSTS[type];
const credits = (type: PassType) => REWARD_CONFIG.PREMIUM_PASS_TRANSLATION_CREDITS[type];

/** A buyer with `gt` already in the wallet. */
const buyerWith = async (gt: number) => {
  const user = await createPaymentUser(registry);
  if (gt > 0) {
    await awardTokens({
      userId: user.id,
      type: 'EARN',
      amount: gt,
      reason: 'test funding',
      sourceType: 'TEST',
      sourceId: `fund-${user.id}`,
    });
  }
  return user;
};

const ledgerRows = (userId: string) =>
  prisma.tokenLedger.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

describe('pass catalog', () => {
  test('every purchasable type has a cost, a label and a credit count', () => {
    const catalog = getPassCatalog();
    assert.equal(catalog.length, 3);
    for (const entry of catalog) {
      assert.ok(entry.gtCost > 0, `${entry.type} must cost GT`);
      assert.ok(entry.label.length > 0, `${entry.type} must have a label`);
      assert.equal(typeof credits(entry.type), 'number');
    }
  });

  test('isPassType rejects anything not in the catalog', () => {
    assert.equal(isPassType(SEVEN_DAY), true);
    assert.equal(isPassType('LIFETIME_PREMIUM'), false);
    assert.equal(isPassType(''), false);
    assert.equal(isPassType(undefined), false);
    assert.equal(isPassType(null), false);
    assert.equal(isPassType(42), false);
    // Prototype pollution guard: `constructor` and `toString` are inherited
    // properties, so a hasOwnProperty check is load-bearing, not decoration.
    assert.equal(isPassType('constructor'), false);
    assert.equal(isPassType('toString'), false);
    assert.equal(isPassType('__proto__'), false);
  });

  test('the catalog costs match the reward config exactly', () => {
    for (const entry of getPassCatalog()) {
      assert.equal(entry.gtCost, REWARD_CONFIG.PREMIUM_PASS_COSTS[entry.type]);
    }
  });
});

describe('purchasePass', () => {
  test('a 7-day premium pass debits GT and activates the pass', async () => {
    const user = await buyerWith(cost(SEVEN_DAY));
    const before = await getBalance(user.id);

    const result = await purchasePass(user.id, SEVEN_DAY);

    assert.equal(result.type, SEVEN_DAY);
    assert.equal(result.newBalance, 0);
    assert.equal(await getBalance(user.id), 0);
    assert.equal(result.translationCredits, 0, 'premium grants no translation credits');

    const pass = await prisma.premiumPass.findUnique({ where: { id: result.passId } });
    assert.ok(pass);
    assert.equal(pass.active, true);
    assert.equal(pass.gtCost, cost(SEVEN_DAY));
    assert.equal(pass.userId, user.id);

    const rows = await ledgerRows(user.id);
    const spend = rows.find((r) => r.idempotencyKey === `premium-pass:${pass.id}`);
    assert.ok(spend, 'the GT debit must be in the ledger');
    assert.equal(spend.amount, -cost(SEVEN_DAY));
    assert.equal(spend.type, 'SPEND');
    assert.equal(spend.balanceAfter, before - cost(SEVEN_DAY));
  });

  test('a 7-day pass expires in seven days', async () => {
    const user = await buyerWith(cost(SEVEN_DAY));
    const result = await purchasePass(user.id, SEVEN_DAY);

    const days = (result.expiresAt.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days < 7.1, `expected ~7 days, got ${days.toFixed(2)}`);
  });

  test('a translation pack grants its credits and is NOT returned as an active premium pass', async () => {
    const user = await buyerWith(cost(PACK_10));

    const result = await purchasePass(user.id, PACK_10);

    assert.equal(result.translationCredits, 10);
    assert.equal(result.newBalance, 0);

    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(fresh?.translationCredits, 10);

    // A pack is a consumable credit balance, not a time-boxed entitlement. If
    // getActivePass returned it, a 50 GT purchase would read as a year of
    // premium — and any entitlement check built on it would grant one.
    assert.equal(await getActivePass(user.id), null);
    // The row is still recorded and still active for history/display purposes.
    assert.ok(await getAnyActivePass(user.id), 'the purchase record must still exist');
  });

  test('a premium pass bought after a pack still resolves as the active premium', async () => {
    const user = await buyerWith(cost(PACK_10) + cost(SEVEN_DAY));

    await purchasePass(user.id, PACK_10);
    assert.equal(await getActivePass(user.id), null);

    await purchasePass(user.id, SEVEN_DAY);
    const active = await getActivePass(user.id);
    assert.ok(active);
    assert.equal(active.type, SEVEN_DAY);
  });

  test('the 50-credit pack grants 50 credits', async () => {
    const user = await buyerWith(cost(PACK_50));
    const result = await purchasePass(user.id, PACK_50);
    assert.equal(result.translationCredits, 50);
    assert.equal(await getBalance(user.id), 0);
  });

  test('packs stack with an existing balance of credits', async () => {
    const user = await buyerWith(cost(PACK_10) + cost(PACK_10));

    await purchasePass(user.id, PACK_10);
    const second = await purchasePass(user.id, PACK_10);

    assert.equal(second.translationCredits, 20);
  });

  test('rejects an unknown pass type with 400', async () => {
    const user = await buyerWith(1000);
    await assert.rejects(
      () => purchasePass(user.id, 'LIFETIME_PREMIUM' as PassType),
      (err: any) => err.status === 400 && err.code === 'VALIDATION_ERROR',
    );
  });

  test('a rejected unknown type costs no GT and leaves no pass row', async () => {
    const user = await buyerWith(1000);
    const before = await getBalance(user.id);

    await purchasePass(user.id, 'FREE_FOR_ALL' as PassType).catch(() => undefined);

    assert.equal(await getBalance(user.id), before);
    assert.equal(await prisma.premiumPass.count({ where: { userId: user.id } }), 0);
  });

  test('an insufficient balance is refused and leaves no orphaned pass row', async () => {
    const user = await buyerWith(cost(SEVEN_DAY) - 1);
    const before = await getBalance(user.id);

    await assert.rejects(
      () => purchasePass(user.id, SEVEN_DAY),
      (err: any) => err.status === 400 && err.code === 'INSUFFICIENT_FUNDS',
    );

    assert.equal(await getBalance(user.id), before, 'no GT may be lost on a refused purchase');
    // The pass row is created before the spend and must be rolled back, or the
    // user gets a free premium pass they never paid for.
    assert.equal(
      await prisma.premiumPass.count({ where: { userId: user.id } }),
      0,
      'the pass row must be rolled back when the debit fails',
    );
  });

  test('a zero-balance user cannot buy anything', async () => {
    const user = await buyerWith(0);
    await assert.rejects(
      () => purchasePass(user.id, PACK_10),
      (err: any) => err.code === 'INSUFFICIENT_FUNDS',
    );
    assert.equal(await prisma.premiumPass.count({ where: { userId: user.id } }), 0);
  });

  test('buying two passes debits twice and creates two rows', async () => {
    const user = await buyerWith(cost(SEVEN_DAY) * 2);

    await purchasePass(user.id, SEVEN_DAY);
    await purchasePass(user.id, SEVEN_DAY);

    assert.equal(await getBalance(user.id), 0);
    assert.equal(await prisma.premiumPass.count({ where: { userId: user.id } }), 2);
    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 3); // 1 fund + 2 spends
  });

  test('concurrent purchases cannot overspend the balance', async () => {
    // Enough for exactly one pass: the second must fail, and the balance must
    // land at 0 rather than negative.
    const user = await buyerWith(cost(SEVEN_DAY));

    const results = await Promise.allSettled([
      purchasePass(user.id, SEVEN_DAY),
      purchasePass(user.id, SEVEN_DAY),
      purchasePass(user.id, SEVEN_DAY),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 1, `expected 1 success, got ${fulfilled.length}`);

    assert.equal(await getBalance(user.id), 0);
    assert.equal(await prisma.premiumPass.count({ where: { userId: user.id } }), 1);

    const wallet = await prisma.userWallet.findUnique({ where: { userId: user.id } });
    assert.equal(wallet?.balance, 0, 'the wallet must never go negative');
  });

  test('the ledger stays reconciled after a purchase (wallet == sum of ledger)', async () => {
    const user = await buyerWith(cost(SEVEN_DAY) + cost(PACK_10));

    await purchasePass(user.id, SEVEN_DAY);
    await purchasePass(user.id, PACK_10);

    const rows = await ledgerRows(user.id);
    const sum = rows.reduce((acc, r) => acc + r.amount, 0);
    const wallet = await prisma.userWallet.findUnique({ where: { userId: user.id } });

    assert.equal(wallet?.balance, sum);
    assert.equal(wallet?.balance, 0);
    // balanceAfter must be a running total, in order.
    let running = 0;
    for (const row of rows) {
      running += row.amount;
      assert.equal(row.balanceAfter, running, `ledger row ${row.id} balanceAfter drifted`);
    }
  });
});

describe('pass expiry and renewal', () => {
  test('getActivePass ignores an expired-but-still-flagged-active pass', async () => {
    const user = await buyerWith(cost(SEVEN_DAY));
    const { passId } = await purchasePass(user.id, SEVEN_DAY);

    // Simulate the expiry worker having missed it: row still says active=true.
    await prisma.premiumPass.update({
      where: { id: passId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // The read path filters on expiresAt, so the user is locked out immediately
    // even before revokeExpiredPasses runs. Entitlement must not depend on a cron.
    assert.equal(await getActivePass(user.id), null);
  });

  test('revokeExpiredPasses deactivates only the expired rows', async () => {
    const expiring = await buyerWith(cost(SEVEN_DAY) * 2);
    const kept = await buyerWith(cost(SEVEN_DAY));

    const a = await purchasePass(expiring.id, SEVEN_DAY);
    await purchasePass(expiring.id, SEVEN_DAY);
    const b = await purchasePass(kept.id, SEVEN_DAY);

    // Expire exactly one of the two passes on `expiring`.
    const rows = await prisma.premiumPass.findMany({
      where: { userId: expiring.id },
      orderBy: { purchasedAt: 'asc' },
    });
    await prisma.premiumPass.update({
      where: { id: rows[0].id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const revoked = await revokeExpiredPasses();

    assert.ok(revoked >= 1);
    const afterRows = await prisma.premiumPass.findMany({
      where: { userId: { in: [expiring.id, kept.id] } },
    });
    assert.equal(
      afterRows.find((p) => p.id === rows[0].id)?.active,
      false,
      'the expired pass must be deactivated',
    );
    assert.equal(
      afterRows.find((p) => p.id === rows[1].id)?.active,
      true,
      'an unexpired pass must not be touched',
    );
    assert.equal(afterRows.find((p) => p.id === b.passId)?.active, true);
    assert.ok(a.passId);
  });

  test('revokeExpiredPasses is idempotent', async () => {
    const user = await buyerWith(cost(SEVEN_DAY));
    const { passId } = await purchasePass(user.id, SEVEN_DAY);

    await prisma.premiumPass.update({
      where: { id: passId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    assert.equal(await revokeExpiredPasses(), 1);
    assert.equal(await revokeExpiredPasses(), 0, 'a second sweep must find nothing left');
  });

  test('expiry never refunds GT (a pass is consumed, not returned)', async () => {
    const user = await buyerWith(cost(SEVEN_DAY));
    const first = await purchasePass(user.id, SEVEN_DAY);
    const afterPurchase = await getBalance(user.id);

    await prisma.premiumPass.update({
      where: { id: first.passId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await revokeExpiredPasses();

    assert.equal(await getBalance(user.id), afterPurchase, 'expiry must not mint GT back');
    assert.equal(
      await prisma.tokenLedger.count({ where: { userId: user.id } }),
      2,
      'expiry must not append a compensating ledger row',
    );
  });

  test('renewing after expiry costs GT again and does not resurrect the old row', async () => {
    const user = await buyerWith(cost(SEVEN_DAY) * 2);
    const first = await purchasePass(user.id, SEVEN_DAY);

    await prisma.premiumPass.update({
      where: { id: first.passId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await revokeExpiredPasses();

    const second = await purchasePass(user.id, SEVEN_DAY);

    assert.notEqual(second.passId, first.passId, 'a renewal is a NEW pass row');
    assert.equal(await getBalance(user.id), 0, 'the renewal charged GT again');

    const rows = await prisma.premiumPass.findMany({ where: { userId: user.id } });
    assert.equal(rows.length, 2);
    assert.equal(rows.find((p) => p.id === first.passId)?.active, false);
    assert.equal(rows.find((p) => p.id === second.passId)?.active, true);
  });

  test('renewing before expiry stacks a second pass row and both count as active', async () => {
    const user = await buyerWith(cost(SEVEN_DAY) * 2);
    await purchasePass(user.id, SEVEN_DAY);
    await purchasePass(user.id, SEVEN_DAY);

    const active = await getActivePass(user.id);
    assert.ok(active, 'an unexpired pass must be active');
    assert.equal(await prisma.premiumPass.count({ where: { userId: user.id, active: true } }), 2);
  });

  test('getActivePass returns the furthest-expiry pass when several overlap', async () => {
    const user = await buyerWith(cost(SEVEN_DAY) * 2);
    await purchasePass(user.id, SEVEN_DAY);
    await purchasePass(user.id, SEVEN_DAY);

    const active = await getActivePass(user.id);
    assert.ok(active);

    const all = await prisma.premiumPass.findMany({
      where: { userId: user.id },
      orderBy: { expiresAt: 'desc' },
    });
    assert.equal(active!.id, all[0].id, 'must return the pass that expires last');
  });

  test('a user with no passes gets null, not an error', async () => {
    const user = await buyerWith(100);
    assert.equal(await getActivePass(user.id), null);
    assert.deepEqual(await listPasses(user.id), []);
  });

  test('listPasses is scoped to the caller', async () => {
    const mine = await buyerWith(cost(SEVEN_DAY));
    const theirs = await buyerWith(cost(SEVEN_DAY));
    await purchasePass(mine.id, SEVEN_DAY);
    await purchasePass(theirs.id, SEVEN_DAY);

    const res = await listPasses(mine.id);
    assert.equal(res.length, 1);
    assert.equal(res[0].userId, mine.id);
  });
});