import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { ApiError } from '../middleware/errorHandler';
import { awardTokens } from './tokenService';

// ---------------------------------------------------------------------------
// Paystack GT payment integration (Phase 2).
//
// Flow: initializePurchase() creates a PENDING GtPurchase and asks Paystack to
// initialize a transaction (we supply the purchase id as the reference).
// verifyPayment() is the single source of truth for crediting GT — it can be
// triggered by the client returning from checkout AND by the Paystack webhook.
// Credit is idempotent: the TokenLedger row is keyed by `purchase:<id>`, so a
// webhook race with the client verify can never double-credit.
//
// When PAYSTACK_SECRET_KEY is absent the routes fail fast with a 503 so the
// rest of the economy keeps working in local/dev environments.
// ---------------------------------------------------------------------------

const PAYSTACK_API = 'https://api.paystack.co';

export interface PaystackInitializeData {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface PaystackVerifyData {
  status: string;
  reference: string;
  amount: number;
  currency?: string;
  paid_at?: string | null;
}

const isConfigured = (): boolean => Boolean(env.PAYSTACK_SECRET_KEY);

const requireConfigured = (): string => {
  if (!env.PAYSTACK_SECRET_KEY) {
    throw new ApiError(
      'Payments are not configured yet. Please try again later.',
      'PAYMENTS_NOT_CONFIGURED',
      503,
    );
  }
  return env.PAYSTACK_SECRET_KEY;
};

const paystackFetch = async <T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> => {
  const secret = requireConfigured();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${PAYSTACK_API}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as
      | { status?: boolean; message?: string; data?: T }
      | null;

    if (!response.ok || !payload?.status || payload.data === undefined) {
      logger.error(
        { path, statusCode: response.status, message: payload?.message },
        'Paystack request failed',
      );
      throw new ApiError(
        payload?.message || 'Payment provider request failed',
        'PAYMENT_PROVIDER_ERROR',
        502,
      );
    }

    return payload.data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logger.error({ err, path }, 'Paystack request error');
    throw new ApiError('Payment provider unreachable', 'PAYMENT_PROVIDER_ERROR', 502);
  } finally {
    clearTimeout(timeout);
  }
};

export interface InitializePaymentResult {
  access_code: string;
  reference: string;
  authorization_url: string;
  gtAmount: number;
  amountKobo: number;
}

/**
 * Create a PENDING purchase and initialize a Paystack transaction. The GT amount
 * credited includes the bundle's bonusPercent.
 */
export async function initializePayment(
  userId: string,
  bundleId: string,
): Promise<InitializePaymentResult> {
  const bundle = await prisma.gtBundle.findUnique({ where: { id: bundleId } });
  if (!bundle || !bundle.active) {
    throw new ApiError('GT bundle not found or unavailable', 'NOT_FOUND', 404);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user?.email) {
    throw new ApiError('A verified email is required to purchase GT', 'VALIDATION_ERROR', 400);
  }

  const gtAmount = bundle.gtAmount + Math.floor((bundle.gtAmount * bundle.bonusPercent) / 100);

  const purchase = await prisma.gtPurchase.create({
    data: {
      userId,
      bundleId: bundle.id,
      bundleName: bundle.name,
      gtAmount,
      amountKobo: bundle.priceKobo,
      currency: bundle.currency,
      status: 'PENDING',
    },
  });

  const reference = purchase.id;

  try {
    const data = await paystackFetch<PaystackInitializeData>('/transaction/initialize', {
      method: 'POST',
      body: {
        email: user.email,
        amount: bundle.priceKobo,
        currency: bundle.currency,
        reference,
        ...(env.PAYSTACK_CALLBACK_URL ? { callback_url: env.PAYSTACK_CALLBACK_URL } : {}),
        metadata: { userId, bundleId: bundle.id, purchaseId: purchase.id },
      },
    });

    await prisma.gtPurchase.update({
      where: { id: purchase.id },
      data: {
        status: 'PROCESSING',
        paystackRef: data.reference,
        paystackAccess: data.access_code,
      },
    });

    logger.info(
      { userId, purchaseId: purchase.id, bundleId: bundle.id, gtAmount },
      'GT purchase initialized',
    );

    return {
      access_code: data.access_code,
      reference: data.reference,
      authorization_url: data.authorization_url,
      gtAmount,
      amountKobo: bundle.priceKobo,
    };
  } catch (err) {
    await prisma.gtPurchase
      .update({ where: { id: purchase.id }, data: { status: 'FAILED' } })
      .catch(() => undefined);
    throw err;
  }
}

export interface VerifyPaymentResult {
  success: boolean;
  gtCredited: number;
  newBalance: number | null;
  status: string;
  alreadyCredited: boolean;
}

/**
 * Verify a transaction with Paystack and credit GT on success. Idempotent:
 * calling it twice (client verify + webhook) credits GT exactly once.
 */
export async function verifyPayment(reference: string): Promise<VerifyPaymentResult> {
  const purchase = await prisma.gtPurchase.findFirst({
    where: { OR: [{ id: reference }, { paystackRef: reference }] },
  });

  if (!purchase) {
    throw new ApiError('Purchase not found', 'NOT_FOUND', 404);
  }

  if (purchase.status === 'COMPLETED') {
    const wallet = await prisma.userWallet.findUnique({ where: { userId: purchase.userId } });
    return {
      success: true,
      gtCredited: purchase.gtAmount,
      newBalance: wallet?.balance ?? null,
      status: purchase.status,
      alreadyCredited: true,
    };
  }

  const data = await paystackFetch<PaystackVerifyData>(
    `/transaction/verify/${encodeURIComponent(reference)}`,
  );

  if (data.status !== 'success') {
    await prisma.gtPurchase.update({
      where: { id: purchase.id },
      data: { status: 'FAILED', paystackRef: data.reference ?? purchase.paystackRef },
    });
    return {
      success: false,
      gtCredited: 0,
      newBalance: null,
      status: data.status,
      alreadyCredited: false,
    };
  }

  // Guard against tampering, partial payments and wrong-currency settlement.
  //
  // This check is deliberately FAIL-CLOSED. The previous form was
  // `typeof data.amount === 'number' && data.amount < purchase.amountKobo`,
  // which credits GT whenever `amount` is missing or non-numeric — i.e. the one
  // anti-fraud control on the money path was bypassed by a malformed provider
  // response rather than tripped by it. Paystack sends `amount` as a JSON number,
  // so "not a number" means the payload is not the shape we signed off on and the
  // only safe response is to refuse.
  const charged = data.amount;
  const amountOk = typeof charged === 'number' && Number.isFinite(charged);
  // Paystack always reports `currency` on a successful transaction, so an absent
  // one is a malformed payload, not a reason to trust the amount.
  const currencyOk =
    typeof data.currency === 'string' &&
    data.currency.length > 0 &&
    data.currency === purchase.currency;

  if (!amountOk || charged < purchase.amountKobo || !currencyOk) {
    logger.error(
      {
        purchaseId: purchase.id,
        expectedAmountKobo: purchase.amountKobo,
        receivedAmount: charged,
        expectedCurrency: purchase.currency,
        receivedCurrency: data.currency ?? null,
      },
      'Paystack amount/currency mismatch — refusing to credit GT',
    );
    await prisma.gtPurchase.update({
      where: { id: purchase.id },
      data: { status: 'FAILED' },
    });
    throw new ApiError(
      'Payment amount does not match the bundle',
      'PAYMENT_AMOUNT_MISMATCH',
      400,
    );
  }

  // Credit first (idempotent) so the GT can never be lost to a later write
  // failure; then reconcile the purchase row.
  const ledger = await awardTokens({
    userId: purchase.userId,
    type: 'EARN',
    amount: purchase.gtAmount,
    reason: `GT purchase: ${purchase.bundleName}`,
    sourceType: 'GT_PURCHASE',
    sourceId: purchase.id,
    idempotencyKey: `purchase:${purchase.id}`,
    metadata: { reference: data.reference, amountKobo: purchase.amountKobo },
  });

  const paidAt = data.paid_at ? new Date(data.paid_at) : new Date();

  await prisma.gtPurchase.update({
    where: { id: purchase.id },
    data: {
      status: 'COMPLETED',
      paystackRef: data.reference ?? purchase.paystackRef,
      paidAt,
      creditedAt: new Date(),
    },
  });

  await prisma.notification
    .create({
      data: {
        userId: purchase.userId,
        title: 'GT purchase complete',
        message: `${purchase.gtAmount} GT has been added to your wallet.`,
        type: 'STORE',
      },
    })
    .catch(() => undefined);

  logger.info(
    { purchaseId: purchase.id, userId: purchase.userId, gtAmount: purchase.gtAmount },
    'GT purchase credited',
  );

  return {
    success: true,
    gtCredited: purchase.gtAmount,
    newBalance: ledger.balanceAfter,
    status: 'COMPLETED',
    alreadyCredited: false,
  };
}

/**
 * Handle a verified Paystack webhook event. The route verifies the signature
 * before calling this, so here we only act on charge success and delegate to
 * the idempotent verifyPayment().
 */
export async function handleWebhook(event: {
  event?: string;
  data?: { reference?: string };
}): Promise<void> {
  if (event.event !== 'charge.success' || !event.data?.reference) {
    return;
  }

  try {
    await verifyPayment(event.data.reference);
  } catch (err) {
    // Never let a webhook 500 forever — Paystack retries, and verifyPayment is
    // idempotent, so log and swallow transient failures.
    logger.error({ err, reference: event.data.reference }, 'Paystack webhook handling failed');
  }
}

export async function getBundles() {
  return prisma.gtBundle.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { gtAmount: 'asc' }],
  });
}

export async function getPurchaseHistory(userId: string, page = 1, limit = 20) {
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(50, Math.max(1, limit));

  const [purchases, total] = await Promise.all([
    prisma.gtPurchase.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
      select: {
        id: true,
        bundleName: true,
        gtAmount: true,
        amountKobo: true,
        currency: true,
        status: true,
        paidAt: true,
        creditedAt: true,
        createdAt: true,
      },
    }),
    prisma.gtPurchase.count({ where: { userId } }),
  ]);

  return {
    purchases,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    },
  };
}
