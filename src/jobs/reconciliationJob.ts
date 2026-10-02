import type { RepeatOptions } from 'bullmq';
import { reconciliationQueue } from '../lib/queue';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { verifyPayment } from '../services/paymentService';

export interface ReconciliationResult {
  checked: number;
  drifted: Array<{ userId: string; walletBalance: number; ledgerSum: number }>;
  recoveredPurchases: number;
  stillUnpaid: number;
}

/**
 * Wallet↔ledger reconciliation (Phase 4 / R2.4 observability).
 *
 * For every UserWallet, compare the cached balance against the true ledger sum.
 * Drift is logged + returned (no writes) so operators/alerts can act on it.
 */
export const runReconciliation = async (): Promise<ReconciliationResult> => {
  const [checked, drifted] = await Promise.all([
    prisma.userWallet.count(),
    prisma.$queryRaw<Array<{ userId: string; walletBalance: number; ledgerSum: number }>>`
      SELECT w."userId" AS "userId",
             w."balance" AS "walletBalance",
             COALESCE(l.s, 0)::int AS "ledgerSum"
      FROM "UserWallet" w
      LEFT JOIN (
        SELECT "userId", COALESCE(SUM("amount"), 0)::int AS s
        FROM "TokenLedger"
        GROUP BY "userId"
      ) l ON l."userId" = w."userId"
      WHERE w."balance" <> COALESCE(l.s, 0)
    `,
  ]);

  for (const d of drifted) {
    logger.warn(
      { userId: d.userId, walletBalance: d.walletBalance, ledgerSum: d.ledgerSum },
      'Token wallet/ledger drift detected — wallet balance should equal the ledger sum',
    );
  }

  const stuck = await recoverStuckPurchases();

  return { checked, drifted, recoveredPurchases: stuck.recovered, stillUnpaid: stuck.stillUnpaid };
};

/**
 * Re-verify purchases that never reached COMPLETED.
 *
 * The webhook route answers 200 *before* calling verifyPayment(), so Paystack
 * never retries and a crash (deploy, OOM, eviction) between the ack and the
 * credit leaves a customer who paid and a row stuck at PENDING/PROCESSING. That
 * is a paid-but-uncredited payment with no retry path and no alert — the worst
 * failure mode in the money path, and one the ledger idempotency alone cannot
 * fix because nothing ever comes back to try.
 *
 * So we come back to it. verifyPayment is idempotent (ledger key
 * `purchase:<id>`), so re-running it is safe and cheap for rows that already
 * resolved; rows Paystack still reports as unpaid simply stay put for the next
 * sweep. Only rows older than STUCK_PURCHASE_AGE_MS are considered, so a
 * purchase the user is actively paying right now is never raced.
 */
const STUCK_PURCHASE_AGE_MS = 10 * 60 * 1000;
const STUCK_PURCHASE_BATCH = 25;

export const recoverStuckPurchases = async (): Promise<{ recovered: number; stillUnpaid: number }> => {
  const cutoff = new Date(Date.now() - STUCK_PURCHASE_AGE_MS);
  const stuck = await prisma.gtPurchase.findMany({
    where: { status: { in: ['PENDING', 'PROCESSING'] }, createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: STUCK_PURCHASE_BATCH,
    select: { id: true, userId: true },
  });

  let recovered = 0;
  let stillUnpaid = 0;

  // Sequential on purpose: this spends metered Paystack API quota, and a burst
  // of 25 parallel verifies is exactly what gets an integration rate-limited.
  for (const purchase of stuck) {
    try {
      const result = await verifyPayment(purchase.id);
      if (result.status === 'COMPLETED') {
        recovered += 1;
        logger.info(
          { purchaseId: purchase.id, userId: purchase.userId },
          'Recovered a paid-but-uncredited GT purchase',
        );
      } else {
        stillUnpaid += 1;
      }
    } catch (err) {
      // An unreachable provider, an unknown reference or a genuine amount
      // mismatch must not abort the sweep — the next run retries.
      stillUnpaid += 1;
      logger.warn(
        { err, purchaseId: purchase.id, userId: purchase.userId },
        'Stuck-purchase recovery could not resolve this row; will retry',
      );
    }
  }

  if (recovered > 0 || stillUnpaid > 0) {
    logger.info({ recovered, stillUnpaid }, 'GT purchase recovery sweep finished');
  }

  return { recovered, stillUnpaid };
};

const RECONCILIATION_JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: 50,
  repeat: {
    // Hourly from process start (BullMQ handles exact cadence via its repeat
    // scheduler). The drift scan is read-only and idempotent. This cadence also
    // sets the paid-but-uncredited recovery SLA: a stuck purchase picked up by
    // this sweep is credited within STUCK_PURCHASE_AGE_MS + 1 hour (~70 min),
    // versus "never" before recoverStuckPurchases existed.
    every: 60 * 60 * 1000,
  } satisfies RepeatOptions,
};

export const scheduleReconciliation = async () => {
  await reconciliationQueue.add(
    'reconcile',
    {},
    { ...RECONCILIATION_JOB_OPTIONS, jobId: 'reconcile-wallets' },
  );
};

export const processReconciliationJob = async (): Promise<void> => {
  await runReconciliation();
};
