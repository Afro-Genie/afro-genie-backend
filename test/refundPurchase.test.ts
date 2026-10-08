import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';
import { env } from '../src/lib/env';
import { awardTokens, getBalance, getLedgerSummary } from '../src/services/tokenService';
import {
  purchaseItem,
  fulfillPurchase,
  refundPurchase,
  getUserEntitlements,
  getUserPurchases,
} from '../src/services/storeService';
import { adminStoreRouter } from '../src/routes/admin/store';
import { errorHandler } from '../src/middleware/errorHandler';
import { createUser, cleanupUser, uid } from './helpers';

const COST = 40;

const tokenFor = (user: { id: string; email: string }, role: 'USER' | 'ADMIN' = 'USER'): string =>
  jwt.sign({ userId: user.id, email: user.email, role }, env.JWT_SECRET, { expiresIn: '10m' });

describe('refundPurchase (store reversal)', () => {
  let buyer: Awaited<ReturnType<typeof createUser>>;
  let rival: Awaited<ReturnType<typeof createUser>>;
  let pendingBuyer: Awaited<ReturnType<typeof createUser>>;
  let itemId: string;
  let pendingItemId: string;
  let purchaseId: string;
  let rivalPurchaseId: string;
  let pendingPurchaseId: string;
  const buyerIds: string[] = [];

  const findPurchase = async (id: string) => prisma.storePurchase.findUnique({ where: { id } });

  before(async () => {
    buyer = await createUser();
    rival = await createUser();
    pendingBuyer = await createUser();
    buyerIds.push(buyer.id, rival.id, pendingBuyer.id);

    itemId = (
      await prisma.storeItem.create({
        data: {
          name: `Refund Border ${uid()}`,
          tokenCost: COST,
          category: 'avatar',
          stock: 3,
          metadata: { digital: true, entitlementType: 'avatar:border:refund-test' },
        },
      })
    ).id;
    pendingItemId = (
      await prisma.storeItem.create({
        data: {
          name: `Refund Pending ${uid()}`,
          tokenCost: COST,
          category: 'avatar',
          metadata: { digital: true, entitlementType: 'avatar:border:pending-test' },
        },
      })
    ).id;

    for (const u of [buyer, rival, pendingBuyer]) {
      await awardTokens({ userId: u.id, type: 'EARN', amount: 200, reason: 'refund test fund', sourceType: 'TEST', sourceId: uid() });
    }
  });

  after(async () => {
    await prisma.modActionLog.deleteMany({ where: { targetId: { in: buyerIds } } });
    await prisma.storePurchase.deleteMany({ where: { itemId: { in: [itemId, pendingItemId] } } });
    await prisma.storeItem.deleteMany({ where: { id: { in: [itemId, pendingItemId] } } });
    for (const id of [buyer.id, rival.id, pendingBuyer.id]) {
      await cleanupUser(id);
    }
  });

  test('purchase + fulfillment set up the state a refund must reverse', async () => {
    const result = await purchaseItem(buyer.id, itemId);
    assert.equal(result.success, true);

    const purchases = await getUserPurchases(buyer.id);
    const mine = purchases.find((p) => p.item.id === itemId);
    assert.ok(mine);
    purchaseId = mine.id;

    await fulfillPurchase(purchaseId);

    const entitlements = await getUserEntitlements(buyer.id);
    assert.ok(entitlements.find((e) => e.type === 'avatar:border:refund-test'), 'entitlement granted on fulfill');

    const item = await prisma.storeItem.findUnique({ where: { id: itemId }, select: { stock: true } });
    assert.equal(item?.stock, 2, 'stock was decremented on purchase');
    assert.equal(await getBalance(buyer.id), 200 - COST);
  });

  test('refundPurchase credits GT back, flips status and removes the reward', async () => {
    const before = await getBalance(buyer.id);
    const stockBefore = (await prisma.storeItem.findUnique({ where: { id: itemId }, select: { stock: true } }))!.stock;

    const result = await refundPurchase(purchaseId, 'user reported issue');
    assert.equal(result.purchase.status, 'REFUNDED');
    assert.ok(result.purchase.refundedAt, 'refundedAt is stamped');
    assert.equal(result.refund.amount, COST);
    assert.equal(result.refund.idempotencyKey, `store-refund:${purchaseId}`);

    assert.equal(await getBalance(buyer.id), before + COST, 'GT returned');

    const purchase = await findPurchase(purchaseId);
    assert.equal(purchase?.status, 'REFUNDED');

    const ledger = await prisma.tokenLedger.findUnique({
      where: { idempotencyKey: `store-refund:${purchaseId}` },
    });
    assert.ok(ledger, 'one REFUND ledger row with the deterministic key');
    assert.equal(ledger.type, 'REFUND');
    assert.equal(ledger.amount, COST);
    assert.equal(ledger.sourceType, 'STORE_REFUND');
    assert.equal(ledger.sourceId, purchaseId);

    const entitlements = await getUserEntitlements(buyer.id);
    assert.ok(
      !entitlements.find((e) => e.type === 'avatar:border:refund-test'),
      'entitlement is revoked by the refund',
    );

    const item = await prisma.storeItem.findUnique({ where: { id: itemId }, select: { stock: true } });
    assert.equal(item?.stock, stockBefore! + 1, 'stock restored');

    const notifications = await prisma.notification.count({
      where: { userId: buyer.id, type: 'STORE', title: 'Purchase refunded' },
    });
    assert.equal(notifications, 1, 'buyer is notified exactly once');

    const summary = await getLedgerSummary(buyer.id);
    assert.equal(summary.refunded, COST, 'summary exposes the refunded bucket');
  });

  test('refunding twice is rejected with CONFLICT and moves nothing', async () => {
    const balance = await getBalance(buyer.id);
    const stock = (await prisma.storeItem.findUnique({ where: { id: itemId }, select: { stock: true } }))!.stock;

    await assert.rejects(
      () => refundPurchase(purchaseId),
      (err: unknown) => {
        const e = err as { status?: number; code?: string };
        assert.equal(e.status, 409);
        assert.equal(e.code, 'CONFLICT');
        return true;
      },
    );

    assert.equal(await getBalance(buyer.id), balance, 'no second credit');
    const item = await prisma.storeItem.findUnique({ where: { id: itemId }, select: { stock: true } });
    assert.equal(item?.stock, stock, 'no double stock restore');
    const ledgerRows = await prisma.tokenLedger.count({
      where: { sourceType: 'STORE_REFUND', sourceId: purchaseId },
    });
    assert.equal(ledgerRows, 1, 'exactly one refund ledger row');
  });

  test('concurrent refunds credit exactly once', async () => {
    assert.equal((await purchaseItem(rival.id, itemId)).success, true);
    const purchases = await getUserPurchases(rival.id);
    const mine = purchases.find((p) => p.item.id === itemId);
    assert.ok(mine);
    rivalPurchaseId = mine.id;

    const before = await getBalance(rival.id);
    const stockBefore = (await prisma.storeItem.findUnique({ where: { id: itemId }, select: { stock: true } }))!.stock;

    const results = await Promise.allSettled([
      refundPurchase(rivalPurchaseId),
      refundPurchase(rivalPurchaseId),
      refundPurchase(rivalPurchaseId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.ok(fulfilled.length >= 1, 'at least one refund succeeds');

    assert.equal(await getBalance(rival.id), before + COST, 'balance credited exactly once');
    const item = await prisma.storeItem.findUnique({ where: { id: itemId }, select: { stock: true } });
    assert.equal(item?.stock, stockBefore! + 1, 'stock restored exactly once');
    const ledgerRows = await prisma.tokenLedger.count({
      where: { sourceType: 'STORE_REFUND', sourceId: rivalPurchaseId },
    });
    assert.equal(ledgerRows, 1, 'idempotencyKey collapses the race to one ledger row');
  });

  test('a pending (never fulfilled) purchase can also be refunded', async () => {
    assert.equal((await purchaseItem(pendingBuyer.id, pendingItemId)).success, true);
    const purchases = await getUserPurchases(pendingBuyer.id);
    const mine = purchases.find((p) => p.item.id === pendingItemId);
    assert.ok(mine);
    pendingPurchaseId = mine.id;

    const before = await getBalance(pendingBuyer.id);
    const result = await refundPurchase(pendingPurchaseId);

    assert.equal(result.purchase.status, 'REFUNDED');
    assert.equal(await getBalance(pendingBuyer.id), before + COST);
    const entitlements = await getUserEntitlements(pendingBuyer.id);
    assert.ok(
      !entitlements.find((e) => e.type === 'avatar:border:pending-test'),
      'no entitlement exists and none is created',
    );
  });

  test('unknown purchases are rejected with NOT_FOUND', async () => {
    await assert.rejects(
      () => refundPurchase('does-not-exist'),
      (err: unknown) => {
        const e = err as { status?: number; code?: string };
        assert.equal(e.status, 404);
        assert.equal(e.code, 'NOT_FOUND');
        return true;
      },
    );
  });
});

describe('POST /api/admin/store/purchases/:id/refund', () => {
  let buyer: Awaited<ReturnType<typeof createUser>>;
  let plainUser: Awaited<ReturnType<typeof createUser>>;
  let admin: Awaited<ReturnType<typeof createUser>>;
  let itemId: string;
  let purchaseId: string;
  let server: Server;
  let baseUrl: string;

  const buyerIds: string[] = [];

  const request = async (
    path: string,
    opts: { method?: string; token?: string; body?: unknown } = {},
  ) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  before(async () => {
    buyer = await createUser();
    plainUser = await createUser();
    admin = await createUser({ role: 'ADMIN' });
    buyerIds.push(buyer.id, plainUser.id, admin.id);

    itemId = (
      await prisma.storeItem.create({
        data: {
          name: `Route Refund ${uid()}`,
          tokenCost: COST,
          category: 'avatar',
          metadata: { digital: true, entitlementType: 'avatar:border:route-test' },
        },
      })
    ).id;

    await awardTokens({ userId: buyer.id, type: 'EARN', amount: 200, reason: 'route refund fund', sourceType: 'TEST', sourceId: uid() });
    assert.equal((await purchaseItem(buyer.id, itemId)).success, true);
    const purchases = await getUserPurchases(buyer.id);
    const mine = purchases.find((p) => p.item.id === itemId);
    assert.ok(mine);
    purchaseId = mine.id;
    await fulfillPurchase(purchaseId);

    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminStoreRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (typeof address === 'object' && address) baseUrl = `http://127.0.0.1:${address.port}/api/admin`;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.modActionLog.deleteMany({ where: { targetId: { in: buyerIds } } });
    await prisma.storePurchase.deleteMany({ where: { itemId } });
    await prisma.storeItem.deleteMany({ where: { id: itemId } });
    for (const id of buyerIds) await cleanupUser(id);
  });

  test('rejects unauthenticated requests with 401', async () => {
    const res = await request(`/store/purchases/${purchaseId}/refund`, { method: 'PATCH' });
    assert.equal(res.status, 401);
  });

  test('rejects non-admin callers with 403', async () => {
    const res = await request(`/store/purchases/${purchaseId}/refund`, {
      method: 'PATCH',
      token: tokenFor(plainUser),
      body: {},
    });
    assert.equal(res.status, 403);
  });

  test('admin refund returns the reversal and audits it', async () => {
    const before = await getBalance(buyer.id);
    const res = await request(`/store/purchases/${purchaseId}/refund`, {
      method: 'PATCH',
      token: tokenFor(admin, 'ADMIN'),
      body: { reason: 'chargeback settled' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.purchase.status, 'REFUNDED');
    assert.equal(res.body.refund.amount, COST);
    assert.equal(await getBalance(buyer.id), before + COST);

    const audit = await prisma.modActionLog.findFirst({
      where: { actionType: 'STORE_REFUND', targetId: buyer.id },
    });
    assert.ok(audit, 'refund is written to the moderation audit log');
    assert.equal(audit?.moderatorId, admin.id);
    const details = JSON.parse(audit!.details!);
    assert.equal(details.purchaseId, purchaseId);
    assert.equal(details.amount, COST);
    assert.equal(details.reason, 'chargeback settled');
  });

  test('a second refund attempt returns 409 CONFLICT', async () => {
    const res = await request(`/store/purchases/${purchaseId}/refund`, {
      method: 'PATCH',
      token: tokenFor(admin, 'ADMIN'),
      body: {},
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'CONFLICT');
  });

  test('unknown purchase ids return 404', async () => {
    const res = await request('/store/purchases/nope/refund', {
      method: 'PATCH',
      token: tokenFor(admin, 'ADMIN'),
      body: {},
    });
    assert.equal(res.status, 404);
  });
});
