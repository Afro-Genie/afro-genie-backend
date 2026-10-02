import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';
import { env } from '../src/lib/env';
import {
  newPaymentRegistry,
  createPaymentUser,
  createPaymentBundle,
  stubPaystack,
  setPaymentConfig,
  startMoneyHarness,
  waitFor,
  registerPaymentTeardown,
  TEST_SECRET,
  type PaymentFixtureRegistry,
  type PaystackStub,
  type PaymentConfigSnapshot,
  type MoneyHarness,
} from './paymentFixtures';

// Phase 1 task 1.5 — the Paystack webhook over real HTTP, and task 1.7 —
// authentication, rate limiting and secret-leak behaviour on the money routes.
//
// The signature tests are the load-bearing ones. /payments/webhook is the ONLY
// path that credits GT with no buyer present, so "HMAC-SHA512 over the raw body,
// keyed by the secret, compared in constant time" is the entire authentication
// story for that endpoint. A regression there is a free-money exploit.

const registry: PaymentFixtureRegistry = newPaymentRegistry();
const configured: PaymentConfigSnapshot = { PAYSTACK_SECRET_KEY: TEST_SECRET };

let stub: PaystackStub;
let harness: MoneyHarness;
let configSnapshot: PaymentConfigSnapshot;

const tokenFor = (userId: string, email: string) =>
  jwt.sign({ userId, email, role: 'USER' }, env.JWT_SECRET, { expiresIn: '5m' });

/** A fresh user + their JWT. One per test keeps "nothing was written" honest. */
const newBuyer = async () => {
  const user = await createPaymentUser(registry);
  return { user, token: tokenFor(user.id, user.email) };
};

/** The exact bytes Paystack signs, and the signature over them. */
const sign = (rawBody: string, secret = TEST_SECRET) =>
  createHmac('sha512', secret).update(Buffer.from(rawBody)).digest('hex');

const chargeSuccessBody = (reference: string, amount = 200_000) =>
  JSON.stringify({
    event: 'charge.success',
    data: {
      id: 1_234_567,
      reference,
      amount,
      currency: 'NGN',
      status: 'success',
      paid_at: new Date().toISOString(),
      customer: { email: 'buyer@afrogenie.local' },
    },
  });

/** Drive a fresh buyer to a PROCESSING purchase of a 100 GT / ₦2,000 bundle. */
const checkout = async () => {
  const { user, token } = await newBuyer();
  const bundle = await createPaymentBundle(registry, { gtAmount: 100, priceKobo: 200_000 });
  stub.enqueueInitialize({ body: { authorization_url: 'https://checkout.test/x', access_code: 'acc' } });
  const res = await harness.request('POST', '/api/payments/initialize', {
    token,
    body: { bundleId: bundle.id },
  });
  assert.equal(res.status, 200, `initialize failed: ${JSON.stringify(res.body)}`);
  return { user, token, bundle, reference: res.body.reference as string };
};

registerPaymentTeardown(registry);

before(async () => {
  harness = await startMoneyHarness();
});

after(async () => {
  await harness.close();
});

beforeEach(() => {
  stub = stubPaystack();
  configSnapshot = setPaymentConfig(configured);
});

afterEach(() => {
  env.PAYSTACK_SECRET_KEY = configSnapshot.PAYSTACK_SECRET_KEY;
  env.PAYSTACK_PUBLIC_KEY = configSnapshot.PAYSTACK_PUBLIC_KEY;
  env.PAYSTACK_CALLBACK_URL = configSnapshot.PAYSTACK_CALLBACK_URL;
  stub.restore();
});

const waitForCompleted = async (reference: string) => {
  const ok = await waitFor(async () => {
    const purchase = await prisma.gtPurchase.findUnique({ where: { id: reference } });
    return purchase?.status === 'COMPLETED';
  });
  assert.equal(ok, true, `purchase ${reference} never reached COMPLETED`);
};

const ledgerCountFor = (userId: string) =>
  prisma.tokenLedger.count({ where: { userId } });

const walletBalanceOf = async (userId: string) => {
  const wallet = await prisma.userWallet.findUnique({ where: { userId } });
  return wallet?.balance;
};

describe('POST /api/payments/webhook — signature', () => {
  test('accepts a correctly signed charge.success and credits GT', async () => {
    const { user, reference } = await checkout();
    stub.enqueueVerify({ body: { status: 'success', amount: 200_000, currency: 'NGN' } });

    const raw = chargeSuccessBody(reference);
    const res = await harness.request('POST', '/api/payments/webhook', {
      rawBody: raw,
      headers: { 'x-paystack-signature': sign(raw) },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { received: true });

    await waitForCompleted(reference);
    assert.equal(await walletBalanceOf(user.id), 100);
  });

  test('rejects a body signed with the WRONG secret, and credits nothing', async () => {
    const { user, reference } = await checkout();
    const raw = chargeSuccessBody(reference);

    const res = await harness.request('POST', '/api/payments/webhook', {
      rawBody: raw,
      headers: { 'x-paystack-signature': sign(raw, 'sk_live_attacker_key') },
    });

    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'INVALID_SIGNATURE');
    // Must reject BEFORE handleWebhook runs, so no provider verify is spent.
    assert.equal(stub.calls.filter((c) => c.path.startsWith('/transaction/verify')).length, 0);
    assert.equal(await ledgerCountFor(user.id), 0);
    assert.equal(await walletBalanceOf(user.id), undefined);

    const purchase = await prisma.gtPurchase.findUnique({ where: { id: reference } });
    assert.equal(purchase?.status, 'PROCESSING');
  });

  test('rejects a tampered payload whose signature covers the original bytes', async () => {
    const { user, reference } = await checkout();

    const genuine = chargeSuccessBody(reference);
    const tampered = chargeSuccessBody('some-other-purchase');

    const res = await harness.request('POST', '/api/payments/webhook', {
      rawBody: tampered,
      headers: { 'x-paystack-signature': sign(genuine) },
    });

    assert.equal(res.status, 401);
    assert.equal(await ledgerCountFor(user.id), 0);
  });

  test('rejects a payload with no signature header (400)', async () => {
    const res = await harness.request('POST', '/api/payments/webhook', {
      rawBody: chargeSuccessBody('anything'),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_SIGNATURE');
  });

  test('rejects a truncated signature without throwing', async () => {
    // timingSafeEqual throws on a length mismatch; the route must compare lengths
    // first or an attacker can turn a 1-byte signature into a 500.
    const res = await harness.request('POST', '/api/payments/webhook', {
      rawBody: chargeSuccessBody('anything'),
      headers: { 'x-paystack-signature': 'ab' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'INVALID_SIGNATURE');
  });

  test('rejects an empty signature', async () => {
    const res = await harness.request('POST', '/api/payments/webhook', {
      rawBody: chargeSuccessBody('anything'),
      headers: { 'x-paystack-signature': '' },
    });
    assert.ok(res.status === 400 || res.status === 401, `got ${res.status}`);
  });

  test('rejects an unsigned body that would otherwise be a valid charge.success', async () => {
    const { user, reference } = await checkout();

    const res = await harness.request('POST', '/api/payments/webhook', {
      rawBody: chargeSuccessBody(reference),
    });

    assert.equal(res.status, 400);
    assert.equal(await ledgerCountFor(user.id), 0);
  });

  test('the signature is over the RAW bytes, so re-serialized JSON is rejected', async () => {
    const { reference } = await checkout();

    // Same event, different key order -> different bytes -> different HMAC. This
    // is exactly why app.ts keeps `rawBody` instead of re-serializing req.body.
    const a = `{"event":"charge.success","data":{"reference":"${reference}"}}`;
    const b = `{"data":{"reference":"${reference}"},"event":"charge.success"}`;

    const accepted = await harness.request('POST', '/api/payments/webhook', {
      rawBody: a,
      headers: { 'x-paystack-signature': sign(a) },
    });
    const rejected = await harness.request('POST', '/api/payments/webhook', {
      rawBody: b,
      headers: { 'x-paystack-signature': sign(a) },
    });

    assert.equal(accepted.status, 200);
    assert.equal(rejected.status, 401);
  });
});

describe('POST /api/payments/webhook — replay and idempotency', () => {
  test('the SAME signed event delivered 5 times credits exactly once', async () => {
    const { user, reference } = await checkout();
    stub.enqueueVerify({ body: { status: 'success', amount: 200_000, currency: 'NGN' } });

    const raw = chargeSuccessBody(reference);
    const signature = sign(raw);

    for (let i = 0; i < 5; i += 1) {
      const res = await harness.request('POST', '/api/payments/webhook', {
        rawBody: raw,
        headers: { 'x-paystack-signature': signature },
      });
      assert.equal(res.status, 200, `delivery ${i + 1} must be acknowledged`);
    }

    await waitForCompleted(reference);
    assert.equal(await ledgerCountFor(user.id), 1, 'five deliveries must make one ledger row');
    assert.equal(await walletBalanceOf(user.id), 100, 'five deliveries, 100 GT — not 500');
  });

  test('concurrent deliveries of the same event credit exactly once', async () => {
    const { user, reference } = await checkout();
    stub.enqueueVerify({ body: { status: 'success', amount: 200_000, currency: 'NGN' } });

    const raw = chargeSuccessBody(reference);
    const signature = sign(raw);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        harness.request('POST', '/api/payments/webhook', {
          rawBody: raw,
          headers: { 'x-paystack-signature': signature },
        }),
      ),
    );

    await waitForCompleted(reference);
    assert.equal(await ledgerCountFor(user.id), 1);
    assert.equal(await walletBalanceOf(user.id), 100);
  });

  test('a webhook racing the client verify credits exactly once', async () => {
    const { user, token, reference } = await checkout();
    stub.enqueueVerify({ body: { status: 'success', amount: 200_000, currency: 'NGN' } });

    const raw = chargeSuccessBody(reference);
    const signature = sign(raw);

    // The frontend calls verify on return AND polls every 4s; Paystack fires the
    // webhook around the same moment. All three can be in flight together.
    const [webhook, firstVerify, secondVerify] = await Promise.all([
      harness.request('POST', '/api/payments/webhook', {
        rawBody: raw,
        headers: { 'x-paystack-signature': signature },
      }),
      harness.request('GET', `/api/payments/verify/${reference}`, { token }),
      harness.request('GET', `/api/payments/verify/${reference}`, { token }),
    ]);

    assert.equal(webhook.status, 200);
    assert.equal(firstVerify.status, 200);
    assert.equal(secondVerify.status, 200);

    await waitForCompleted(reference);
    assert.equal(await ledgerCountFor(user.id), 1);
    assert.equal(await walletBalanceOf(user.id), 100);
  });

  test('a replayed webhook after the first credit reports already-credited, not a new credit', async () => {
    const { user, token, reference } = await checkout();
    stub.enqueueVerify({ body: { status: 'success', amount: 200_000, currency: 'NGN' } });

    const first = await harness.request('GET', `/api/payments/verify/${reference}`, { token });
    assert.equal(first.body.success, true);
    assert.equal(first.body.alreadyCredited, false);

    const raw = chargeSuccessBody(reference);
    await harness.request('POST', '/api/payments/webhook', {
      rawBody: raw,
      headers: { 'x-paystack-signature': sign(raw) },
    });

    const second = await harness.request('GET', `/api/payments/verify/${reference}`, { token });
    assert.equal(second.body.success, true);
    assert.equal(second.body.alreadyCredited, true);
    assert.equal(second.body.newBalance, 100);

    assert.equal(await ledgerCountFor(user.id), 1);
  });

  test('a non charge.success event is acknowledged but credits nothing', async () => {
    const { user, reference } = await checkout();

    const raw = JSON.stringify({ event: 'charge.failed', data: { reference } });
    const res = await harness.request('POST', '/api/payments/webhook', {
      rawBody: raw,
      headers: { 'x-paystack-signature': sign(raw) },
    });

    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(stub.calls.filter((c) => c.path.startsWith('/transaction/verify')).length, 0);
    assert.equal(await ledgerCountFor(user.id), 0);
  });

  test('acknowledges 200 even for an unknown reference, so Paystack stops retrying', async () => {
    const raw = chargeSuccessBody('no-such-reference');
    const res = await harness.request('POST', '/api/payments/webhook', {
      rawBody: raw,
      headers: { 'x-paystack-signature': sign(raw) },
    });
    assert.equal(res.status, 200);
  });

  test('a webhook claiming less than the bundle price credits nothing', async () => {
    const { user, reference } = await checkout();
    // Paystack says success but the amount is short: the amount guard in
    // verifyPayment must refuse, and the ledger must stay empty.
    stub.enqueueVerify({ body: { status: 'success', amount: 1, currency: 'NGN' } });

    const raw = chargeSuccessBody(reference);
    const res = await harness.request('POST', '/api/payments/webhook', {
      rawBody: raw,
      headers: { 'x-paystack-signature': sign(raw) },
    });

    assert.equal(res.status, 200, 'the webhook still acknowledges; the guard runs in verifyPayment');
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(await ledgerCountFor(user.id), 0);
    assert.equal(await walletBalanceOf(user.id), undefined);
    const purchase = await prisma.gtPurchase.findUnique({ where: { id: reference } });
    assert.equal(purchase?.status, 'FAILED');
  });

  test('returns 503 when payments are not configured', async () => {
    setPaymentConfig({});
    const raw = chargeSuccessBody('anything');
    const res = await harness.request('POST', '/api/payments/webhook', {
      rawBody: raw,
      headers: { 'x-paystack-signature': sign(raw) },
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'PAYMENTS_NOT_CONFIGURED');
  });
});

describe('authenticated payment routes', () => {
  test('GET /api/payments/bundles is public', async () => {
    await createPaymentBundle(registry, { gtAmount: 42 });
    const res = await harness.request('GET', '/api/payments/bundles');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  test('GET /api/payments/bundles never leaks inactive bundles', async () => {
    const active = await createPaymentBundle(registry, { gtAmount: 7 });
    const inactive = await createPaymentBundle(registry, { gtAmount: 8, active: false });

    const res = await harness.request('GET', '/api/payments/bundles');
    const ids = res.body.map((b: { id: string }) => b.id);

    assert.ok(ids.includes(active.id));
    assert.ok(!ids.includes(inactive.id));
  });

  test('POST /api/payments/initialize requires auth (401)', async () => {
    const bundle = await createPaymentBundle(registry);
    const res = await harness.request('POST', '/api/payments/initialize', {
      body: { bundleId: bundle.id },
    });
    assert.equal(res.status, 401);
    assert.equal(await prisma.gtPurchase.count({ where: { bundleId: bundle.id } }), 0);
  });

  test('POST /api/payments/initialize rejects a missing bundleId (400)', async () => {
    const { token } = await newBuyer();
    const res = await harness.request('POST', '/api/payments/initialize', { token, body: {} });
    assert.equal(res.status, 400);
  });

  test('POST /api/payments/initialize rejects an unknown bundleId (404)', async () => {
    const { token } = await newBuyer();
    const res = await harness.request('POST', '/api/payments/initialize', {
      token,
      body: { bundleId: 'no-such-bundle' },
    });
    assert.equal(res.status, 404);
  });

  test('GET /api/payments/verify/:reference requires auth (401)', async () => {
    const res = await harness.request('GET', '/api/payments/verify/whatever');
    assert.equal(res.status, 401);
  });

  test('GET /api/payments/history requires auth (401)', async () => {
    const res = await harness.request('GET', '/api/payments/history');
    assert.equal(res.status, 401);
  });

  test("a user cannot verify another user's purchase (404, not 403)", async () => {
    const { user: owner, reference } = await checkout();
    const { token: intruderToken } = await newBuyer();

    const res = await harness.request('GET', `/api/payments/verify/${reference}`, {
      token: intruderToken,
    });

    // 404 rather than 403: a 403 would confirm the reference is a real
    // transaction, leaking the existence of someone else's purchase.
    assert.equal(res.status, 404);
    assert.equal(stub.calls.filter((c) => c.path.startsWith('/transaction/verify')).length, 0);
    assert.equal(await ledgerCountFor(owner.id), 0);
  });

  test('a user only ever sees their own history', async () => {
    const { token: mineToken } = await checkout();
    await checkout();

    const res = await harness.request('GET', '/api/payments/history', { token: mineToken });

    assert.equal(res.status, 200);
    assert.equal(res.body.purchases.length, 1);
    assert.equal(res.body.purchases[0].userId, undefined, 'userId must not be echoed back');
  });

  test('history never exposes provider access codes or refs', async () => {
    const { token } = await checkout();

    const res = await harness.request('GET', '/api/payments/history', { token });

    assert.equal(res.status, 200);
    const row = res.body.purchases[0] as Record<string, unknown>;
    assert.equal('paystackAccess' in row, false);
    assert.equal('paystackRef' in row, false);
  });

  test('no error response leaks the Paystack secret or a provider stack', async () => {
    const { token } = await newBuyer();
    const bundle = await createPaymentBundle(registry);
    stub.enqueueInitialize(new TypeError('connect ECONNREFUSED 10.0.0.1:443 connect'));

    const res = await harness.request('POST', '/api/payments/initialize', {
      token,
      body: { bundleId: bundle.id },
    });

    assert.equal(res.status, 502);
    const serialised = JSON.stringify(res.body);
    assert.ok(!serialised.includes(TEST_SECRET), 'secret must never appear in a response');
    assert.ok(!serialised.includes('sk_test'), 'no key prefix may leak');
    assert.ok(!serialised.includes('sk_live'), 'no key prefix may leak');
    assert.ok(!/at\s+\S+\s+\(/.test(serialised), 'no stack frames may leak');
    assert.ok(!serialised.toLowerCase().includes('paystack_secret'));
  });

  test('a provider 4xx surfaces as 502 without provider internals', async () => {
    const { token } = await newBuyer();
    const bundle = await createPaymentBundle(registry);
    stub.enqueueInitialize({ status: 401, body: undefined });

    const res = await harness.request('POST', '/api/payments/initialize', {
      token,
      body: { bundleId: bundle.id },
    });

    assert.equal(res.status, 502);
    assert.ok(!JSON.stringify(res.body).includes(TEST_SECRET));
  });
});

describe('rate limiting on the money routes', () => {
  // Must match the limits in src/routes/payments.ts.
  const INITIALIZE_LIMIT = 10;
  const VERIFY_LIMIT = 20;

  test('initialize is throttled per user after 10 attempts in a minute', async () => {
    const { token } = await newBuyer();
    const bundle = await createPaymentBundle(registry);
    stub.enqueueInitialize({ body: { authorization_url: 'u', access_code: 'a' } });

    const statuses: number[] = [];
    for (let i = 0; i < INITIALIZE_LIMIT + 3; i += 1) {
      const res = await harness.request('POST', '/api/payments/initialize', {
        token,
        body: { bundleId: bundle.id },
      });
      statuses.push(res.status);
      if (res.status === 429) {
        assert.equal(res.body.code, 'RATE_LIMITED');
        // Clients need to know when to back off, so a throttled response must
        // carry the quota headers. (express-rate-limit v7 emits them split:
        // RateLimit-Limit / -Remaining / -Reset, not as one combined header.)
        const headerNames = [...res.headers.keys()].map((h) => h.toLowerCase());
        assert.ok(
          headerNames.some((h) => h.startsWith('ratelimit')),
          `expected a RateLimit header on a 429, got ${headerNames.join(', ')}`,
        );
      }
    }

    assert.deepEqual(
      statuses.slice(0, INITIALIZE_LIMIT),
      new Array(INITIALIZE_LIMIT).fill(200),
      'the first 10 attempts must succeed',
    );
    assert.deepEqual(statuses.slice(INITIALIZE_LIMIT), [429, 429, 429]);
  });

  test('one user exhausting the initialize limit does not block another user', async () => {
    const { token: greedyToken } = await newBuyer();
    const { token: politeToken } = await newBuyer();
    const bundle = await createPaymentBundle(registry);
    stub.enqueueInitialize({ body: { authorization_url: 'u', access_code: 'a' } });

    for (let i = 0; i < INITIALIZE_LIMIT + 2; i += 1) {
      await harness.request('POST', '/api/payments/initialize', {
        token: greedyToken,
        body: { bundleId: bundle.id },
      });
    }

    const res = await harness.request('POST', '/api/payments/initialize', {
      token: politeToken,
      body: { bundleId: bundle.id },
    });

    assert.equal(res.status, 200, 'rate limits must be per-user, not global');
  });

  test('verify is throttled after 20 attempts in a minute', async () => {
    const { token } = await newBuyer();
    stub.enqueueVerify({ body: { status: 'success', amount: 200_000, currency: 'NGN' } });

    const statuses: number[] = [];
    for (let i = 0; i < VERIFY_LIMIT + 3; i += 1) {
      const res = await harness.request('GET', `/api/payments/verify/missing-${i}`, { token });
      statuses.push(res.status);
    }

    // Every attempt 404s (no such purchase) until the limit, then 429.
    assert.deepEqual(statuses.slice(0, VERIFY_LIMIT), new Array(VERIFY_LIMIT).fill(404));
    assert.deepEqual(statuses.slice(VERIFY_LIMIT), [429, 429, 429]);
  });

  test('throttling initialize leaves the buyer able to finish an existing checkout', async () => {
    const { token, reference } = await checkout();
    const bundle = await createPaymentBundle(registry);
    stub.enqueueInitialize({ body: { authorization_url: 'u', access_code: 'a' } });

    // Burn the whole initialize budget...
    for (let i = 0; i < INITIALIZE_LIMIT + 1; i += 1) {
      await harness.request('POST', '/api/payments/initialize', { token, body: { bundleId: bundle.id } });
    }

    // ...but the verify limiter is separate, so the in-flight purchase can still
    // be reconciled. A buyer who hit the initialize limit must not be locked out
    // of money they already paid for.
    stub.enqueueVerify({ body: { status: 'success', amount: 200_000, currency: 'NGN' } });
    const res = await harness.request('GET', `/api/payments/verify/${reference}`, { token });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });
});