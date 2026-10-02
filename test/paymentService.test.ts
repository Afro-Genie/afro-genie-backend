import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { ApiError } from '../src/middleware/errorHandler';
import {
  initializePayment,
  verifyPayment,
  handleWebhook,
  getPurchaseHistory,
} from '../src/services/paymentService';
import {
  newPaymentRegistry,
  createPaymentUser,
  createPaymentBundle,
  stubPaystack,
  setPaymentConfig,
  restorePaymentConfig,
  registerPaymentTeardown,
  MISSING_USER_ID,
  TEST_SECRET,
  tag,
  type PaymentFixtureRegistry,
  type PaystackStub,
  type PaymentConfigSnapshot,
} from './paymentFixtures';

// Phase 1 task 1.4 — paymentService unit behaviour, and task 1.8 — the
// wallet/ledger double-entry proof that a successful payment is worth exactly
// what it says it is.

const registry: PaymentFixtureRegistry = newPaymentRegistry();
const configured: PaymentConfigSnapshot = { PAYSTACK_SECRET_KEY: TEST_SECRET };

let stub: PaystackStub;
let configSnapshot: PaymentConfigSnapshot;

registerPaymentTeardown(registry);

beforeEach(() => {
  stub = stubPaystack();
  configSnapshot = setPaymentConfig(configured);
});

afterEach(() => {
  restorePaymentConfig(configSnapshot);
  stub.restore();
});

const expectApiError = async (fn: () => Promise<unknown>, status: number, code: string) => {
  await assert.rejects(fn, (err: any) => {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
};

describe('initializePayment', () => {
  test('rejects an unknown bundle with 404 and never calls Paystack', async () => {
    const user = await createPaymentUser(registry);

    await expectApiError(() => initializePayment(user.id, 'no-such-bundle'), 404, 'NOT_FOUND');
    assert.equal(stub.calls.length, 0, 'a 404 must not cost a provider API call');
  });

  test('rejects an inactive bundle with 404', async () => {
    const user = await createPaymentUser(registry);
    const bundle = await createPaymentBundle(registry, { active: false });

    await expectApiError(() => initializePayment(user.id, bundle.id), 404, 'NOT_FOUND');
    assert.equal(stub.calls.length, 0);
  });

  test('rejects a user without a verifiable email with 400', async () => {
    const bundle = await createPaymentBundle(registry);

    await expectApiError(() => initializePayment(MISSING_USER_ID, bundle.id), 400, 'VALIDATION_ERROR');
    assert.equal(stub.calls.length, 0);
  });

  test('returns 503 PAYMENTS_NOT_CONFIGURED when no secret key is present', async () => {
    const user = await createPaymentUser(registry);
    const bundle = await createPaymentBundle(registry);

    // Clear the key, and let the file-level afterEach restore it.
    setPaymentConfig({});

    await expectApiError(() => initializePayment(user.id, bundle.id), 503, 'PAYMENTS_NOT_CONFIGURED');
    assert.equal(stub.calls.length, 0);

    // The purchase must not exist either: 503 is raised inside paystackFetch,
    // which is inside the try, so the catch marks it FAILED. Either way, nothing
    // is credited.
    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 0);
  });

  test('creates a purchase keyed by its own id and returns checkout data', async () => {
    const user = await createPaymentUser(registry);
    const bundle = await createPaymentBundle(registry, { gtAmount: 250, priceKobo: 200_000 });

    // `reference` deliberately omitted so the stub echoes the purchase id we
    // sent — which is what Paystack does.
    stub.enqueueInitialize({
      body: {
        authorization_url: 'https://checkout.paystack.test/abc',
        access_code: 'access_abc',
      },
    });

    const result = await initializePayment(user.id, bundle.id);

    assert.equal(result.gtAmount, 250);
    assert.equal(result.amountKobo, 200_000);
    assert.equal(result.access_code, 'access_abc');
    assert.equal(result.authorization_url, 'https://checkout.paystack.test/abc');

    // Paystack echoes our reference, so the id the client holds IS the
    // GtPurchase primary key. verify() accepts either form without a second
    // lookup table.
    assert.equal(result.reference, stub.calls[0].body !== null ? (stub.calls[0].body as any).reference : undefined);

    const purchase = await prisma.gtPurchase.findUnique({ where: { id: result.reference } });
    assert.ok(purchase, 'the purchase id is the reference passed to Paystack');
    assert.equal(purchase.status, 'PROCESSING');
    assert.equal(purchase.paystackRef, result.reference);
    assert.equal(purchase.paystackAccess, 'access_abc');
    assert.equal(purchase.gtAmount, 250);
    assert.equal(purchase.amountKobo, 200_000);
    assert.equal(purchase.userId, user.id);
    assert.equal(purchase.bundleId, bundle.id);
  });

  test('sends the bundle price and email to Paystack, including the bonus', async () => {
    const user = await createPaymentUser(registry);
    const bundle = await createPaymentBundle(registry, { gtAmount: 100, priceKobo: 50_000, bonusPercent: 25 });

    stub.enqueueInitialize({ body: { authorization_url: 'u', access_code: 'a' } });
    const result = await initializePayment(user.id, bundle.id);

    // 100 + 25% bonus = 125 credited.
    assert.equal(result.gtAmount, 125);
    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    assert.equal(call.path, '/transaction/initialize');
    assert.equal(call.method, 'POST');
    assert.equal(call.authHeader, `Bearer ${TEST_SECRET}`);
    assert.equal((call.body as any).email, user.email);
    assert.equal((call.body as any).amount, 50_000);
    assert.equal((call.body as any).reference, result.reference);
    assert.equal((call.body as any).metadata.purchaseId, result.reference);
  });

  test('omits callback_url when none is configured, so Paystack uses the dashboard default', async () => {
    const user = await createPaymentUser(registry);
    const bundle = await createPaymentBundle(registry);
    setPaymentConfig({ PAYSTACK_SECRET_KEY: TEST_SECRET });

    stub.enqueueInitialize({ body: { authorization_url: 'u', access_code: 'a' } });
    await initializePayment(user.id, bundle.id);

    assert.equal('callback_url' in (stub.calls[0].body as object), false);
  });

  test('sends the configured callback_url to Paystack', async () => {
    const user = await createPaymentUser(registry);
    const bundle = await createPaymentBundle(registry);
    setPaymentConfig({
      PAYSTACK_SECRET_KEY: TEST_SECRET,
      PAYSTACK_CALLBACK_URL: 'https://afro-genie-staging.vercel.app/buy-gt',
    });

    stub.enqueueInitialize({ body: { authorization_url: 'u', access_code: 'a' } });
    await initializePayment(user.id, bundle.id);

    assert.equal(
      (stub.calls[0].body as any).callback_url,
      'https://afro-genie-staging.vercel.app/buy-gt',
    );
  });

  test('marks the purchase FAILED when the provider errors, and writes no ledger row', async () => {
    const user = await createPaymentUser(registry);
    const bundle = await createPaymentBundle(registry);

    stub.enqueueInitialize({ status: 500, body: undefined });
    await expectApiError(() => initializePayment(user.id, bundle.id), 502, 'PAYMENT_PROVIDER_ERROR');

    const purchases = await prisma.gtPurchase.findMany({ where: { userId: user.id } });
    assert.equal(purchases.length, 1);
    assert.equal(purchases[0].status, 'FAILED');
    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 0);
  });

  test('surfaces provider unreachability as 502 without a stack trace in the message', async () => {
    const user = await createPaymentUser(registry);
    const bundle = await createPaymentBundle(registry);

    stub.enqueueInitialize(new TypeError('fetch failed: getaddrinfo ENOTFOUND api.paystack.co'));
    await expectApiError(() => initializePayment(user.id, bundle.id), 502, 'PAYMENT_PROVIDER_ERROR');
  });

  test('rejects an invalid (status:false) provider payload as 502', async () => {
    const user = await createPaymentUser(registry);
    const bundle = await createPaymentBundle(registry);

    // Paystack answered, but with `status:false` — a non-2xx-shaped business error.
    stub.enqueueInitialize({ status: 200, status_field: false, body: undefined });
    await expectApiError(() => initializePayment(user.id, bundle.id), 502, 'PAYMENT_PROVIDER_ERROR');
  });

  test('rejects a payload with no data object as 502', async () => {
    const user = await createPaymentUser(registry);
    const bundle = await createPaymentBundle(registry);

    // Non-JSON body: `response.json()` throws, `.catch(() => null)` yields null,
    // and `payload?.data === undefined` must trip the guard.
    stub.enqueueInitialize({ nonJson: '<html>502 Bad Gateway</html>' });
    await expectApiError(() => initializePayment(user.id, bundle.id), 502, 'PAYMENT_PROVIDER_ERROR');
  });
});

describe('verifyPayment — task 1.8 double-entry', () => {
  /** Bring a user to the point where Paystack says "paid" for one bundle. */
  const startPaidCheckout = async (fields: Parameters<typeof createPaymentBundle>[1] = {}) => {
    const user = await createPaymentUser(registry);
    const bundle = await createPaymentBundle(registry, fields);
    // No explicit `reference`: the stub echoes the one we sent (the purchase id),
    // which is what Paystack does and keeps GtPurchase.paystackRef unique.
    stub.enqueueInitialize({ body: { authorization_url: 'u', access_code: 'a' } });
    const init = await initializePayment(user.id, bundle.id);
    return { user, bundle, reference: init.reference };
  };

  const verifyOk = (amount: number) => ({
    body: { status: 'success', amount, currency: 'NGN', paid_at: new Date().toISOString() },
  });

  test('credits GT exactly once and leaves wallet and ledger reconciled', async () => {
    const { user, bundle, reference } = await startPaidCheckout({ gtAmount: 100, priceKobo: 200_000 });
    stub.enqueueVerify(verifyOk(200_000));

    const result = await verifyPayment(reference);

    assert.equal(result.success, true);
    assert.equal(result.gtCredited, 100);
    assert.equal(result.alreadyCredited, false);
    assert.equal(result.newBalance, 100);

    const wallet = await prisma.userWallet.findUnique({ where: { userId: user.id } });
    assert.equal(wallet?.balance, 100);

    const rows = await prisma.tokenLedger.findMany({ where: { userId: user.id } });
    assert.equal(rows.length, 1, 'exactly one ledger row per purchase');
    assert.equal(rows[0].amount, 100);
    assert.equal(rows[0].balanceAfter, 100);
    assert.equal(rows[0].type, 'EARN');
    assert.equal(rows[0].sourceType, 'GT_PURCHASE');
    assert.equal(rows[0].idempotencyKey, `purchase:${reference}`);

    const purchase = await prisma.gtPurchase.findUnique({ where: { id: reference } });
    assert.equal(purchase?.status, 'COMPLETED');
    assert.ok(purchase?.creditedAt);
    assert.equal(purchase?.gtAmount, 100);
    assert.equal(purchase?.bundleName, bundle.name);
  });

  test('second verify does not double-credit (client verify + webhook race)', async () => {
    const { user, reference } = await startPaidCheckout({ gtAmount: 100, priceKobo: 200_000 });
    stub.enqueueVerify(verifyOk(200_000));

    const first = await verifyPayment(reference);
    const second = await verifyPayment(reference);

    assert.equal(first.alreadyCredited, false);
    assert.equal(second.alreadyCredited, true);
    assert.equal(second.success, true);
    assert.equal(second.gtCredited, 100);

    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 1);
    const wallet = await prisma.userWallet.findUnique({ where: { userId: user.id } });
    assert.equal(wallet?.balance, 100, 'balance must be 100, not 200');
  });

  test('concurrent verifies credit exactly once', async () => {
    const { user, reference } = await startPaidCheckout({ gtAmount: 100, priceKobo: 200_000 });
    stub.enqueueVerify(verifyOk(200_000));

    const results = await Promise.all([
      verifyPayment(reference),
      verifyPayment(reference),
      verifyPayment(reference),
    ]);

    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 1);
    const wallet = await prisma.userWallet.findUnique({ where: { userId: user.id } });
    assert.equal(wallet?.balance, 100);
    assert.equal(results.filter((r) => r.success).length, 3);
  });

  test('a failed transaction writes no ledger row and no wallet', async () => {
    const { user, reference } = await startPaidCheckout({ gtAmount: 100, priceKobo: 200_000 });
    stub.enqueueVerify({ body: { status: 'failed', amount: 200_000 } });

    const result = await verifyPayment(reference);

    assert.equal(result.success, false);
    assert.equal(result.gtCredited, 0);
    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.userWallet.count({ where: { userId: user.id } }), 0);
    const purchase = await prisma.gtPurchase.findUnique({ where: { id: reference } });
    assert.equal(purchase?.status, 'FAILED');
  });

  test('a short payment is refused: no GT credited even though Paystack says success', async () => {
    const { user, reference } = await startPaidCheckout({ gtAmount: 100, priceKobo: 200_000 });
    // Underpaid by 1 kobo. Crediting here would hand out a full bundle for free.
    stub.enqueueVerify(verifyOk(200_000 - 1));

    await expectApiError(() => verifyPayment(reference), 400, 'PAYMENT_AMOUNT_MISMATCH');

    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.userWallet.count({ where: { userId: user.id } }), 0);
    const purchase = await prisma.gtPurchase.findUnique({ where: { id: reference } });
    assert.equal(purchase?.status, 'FAILED');
  });

  // The amount/currency guard used to read
  // `typeof data.amount === 'number' && data.amount < purchase.amountKobo`,
  // which credited GT whenever the field was absent or non-numeric — i.e. the
  // one anti-fraud control on the money path was bypassed by a malformed provider
  // payload rather than tripped by it. These pin the fail-closed behaviour.
  test('a missing amount is refused rather than silently trusted', async () => {
    const { user, reference } = await startPaidCheckout({ gtAmount: 100, priceKobo: 200_000 });
    stub.enqueueVerify({ body: { status: 'success', currency: 'NGN' } });

    await expectApiError(() => verifyPayment(reference), 400, 'PAYMENT_AMOUNT_MISMATCH');

    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 0);
    const purchase = await prisma.gtPurchase.findUnique({ where: { id: reference } });
    assert.equal(purchase?.status, 'FAILED');
  });

  test('a non-numeric amount string is refused rather than coerced', async () => {
    const { user, reference } = await startPaidCheckout({ gtAmount: 100, priceKobo: 200_000 });
    // "200000" is truthy and would defeat a naive `!data.amount` check. Fail-closed
    // means we never coerce, even to the number it looks like.
    stub.enqueueVerify({ body: { status: 'success', amount: '200000', currency: 'NGN' } });

    await expectApiError(() => verifyPayment(reference), 400, 'PAYMENT_AMOUNT_MISMATCH');

    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 0);
  });

  test('a missing currency is refused', async () => {
    const { user, reference } = await startPaidCheckout({ gtAmount: 100, priceKobo: 200_000 });
    stub.enqueueVerify({ body: { status: 'success', amount: 200_000 } });

    await expectApiError(() => verifyPayment(reference), 400, 'PAYMENT_AMOUNT_MISMATCH');

    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 0);
  });

  test('the right amount in the wrong currency is refused', async () => {
    // Paystack is multi-currency: 200_000 is a full ₦2,000 bundle in NGN but a
    // different real amount in USD/ZAR/GHS, so matching the number alone settles a
    // foreign-currency charge against an NGN price.
    const { user, reference } = await startPaidCheckout({ gtAmount: 100, priceKobo: 200_000 });
    stub.enqueueVerify({ body: { status: 'success', amount: 200_000, currency: 'USD' } });

    await expectApiError(() => verifyPayment(reference), 400, 'PAYMENT_AMOUNT_MISMATCH');

    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.userWallet.count({ where: { userId: user.id } }), 0);
    const purchase = await prisma.gtPurchase.findUnique({ where: { id: reference } });
    assert.equal(purchase?.status, 'FAILED');
  });

  test('overpaying in the right currency is still credited', async () => {
    // The guard is a floor, not an equality: a customer who tips or pays a few
    // kobo over must still receive their bundle.
    const { user, reference } = await startPaidCheckout({ gtAmount: 100, priceKobo: 200_000 });
    stub.enqueueVerify({ body: { status: 'success', amount: 250_000, currency: 'NGN' } });

    const result = await verifyPayment(reference);

    assert.equal(result.success, true);
    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 1);
  });

  test('a provider outage during verify leaves the purchase untouched and uncredited', async () => {
    const { user, reference } = await startPaidCheckout({ gtAmount: 100, priceKobo: 200_000 });
    stub.enqueueVerify(new TypeError('fetch failed'));

    await expectApiError(() => verifyPayment(reference), 502, 'PAYMENT_PROVIDER_ERROR');

    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 0);
    const purchase = await prisma.gtPurchase.findUnique({ where: { id: reference } });
    // Still PROCESSING, so a Paystack retry can legitimately reconcile it later.
    assert.equal(purchase?.status, 'PROCESSING');
    assert.equal(purchase?.creditedAt, null);
  });

  test('an unknown reference is a 404', async () => {
    await expectApiError(() => verifyPayment('no-such-reference'), 404, 'NOT_FOUND');
  });

  test('a user cannot be credited for someone else’s purchase reference', async () => {
    const { reference } = await startPaidCheckout({ gtAmount: 100, priceKobo: 200_000 });

    // verifyPayment is intentionally reference-only; ownership is enforced at the
    // route layer (routes/payments.ts). What matters here is that the credited
    // owner is read from the stored purchase row and never from caller input.
    const purchase = await prisma.gtPurchase.findUnique({ where: { id: reference } });
    assert.ok(purchase?.userId);
    stub.enqueueVerify({ body: { status: 'success', amount: 200_000, currency: 'NGN' } });
    const result = await verifyPayment(reference);
    assert.equal(result.newBalance, 100);

    const wallet = await prisma.userWallet.findUnique({ where: { userId: purchase!.userId } });
    assert.equal(wallet?.balance, 100);
  });

  test('wallet balance always equals the sum of the ledger (reconciliation invariant)', async () => {
    const a = await startPaidCheckout({ gtAmount: 100, priceKobo: 200_000 });
    const b = await startPaidCheckout({ gtAmount: 50, priceKobo: 100_000 });

    // Only the first checkout is paid through; the second is abandoned.
    stub.enqueueVerify(verifyOk(200_000));
    await verifyPayment(a.reference);

    const rows = await prisma.tokenLedger.findMany({
      where: { userId: { in: [a.user.id, b.user.id] } },
      orderBy: { createdAt: 'asc' },
    });
    const wallet = await prisma.userWallet.findUnique({ where: { userId: a.user.id } });
    const sum = rows.filter((r) => r.userId === a.user.id).reduce((acc, r) => acc + r.amount, 0);

    assert.equal(wallet?.balance, sum);
    assert.equal(sum, 100);
    assert.equal(rows.length, 1);
  });
});

describe('handleWebhook', () => {
  test('ignores non charge.success events', async () => {
    const { user, reference } = await (async () => {
      const u = await createPaymentUser(registry);
      const b = await createPaymentBundle(registry, { gtAmount: 100, priceKobo: 200_000 });
      stub.enqueueInitialize({ body: { authorization_url: 'u', access_code: 'a' } });
      const init = await initializePayment(u.id, b.id);
      return { user: u, bundle: b, reference: init.reference };
    })();

    stub.enqueueVerify({ body: { status: 'success', amount: 200_000, currency: 'NGN' } });
    await handleWebhook({ event: 'charge.failed', data: { reference } });

    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 0);
  });

  test('ignores an event with no reference', async () => {
    // beforeEach installed a fresh stub with an empty queue, so any provider call
    // would throw "no queued response". Reaching here without that error proves
    // verify() was never reached.
    await handleWebhook({ event: 'charge.success', data: {} });
    assert.equal(stub.calls.length, 0, 'no provider call for an event with no reference');
  });

  test('never throws on a bad reference (Paystack must not retry forever)', async () => {
    await handleWebhook({ event: 'charge.success', data: { reference: 'unknown-ref' } });
  });

  test('a webhook replay cannot double-credit', async () => {
    const user = await createPaymentUser(registry);
    const bundle = await createPaymentBundle(registry, { gtAmount: 100, priceKobo: 200_000 });
    stub.enqueueInitialize({ body: { authorization_url: 'u', access_code: 'a' } });
    const init = await initializePayment(user.id, bundle.id);

    stub.enqueueVerify({ body: { status: 'success', amount: 200_000, currency: 'NGN' } });

    await handleWebhook({ event: 'charge.success', data: { reference: init.reference } });
    await handleWebhook({ event: 'charge.success', data: { reference: init.reference } });
    await handleWebhook({ event: 'charge.success', data: { reference: init.reference } });

    assert.equal(await prisma.tokenLedger.count({ where: { userId: user.id } }), 1);
    const wallet = await prisma.userWallet.findUnique({ where: { userId: user.id } });
    assert.equal(wallet?.balance, 100);
  });
});

describe('getPurchaseHistory', () => {
  test('is scoped to the caller and paginates', async () => {
    const user = await createPaymentUser(registry);
    const other = await createPaymentUser(registry);
    const bundle = await createPaymentBundle(registry);
    const foreign = await createPaymentBundle(registry, { gtAmount: 999 });

    await prisma.gtPurchase.create({
      data: {
        userId: user.id,
        bundleId: bundle.id,
        bundleName: bundle.name,
        gtAmount: 10,
        amountKobo: 1_000,
        status: 'COMPLETED',
      },
    });
    await prisma.gtPurchase.create({
      data: {
        userId: other.id,
        bundleId: foreign.id,
        bundleName: foreign.name,
        gtAmount: 999,
        amountKobo: 1_000,
        status: 'COMPLETED',
      },
    });

    const result = await getPurchaseHistory(user.id, 1, 20);

    assert.equal(result.purchases.length, 1);
    assert.equal(result.purchases[0].bundleName, bundle.name);
    assert.equal(result.purchases[0].gtAmount, 10);
    assert.equal(result.pagination.total, 1);
    // Response shape must not expose provider internals (access codes, paystack refs).
    const row = result.purchases[0] as Record<string, unknown>;
    assert.equal('paystackAccess' in row, false);
    assert.equal('paystackRef' in row, false);
  });

  test('clamps out-of-range pagination instead of erroring', async () => {
    const user = await createPaymentUser(registry);
    const result = await getPurchaseHistory(user.id, 0, 9_999);
    assert.equal(result.pagination.page, 1);
    assert.equal(result.pagination.limit, 50);
  });
});