import { ModerationAction } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { REWARD_CONFIG } from '../config/rewards';
import { applyTax, awardTokens } from './tokenService';

// ---------------------------------------------------------------------------
// Moderation pool (Phase 2 governance).
//
// A 10% tax on moderator translation rewards flows into a shared pool. Each
// week the pool is split among moderators/arbiters who actually took
// moderation action, proportional to the number of actions they took. The
// pool balance is cached on the ModPool row; the source of truth is the sum
// of TAX ledger rows so the cache can always be repaired.
// ---------------------------------------------------------------------------

const POOL_ID = 'default';

export async function getBalance(): Promise<number> {
  const row = await prisma.modPool.findUnique({ where: { id: POOL_ID } });
  return row?.balance ?? 0;
}

/** Credit the pool cache. Only called after a TAX ledger row was written. */
export async function creditPool(amount: number): Promise<void> {
  if (amount <= 0) return;
  await prisma.modPool.upsert({
    where: { id: POOL_ID },
    update: { balance: { increment: amount } },
    create: { id: POOL_ID, balance: amount },
  });
}

/**
 * 10% tax on a moderator reward. Writes the TAX ledger row (idempotent) and
 * then credits the pool cache. Safe to call on replays: the ledger's unique
 * idempotencyKey prevents double-charging.
 */
export async function contributeTax(params: {
  userId: string;
  rewardAmount: number;
  sourceId: string;
}): Promise<void> {
  const taxAmount = Math.max(1, Math.round(params.rewardAmount * REWARD_CONFIG.MOD_POOL_TAX_PERCENT));
  if (taxAmount <= 0) return;

  const ledger = await applyTax({
    userId: params.userId,
    amount: -taxAmount,
    reason: 'Moderation pool contribution (10% of review reward)',
    sourceType: 'MOD_POOL_TAX',
    sourceId: params.sourceId,
    idempotencyKey: `mod-pool-tax:${params.sourceId}:${params.userId}`,
  });

  await creditPool(taxAmount);
  logger.debug(
    { userId: params.userId, taxAmount, sourceId: params.sourceId, ledgerId: ledger.id },
    'mod pool tax collected',
  );
}

const startOfWeekUtc = (now = new Date()): Date => {
  const day = now.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  return monday;
};

export async function distributeWeekly(now = new Date()): Promise<{
  distributed: number;
  recipients: number;
}> {
  const poolBalance = await getBalance();

  if (poolBalance < REWARD_CONFIG.MOD_POOL_DISTRIBUTE_MIN) {
    logger.info(
      { poolBalance, minimum: REWARD_CONFIG.MOD_POOL_DISTRIBUTE_MIN },
      'mod pool below distribution threshold, skipping',
    );
    return { distributed: 0, recipients: 0 };
  }

  const weekStart = startOfWeekUtc(now);

  const [resolvedReports, moderationLogs] = await Promise.all([
    prisma.contentReport.groupBy({
      by: ['moderatorId'],
      where: { moderatorId: { not: null }, resolvedAt: { gte: weekStart } },
      _count: { _all: true },
    }),
    prisma.moderationLog.groupBy({
      by: ['moderatorId'],
      where: {
        createdAt: { gte: weekStart },
        action: { not: ModerationAction.POOL_DISTRIBUTION },
      },
      _count: { _all: true },
    }),
  ]);

  const actionCounts = new Map<string, number>();
  for (const row of resolvedReports) {
    if (!row.moderatorId) continue;
    actionCounts.set(row.moderatorId, (actionCounts.get(row.moderatorId) ?? 0) + row._count._all);
  }
  for (const row of moderationLogs) {
    actionCounts.set(row.moderatorId, (actionCounts.get(row.moderatorId) ?? 0) + row._count._all);
  }

  if (actionCounts.size === 0) {
    logger.info('mod pool has balance but no active moderators this week, skipping');
    return { distributed: 0, recipients: 0 };
  }

  const totalActions = Array.from(actionCounts.values()).reduce((sum, count) => sum + count, 0);
  const weekKey = weekStart.toISOString().slice(0, 10);

  const recipients: { userId: string; share: number }[] = [];
  for (const [moderatorId, count] of actionCounts) {
    const share = Math.floor((poolBalance * count) / totalActions);
    if (share <= 0) continue;

    const ledger = await awardTokens({
      userId: moderatorId,
      type: 'EARN',
      amount: share,
      reason: 'Weekly moderation pool distribution',
      sourceType: 'MOD_POOL',
      sourceId: weekKey,
      idempotencyKey: `mod-pool-distribution:${weekKey}:${moderatorId}`,
    });

    recipients.push({ userId: moderatorId, share: ledger.amount });
  }

  const distributed = recipients.reduce((sum, recipient) => sum + recipient.share, 0);

  await prisma.$transaction([
    prisma.moderationLog.create({
      data: {
        action: ModerationAction.POOL_DISTRIBUTION,
        moderatorId: recipients[0]?.userId ?? 'system',
        targetType: 'MOD_POOL',
        targetId: weekKey,
        reason: `Weekly pool distribution for week ${weekKey}`,
        metadata: {
          poolBalance,
          distributed,
          recipients: recipients.map((recipient) => ({
            userId: recipient.userId,
            share: recipient.share,
          })),
        },
      },
    }),
    prisma.modPool.update({
      where: { id: POOL_ID },
      data: { balance: Math.max(0, poolBalance - distributed) },
    }),
  ]);

  logger.info({ poolBalance, distributed, recipients: recipients.length }, 'mod pool distributed');

  return { distributed, recipients: recipients.length };
}
