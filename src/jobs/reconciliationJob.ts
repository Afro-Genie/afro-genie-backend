import type { RepeatOptions } from 'bullmq';
import { reconciliationQueue } from '../lib/queue';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export interface ReconciliationResult {
  checked: number;
  drifted: Array<{ userId: string; walletBalance: number; ledgerSum: number }>;
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

  return { checked, drifted };
};

const RECONCILIATION_JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: 50,
  repeat: {
    // Hourly from process start (BullMQ handles exact cadence via its repeat
    // scheduler). The scan is read-only and idempotent.
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
