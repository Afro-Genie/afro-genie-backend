import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import type { Server } from 'node:http';
import express from 'express';
import type { Request } from 'express';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { env } from '../src/lib/env';
import { logger } from '../src/lib/logger';
import { paymentsRouter } from '../src/routes/payments';
import { tokensRouter } from '../src/routes/tokens';
import { errorHandler } from '../src/middleware/errorHandler';

// ---------------------------------------------------------------------------
// Phase 1 (GT money path) test fixtures.
//
// SAFETY CONTRACT — same shape as phase3Fixtures.ts:
//   * Every row is tagged `P1TEST-<uuid>` and tracked by id at creation.
//   * Cleanup is scoped to captured ids only. There is no deleteMany without an
//     explicit `where`, and no existing bundle, purchase, wallet, ledger or pass
//     row is ever read for mutation.
//   * A leak fails the test rather than silently accumulating in the shared
//     disposable database.
//   * `globalThis.fetch` is replaced for the duration of a test, so no request
//     can reach api.paystack.co and no test can spend real provider quota. The
//     original is always restored in `after()`.
//
// WHY THE FETCH STUB IS NOT OPTIONAL: paymentService calls the live Paystack
// API through global `fetch`. Without a stub, a single "verify succeeded" test
// would make a real network call with a real key. Test-mode keys make that
// harmless in practice, but it would still be flaky, slow and quota-consuming.
// ---------------------------------------------------------------------------

export const P1_SENTINEL = 'P1TEST';

export const tag = (what: string): string => `${P1_SENTINEL}-${what}-${randomUUID().slice(0, 8)}`;

export interface PaymentFixtureRegistry {
  userIds: string[];
  bundleIds: string[];
  redisKeys: string[];
}

export const newPaymentRegistry = (): PaymentFixtureRegistry => ({
  userIds: [],
  bundleIds: [],
  redisKeys: [],
});

/** A user with a verified email (the only kind that may buy GT). */
export async function createPaymentUser(registry: PaymentFixtureRegistry, overrides: { email?: string } = {}) {
  const name = tag('user');
  const user = await prisma.user.create({
    data: {
      email: overrides.email ?? `${name.toLowerCase()}@afrogenie.local`,
      displayName: name,
    },
  });
  registry.userIds.push(user.id);
  return user;
}

/**
 * A user id that is guaranteed not to exist. `User.email` is a required column,
 * so "no verified email" is only reachable as a missing/unresolvable user — and
 * initializePayment must refuse that rather than initialize a Paystack
 * transaction it can never reconcile.
 */
export const MISSING_USER_ID = `p1test-missing-user-${randomUUID()}`;

export interface BundleFields {
  gtAmount?: number;
  priceKobo?: number;
  bonusPercent?: number;
  active?: boolean;
}

/** A throwaway GT bundle. GtBundle has no unique name constraint, so each test gets its own. */
export async function createPaymentBundle(registry: PaymentFixtureRegistry, fields: BundleFields = {}) {
  const bundle = await prisma.gtBundle.create({
    data: {
      name: tag('bundle'),
      gtAmount: fields.gtAmount ?? 100,
      priceKobo: fields.priceKobo ?? 1_000_00,
      bonusPercent: fields.bonusPercent ?? 0,
      active: fields.active ?? true,
      currency: 'NGN',
      sortOrder: 999,
    },
  });
  registry.bundleIds.push(bundle.id);
  return bundle;
}

// ---------------------------------------------------------------------------
// Paystack API stub
// ---------------------------------------------------------------------------

export interface StubbedCall {
  path: string;
  method: string;
  authHeader: string | null;
  body: unknown;
}

export interface PaystackStub {
  /** Every request paymentService made, in order. */
  calls: StubbedCall[];
  /**
   * Queued response for POST /transaction/initialize.
   * The LAST entry is reused once the queue drains, so a test that initializes
   * repeatedly does not have to enqueue repeatedly.
   */
  enqueueInitialize: (response: StubResponse | Error) => void;
  /** Queued response for GET /transaction/verify/:ref. Same reuse rule. */
  enqueueVerify: (response: StubResponse | Error) => void;
  /** Fallback for any other path. */
  enqueueDefault: (response: StubResponse | Error) => void;
  restore: () => void;
}

export interface StubResponse {
  status?: number;
  /** Paystack always wraps in { status, message, data }. */
  status_field?: boolean;
  body?: unknown;
  /** Throw this instead of responding — models a network failure. */
  throwError?: Error;
  /** Return a body that is not JSON, to exercise the `payload?.data === undefined` guard. */
  nonJson?: string;
}

const realFetch = globalThis.fetch;

/**
 * Install the stub. ALWAYS pair with `stub.restore()` (or rely on the file-level
 * `after`).
 *
 * Responses are queued PER ENDPOINT, not in one shared list. A single shared list
 * is a trap here: a checkout is two provider calls (initialize, then verify) that
 * must return different payloads, and a positional queue silently hands the
 * initialize response to the verify call. Keying by endpoint makes that
 * impossible.
 */
export function stubPaystack(): PaystackStub {
  const calls: StubbedCall[] = [];
  let initializeQueue: Array<StubResponse | Error> = [];
  let verifyQueue: Array<StubResponse | Error> = [];
  let defaultQueue: Array<StubResponse | Error> = [];

  const take = (queue: Array<StubResponse | Error>): StubResponse | Error | undefined =>
    queue.length > 1 ? queue.shift() : queue[0];

  const impl = async (input: any, init: any = {}) => {
    const url = String(input);

    // PASS THROUGH anything that is not Paystack. The HTTP harness drives the app
    // over loopback with the SAME global `fetch`, so without this branch the stub
    // would swallow the test's own request to 127.0.0.1 and every route test
    // would fail with "no queued response".
    if (!url.startsWith('https://api.paystack.co')) {
      return realFetch(input, init);
    }

    const path = url.replace('https://api.paystack.co', '');
    const method = (init.method ?? 'GET').toUpperCase();

    let body: unknown;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    calls.push({
      path,
      method,
      authHeader: init?.headers?.Authorization ?? null,
      body,
    });

    const isInitialize = method === 'POST' && path === '/transaction/initialize';
    const isVerify = method === 'GET' && path.startsWith('/transaction/verify/');

    const next = isInitialize ? take(initializeQueue) : isVerify ? take(verifyQueue) : take(defaultQueue);

    if (!next) {
      throw new Error(
        `stubPaystack: no queued response for ${method} ${path}. ` +
          'Use enqueueInitialize / enqueueVerify / enqueueDefault.',
      );
    }
    if (next instanceof Error) throw next;

    if (next.throwError) throw next.throwError;

    const status = next.status ?? 200;

    // CLONE before touching it. The queue deliberately reuses its last entry, so
    // mutating `next.body` in place would pin the first request's echoed
    // reference onto every later request — and `GtPurchase.paystackRef` is
    // @unique, so the second checkout in a file would fail on a unique violation
    // that has nothing to do with the code under test.
    const data: unknown =
      next.body && typeof next.body === 'object' && !Array.isArray(next.body)
        ? { ...(next.body as Record<string, unknown>) }
        : (next.body ?? {});

    // Paystack echoes back the reference we sent, which keeps every purchase
    // reference unique (cuid) exactly as it is in production.
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      if (record.reference === undefined) {
        const sent = (body as { reference?: string } | undefined)?.reference;
        if (typeof sent === 'string') record.reference = sent;
      }
    }

    const payload =
      next.nonJson !== undefined
        ? { __raw: next.nonJson }
        : {
            status: next.status_field ?? true,
            message: next.body ? undefined : 'stub',
            data,
          };

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as unknown as Response;
  };

  globalThis.fetch = impl as unknown as typeof globalThis.fetch;

  return {
    calls,
    enqueueInitialize: (response) => {
      initializeQueue.push(response);
    },
    enqueueVerify: (response) => {
      verifyQueue.push(response);
    },
    enqueueDefault: (response) => {
      defaultQueue.push(response);
    },
    restore: () => {
      globalThis.fetch = realFetch;
      initializeQueue = [];
      verifyQueue = [];
      defaultQueue = [];
    },
  };
}

// ---------------------------------------------------------------------------
// Payment config helpers — mutate `env` for the duration of one test
// ---------------------------------------------------------------------------

export interface PaymentConfigSnapshot {
  PAYSTACK_SECRET_KEY?: string;
  PAYSTACK_PUBLIC_KEY?: string;
  PAYSTACK_CALLBACK_URL?: string;
}

/**
 * `env` is a parsed plain object, so tests can flip the keys to exercise both
 * the configured and the unconfigured path. Always restore, or later tests in
 * the same file inherit the wrong state.
 */
export function setPaymentConfig(next: PaymentConfigSnapshot): PaymentConfigSnapshot {
  const previous: PaymentConfigSnapshot = {
    PAYSTACK_SECRET_KEY: env.PAYSTACK_SECRET_KEY,
    PAYSTACK_PUBLIC_KEY: env.PAYSTACK_PUBLIC_KEY,
    PAYSTACK_CALLBACK_URL: env.PAYSTACK_CALLBACK_URL,
  };
  env.PAYSTACK_SECRET_KEY = next.PAYSTACK_SECRET_KEY;
  env.PAYSTACK_PUBLIC_KEY = next.PAYSTACK_PUBLIC_KEY;
  env.PAYSTACK_CALLBACK_URL = next.PAYSTACK_CALLBACK_URL;
  return previous;
}

export const restorePaymentConfig = (snapshot: PaymentConfigSnapshot): void => {
  env.PAYSTACK_SECRET_KEY = snapshot.PAYSTACK_SECRET_KEY;
  env.PAYSTACK_PUBLIC_KEY = snapshot.PAYSTACK_PUBLIC_KEY;
  env.PAYSTACK_CALLBACK_URL = snapshot.PAYSTACK_CALLBACK_URL;
};

/** A syntactically valid key. Never a real one — the fetch stub blocks egress. */
export const TEST_SECRET = 'sk_test_0000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------
// HTTP harness — mirrors app.ts's rawBody capture, mounts only money routers
// ---------------------------------------------------------------------------

export interface MoneyHarness {
  baseUrl: string;
  request: (
    method: string,
    path: string,
    options?: { body?: unknown; token?: string; rawBody?: string; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: any; headers: Headers }>;
  close: () => Promise<void>;
}

export async function startMoneyHarness(): Promise<MoneyHarness> {
  const savedLevel = logger.level;
  logger.level = 'silent';

  const app = express();
  app.use(
    express.json({
      limit: '1mb',
      // MUST match app.ts: the webhook HMAC is computed over the exact bytes
      // Paystack sent, and JSON re-serialization is not byte-stable.
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use('/api', paymentsRouter);
  app.use('/api', tokensRouter);
  app.use(errorHandler);

  const http = await import('node:http');
  const server: Server = http.createServer(app).listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    request: async (method, path, options = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      Object.assign(headers, options.headers ?? {});

      const payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));

      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
      });

      let body: unknown = null;
      const text = await res.text();
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { status: res.status, body, headers: res.headers };
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.level = savedLevel;
    },
  };
}

/**
 * The webhook route acknowledges with 200 and then processes asynchronously
 * (`void handleWebhook(...)`). Polling is therefore the only correct way to
 * observe the credit; asserting immediately after the 200 would race the code
 * under test and pass for the wrong reason.
 */
export async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 3000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export async function cleanupPaymentFixtures(registry: PaymentFixtureRegistry): Promise<void> {
  for (const key of registry.redisKeys.splice(0)) {
    await redis.del(key).catch(() => undefined);
  }

  // GtPurchase.bundleId is onDelete: Restrict, so purchases must go before the
  // bundles that own them.
  if (registry.userIds.length > 0) {
    await prisma.gtPurchase.deleteMany({ where: { userId: { in: registry.userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: registry.userIds } } });
    // User cascades to wallet, ledger, passes and any remaining purchases.
    await prisma.user.deleteMany({ where: { id: { in: registry.userIds } } });
  }
  if (registry.bundleIds.length > 0) {
    await prisma.gtBundle.deleteMany({ where: { id: { in: registry.bundleIds } } });
  }

  registry.userIds.length = 0;
  registry.bundleIds.length = 0;
}

export async function assertNoPaymentFixtureLeak(): Promise<void> {
  const [users, bundles] = await Promise.all([
    prisma.user.count({ where: { displayName: { startsWith: P1_SENTINEL } } }),
    prisma.gtBundle.count({ where: { name: { startsWith: P1_SENTINEL } } }),
  ]);
  if (users + bundles > 0) {
    throw new Error(`Payment fixture leak: ${users} users, ${bundles} bundles left behind`);
  }
}

/**
 * Register the single teardown for one test file: delete this run's rows, assert
 * nothing sentinel-shaped survived, restore the real `fetch`, then close Redis so
 * the process exits.
 */
export function registerPaymentTeardown(registry: PaymentFixtureRegistry, stub?: PaystackStub): void {
  after(async () => {
    stub?.restore();
    globalThis.fetch = realFetch;
    await cleanupPaymentFixtures(registry);
    await assertNoPaymentFixtureLeak();
    try {
      await redis.quit();
    } catch {
      // already closed
    }
  });
}