import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { awardTokens } from '../src/services/tokenService';
import { getBalance } from '../src/services/tokenService';
import { purchase, getItems, getOwnedEntitlements, fulfillPurchase } from '../src/services/storeService';
import { ApiError } from '../src/middleware/errorHandler';
import { createUser, cleanupUser, uid } from './helpers';

describe('storeService', () => {
  let user: Awaited<ReturnType<typeof createUser>>;
  let itemId: string;
  let purchaseId: string;
  let purchaseToken: string;

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
    await prisma.storePurchase.deleteMany({ where: { id: purchaseId } });
    await prisma.storeItem.deleteMany({ where: { id: itemId } });
    await cleanupUser(user.id);
  });

  test('getItems marks owned entitlement types', async () => {
    const items = await getItems(user.id);
    const mine = items.find((i) => i.id === itemId);
    assert.ok(mine);
    assert.equal(mine.owned, false);
    assert.equal(mine.tokenCost, 30);
  });

  test('purchase debits balance and grants the digital entitlement atomically', async () => {
    const before = await getBalance(user.id);
    purchaseToken = `r3-token-${uid()}`;
    const result = await purchase(itemId, user.id, purchaseToken);
    purchaseId = result.id;
    assert.equal(result.spentAmount, 30);
    assert.equal(await getBalance(user.id), before - 30);

    const owned = await getOwnedEntitlements(user.id);
    assert.ok(owned.some((e: any) => e.type === 'TRANSLATION_PASS'));
  });

  test('replaying the same purchaseToken returns the same purchase (no double charge)', async () => {
    const before = await getBalance(user.id);
    const again = await purchase(itemId, user.id, purchaseToken);
    assert.equal(again.id, purchaseId);
    assert.equal(await getBalance(user.id), before);
  });

  test('purchase rejects when balance is insufficient', async () => {
    const broke = await createUser();
    try {
      await assert.rejects(
        purchase(itemId, broke.id, `r3-broke-${uid()}`),
        (err: unknown) => err instanceof ApiError && err.code === 'INSUFFICIENT_FUNDS',
      );
    } finally {
      await cleanupUser(broke.id);
    }
  });

  test('purchase rejects unknown or inactive items', async () => {
    await assert.rejects(
      purchase('does-not-exist', user.id, `r3-missing-${uid()}`),
      (err: unknown) => err instanceof ApiError && err.code === 'NOT_FOUND',
    );
  });

  test('fulfillPurchase flips status to fulfilled', async () => {
    const fulfilled = await fulfillPurchase(purchaseId);
    assert.equal(fulfilled.status, 'FULFILLED');
  });
});
