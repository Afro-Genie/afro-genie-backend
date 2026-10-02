import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { logger } from '../src/lib/logger';
import {
  newPaymentRegistry,
  createPaymentUser,
  createPaymentBundle,
  stubPaystack,
  registerPaymentTeardown,
  type PaymentFixtureRegistry,
  type PaystackStub,
} from './paymentFixtures';
import { initializePayment } from '../src/services/paymentService';
import { recoverStuckPurchases } from '../src/jobs/reconciliationJob';

// Task 1.10 — the paid-but-uncredited recovery sweep.
//
// routes/payments.ts answers the webhook with 200 *before* it credits anything,
// deliberately, so a slow Paystack verify can't provoke a retry storm. The cost of
// that choice is that a process death between the ack and the credit is invisible:
// Paystack has been told "delivered" and will not send it again, the row sits at
// PENDING/PROCESSING forever, and the customer has paid for GT they never got.
// Ledger idempotency does not help, because nothing ever comes back to retry.
//
// So the sweep comes back for it. These tests pin the four properties that make
// the sweep safe to run unattended on a real money path.

const registry: PaymentFixtureRegistry = newPaymentRegistry();
registerPaymentTeardown(registry);

let stub: PaystackStub;
const verifyOk = (amount: number) => ({
  body: {
    status: 'success',
    amount,
    currency: 'NGN',
    paid_at: new Date().toISOString(),
  },
});

/** A PROCESSING purchase of a 100 GT / ₦2,000 bundle. */
const checkout = async () => {
  const user = await createPaymentUser(registry);
  const bundle = await createPaymentBundle(registry, { gtAmount: 100, priceKobo: 200_000 });
  stub.enqueueInitialize({
    body: { authorization_url: 'https://checkout.test/x', access_code: 'acc' },
  });
  const init = await initializePayment(user.id, bundle.id);
  return { user, bundle, reference: init.reference };
};

/** Backdate a purchase so it falls outside the sweep's age floor. */
const ageBy = async (id: string, ms: number) => {
  await prisma.gtPurchase.update({
    where: { id },
    data: { createdAt: new Date(Date.now() - ms) },
  });
};

const HOUR = 60 * 60 * 1000;

const balanceOf = async (userId: string) =>
  (await prisma.userWallet.findUnique({ where: { userId } }))?.balance ?? 0;

const ledgerCountFor = async (userId: string) =>
  prisma.tokenLedger.count({ where: { userId } });

const statusOf = async (id: string) =>
  (await prisma.gtPurchase.findUnique({ where: { id } }))?.status;

describe('recoverStuckPurchases', () => {
  beforeEach(() => {
    stub = stubPaystack();
  });

  afterEach(() => {
    stub.restore();
  });

  test('credits a paid purchase that was left behind at PROCESSING', async () => {
    const { user, reference } = await checkout();
    await ageBy(reference, 30 * 60 * 1000);
    stub.enqueueVerify(verifyOk(200_000));

    const result = await recoverStuckPurchases();

    assert.equal(result.recovered, 1);
    assert.equal(await balanceOf(user.id), 100);
    assert.equal(await ledgerCountFor(user.id), 1);
    const purchase = await prisma.gtPurchase.findUnique({ where: { id: reference } });
    assert.equal(purchase?.status, 'COMPLETED');
    assert.ok(purchase?.creditedAt);
  });

  test('leaves a recent purchase alone (never races a checkout in progress)', async () => {
    const { user, reference } = await checkout();
    // No verify response is queued. If the sweep touched a fresh purchase the
    // stub would throw "no queued response" and fail the test — which is the
    // point: the age floor must keep it away from live checkouts.
    const result = await recoverStuckPurchases();

    assert.equal(result.recovered, 0);
    assert.equal(result.stillUnpaid, 0);
    assert.equal(await balanceOf(user.id), 0);
    const purchase = await prisma.gtPurchase.findUnique({ where: { id: reference } });
    assert.equal(purchase?.status, 'PROCESSING');
  });

  test('never re-credits a purchase that is already COMPLETED', async () => {
    const { user, reference } = await checkout();
    await ageBy(reference, 30 * 60 * 1000);
    stub.enqueueVerify(verifyOk(200_000));
    const first = await recoverStuckPurchases();
    assert.equal(first.recovered, 1);
    assert.equal(await balanceOf(user.id), 100);

    // Completed rows are outside the PENDING/PROCESSING filter entirely, so the
    // second sweep must not touch Paystack or the ledger. No verify response is
    // queued, so a provider call here would throw and fail the test.
    const second = await recoverStuckPurchases();

    assert.equal(second.recovered, 0);
    assert.equal(await ledgerCountFor(user.id), 1);
    assert.equal(await balanceOf(user.id), 100);
    assert.equal(stub.calls.filter((c) => c.path.includes('/verify/')).length, 1);
  });

  test('is idempotent: two sweeps credit the purchase exactly once', async () => {
    const { user, reference } = await checkout();
    await ageBy(reference, 30 * 60 * 1000);
    stub.enqueueVerify(verifyOk(200_000));
    // Deliberately over-queue. The second verify must never be consumed, because
    // the row is COMPLETED and therefore not selected for a second pass.
    stub.enqueueVerify(verifyOk(200_000));

    await recoverStuckPurchases();
    const second = await recoverStuckPurchases();

    assert.equal(second.recovered, 0);
    assert.equal(await ledgerCountFor(user.id), 1);
    assert.equal(await balanceOf(user.id), 100);
  });

  test('an unpaid stale purchase is counted as still unpaid, not credited', async () => {
    const { user, reference } = await checkout();
    await ageBy(reference, 30 * 60 * 1000);
    stub.enqueueVerify({ body: { status: 'failed', amount: 200_000, reference } });

    const result = await recoverStuckPurchases();

    assert.equal(result.recovered, 0);
    assert.equal(result.stillUnpaid, 1);
    assert.equal(await balanceOf(user.id), 0);
    assert.equal(await ledgerCountFor(user.id), 0);
  });

  test('a short stale payment is refused, exactly as on the live path', async () => {
    // The sweep must not become a way to credit an underpaid purchase: it calls
    // the same verifyPayment, so the amount/currency guard still applies.
    const { user, reference } = await checkout();
    await ageBy(reference, 30 * 60 * 1000);
    stub.enqueueVerify({ body: { status: 'success', amount: 1, currency: 'NGN' } });

    const result = await recoverStuckPurchases();

    assert.equal(result.recovered, 0);
    assert.equal(result.stillUnpaid, 1);
    assert.equal(await ledgerCountFor(user.id), 0);
    assert.equal(await balanceOf(user.id), 0);
    const purchase = await prisma.gtPurchase.findUnique({ where: { id: reference } });
    assert.equal(purchase?.status, 'FAILED');
  });

  // The sweep scans every stale row in the table — that is the whole point in
  // production — so rows stranded by earlier tests in this file are picked up
  // too. Assertions below are therefore scoped to *this* test's purchases and
  // the shared counters are only ever asserted as a floor.
  test('a provider outage on one row does not abort the sweep', async () => {
    const first = await checkout();
    const second = await checkout();
    const third = await checkout();
    await ageBy(first.reference, 30 * 60 * 1000);
    await ageBy(second.reference, 30 * 60 * 1000);
    await ageBy(third.reference, 30 * 60 * 1000);

    // Oldest first: #1 explodes, #2 is genuinely unpaid, #3 is paid and must
    // still be recovered. A sweep that gave up on the first error would silently
    // strand #3.
    stub.enqueueVerify(new TypeError('fetch failed'));
    stub.enqueueVerify({ body: { status: 'failed', amount: 200_000 } });
    stub.enqueueVerify(verifyOk(200_000));

    const result = await recoverStuckPurchases();

    assert.ok(result.recovered >= 1, 'the third purchase must be recovered');
    assert.ok(result.stillUnpaid >= 2);
    assert.equal(await balanceOf(third.user.id), 100, 'the third purchase must be credited');
    assert.equal(await balanceOf(first.user.id), 0);
    assert.equal(await balanceOf(second.user.id), 0);
    assert.equal(await statusOf(first.reference), 'PROCESSING', 'the outage leaves it for retry');
    assert.equal(await statusOf(third.reference), 'COMPLETED');
  });

  test('a provider outage is swallowed and logged, never thrown at the caller', async () => {
    // The sweep runs unattended on a schedule. If verifyPayment's 502 escaped, the
    // BullMQ job would fail and the whole sweep — including every other row's
    // recovery — would be lost for that hour.
    const { user, reference } = await checkout();
    await ageBy(reference, 30 * 60 * 1000);
    stub.enqueueVerify(new TypeError('fetch failed'));

    const warnings: unknown[] = [];
    const original = logger.warn;
    (logger as { warn: unknown }).warn = (...args: unknown[]) => {
      warnings.push(args[0]);
    };

    let result;
    try {
      result = await recoverStuckPurchases();
    } finally {
      (logger as { warn: unknown }).warn = original;
    }

    assert.ok(result, 'the sweep must return rather than throw');
    assert.equal(result.recovered, 0);
    assert.ok(result.stillUnpaid >= 1);
    assert.equal(await balanceOf(user.id), 0);
    assert.equal(await statusOf(reference), 'PROCESSING');
    assert.ok(
      warnings.some((w) => typeof w === 'object' && w !== null && 'err' in w),
      'the provider failure must still be observable in the logs',
    );
  });

  test('a very old abandoned purchase is still swept', async () => {
    const { user, reference } = await checkout();
    await ageBy(reference, 72 * HOUR);
    stub.enqueueVerify(verifyOk(200_000));

    const result = await recoverStuckPurchases();

    assert.ok(result.recovered >= 1);
    assert.equal(await balanceOf(user.id), 100);
    assert.equal(await statusOf(reference), 'COMPLETED');
  });
});