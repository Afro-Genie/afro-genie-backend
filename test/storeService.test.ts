import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { awardTokens, getBalance } from '../src/services/tokenService';
import { getStoreItems, purchaseItem, getUserPurchases, fulfillPurchase } from '../src/services/storeService';
import { createUser, cleanupUser, uid } from './helpers';

describe('storeService', () => {
  let user: Awaited<ReturnType<typeof createUser>>;
  let itemId: string;
  let purchaseId: string;

  before(async () => {
    user = await createUser();
    itemId = (
      await prisma.storeItem.create({
        data: {
          name: `R3 Digital Pass ${uid()}`,
          tokenCost: 30,
          category: 'DIGITAL',
          metadata: { digital: true, entitlementType: 'TRANSLATION_PASS' },
        },
      })
    ).id;
    await awardTokens({ userId: user.id, type: 'EARN', amount: 200, reason: 'store fund', sourceType: 'TEST', sourceId: uid() });
  });

  after(async () => {
    if (purchaseId) {
      await prisma.storePurchase.deleteMany({ where: { id: purchaseId } });
    }
    await prisma.storeItem.deleteMany({ where: { id: itemId } });
    await cleanupUser(user.id);
  });

  test('getStoreItems lists the active item with its token cost', async () => {
    const items = await getStoreItems();
    const mine = items.find((i) => i.id === itemId);
    assert.ok(mine);
    assert.equal(mine.tokenCost, 30);
    assert.equal(mine.active, true);
  });

  test('purchaseItem debits balance and records the purchase atomically', async () => {
    const before = await getBalance(user.id);
    const result = await purchaseItem(user.id, itemId);
    assert.equal(result.success, true);
    assert.equal(await getBalance(user.id), before - 30);

    const purchases = await getUserPurchases(user.id);
    const mine = purchases.find((p) => p.item.id === itemId);
    assert.ok(mine);
    purchaseId = mine.id;
    assert.equal(mine.spentAmount, 30);

    const ledger = await prisma.tokenLedger.findFirst({
      where: { userId: user.id, type: 'SPEND', sourceId: null },
      orderBy: { createdAt: 'desc' },
      select: { reason: true, amount: true, balanceAfter: true },
    });
    assert.ok(ledger);
    assert.equal(ledger.amount, -30);
    assert.equal(ledger.balanceAfter, before - 30);
    assert.match(ledger.reason, /Store purchase/);
  });

  test('purchaseItem is idempotent per user+item (no double charge)', async () => {
    const before = await getBalance(user.id);
    const again = await purchaseItem(user.id, itemId);
    assert.equal(again.success, false);
    assert.match(again.message, /already own/);
    assert.equal(await getBalance(user.id), before);
  });

  test('purchaseItem rejects when balance is insufficient', async () => {
    const broke = await createUser();
    try {
      const result = await purchaseItem(broke.id, itemId);
      assert.equal(result.success, false);
      assert.match(result.message, /Insufficient/i);
    } finally {
      await cleanupUser(broke.id);
    }
  });

  test('purchaseItem rejects unknown or inactive items', async () => {
    const result = await purchaseItem(user.id, 'does-not-exist');
    assert.equal(result.success, false);
  });

  test('fulfillPurchase flips status to fulfilled', async () => {
    const fulfilled = await fulfillPurchase(purchaseId);
    assert.equal(fulfilled.status, 'FULFILLED');
    assert.ok(fulfilled.fulfilledAt);
  });
});