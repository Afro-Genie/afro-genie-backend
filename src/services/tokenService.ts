import { createHash } from 'node:crypto';
import { Prisma, TokenTransactionType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { ApiError } from '../middleware/errorHandler';
import { sendBalanceUpdate } from '../lib/balanceSse';

// ---------------------------------------------------------------------------
// Token ledger core (Phase 1).
//
// Tokens live in an append-only TokenLedger. The current balance is cached on
// UserWallet.balance and updated atomically inside the same transaction that
// writes the ledger row. Every award is idempotent via a unique
// idempotencyKey: retried BullMQ jobs / replayed events can never double-award.
// ---------------------------------------------------------------------------

export interface TokenTransactionParams {
  userId: string;
  type: TokenTransactionType;
  /** signed: +earn / -spend / -penalty / -tax */
  amount: number;
  reason: string;
  sourceType?: string;
  sourceId?: string;
  /** explicit key wins over the derived sourceType:sourceId key */
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

const buildIdempotencyKey = (
  sourceType?: string,
  sourceId?: string,
  custom?: string,
): string => {
  if (custom) return custom;
  if (sourceType && sourceId) {
    return createHash('sha256').update(`${sourceType}:${sourceId}`).digest('hex');
  }
  return createHash('sha256')
    .update(`${Date.now()}:${Math.random().toString(36).slice(2)}`)
    .digest('hex');
};

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** Which unique index a P2002 tripped. Postgres reports the index columns. */
const uniqueViolationTarget = (err: unknown): string => {
  if (!isUniqueViolation(err)) return '';
  const target = (err as Prisma.PrismaClientKnownRequestError).meta?.target;
  if (Array.isArray(target)) return target.join(',');
  if (typeof target === 'string') return target;
  return '';
};

// Ledger summary is cached for 5 minutes; invalidated on every committed
// ledger write so the header cards never go stale for long.
const LEDGER_SUMMARY_CACHE_TTL = 5 * 60;
const ledgerSummaryCacheKey = (userId: string) => `economy:ledger-summary:${userId}`;

export async function invalidateLedgerSummaryCache(userId: string): Promise<void> {
  try {
    await redis.del(ledgerSummaryCacheKey(userId));
  } catch (err) {
    logger.warn({ err, userId }, 'ledger summary cache invalidation failed');
  }
}

/**
 * How many times to re-run the transaction after losing a unique-constraint race
 * that is NOT the ledger's idempotencyKey.
 *
 * `UserWallet.userId` is unique and the row is created by an upsert, so two
 * transactions for the same user that both see "no wallet" will both try to
 * INSERT it: one commits, the other gets P2002 on userId. Before this retry the
 * loser rethrew, which surfaced as a 500 on a legitimately successful payment —
 * reachable the moment a client verify and the Paystack webhook race on the same
 * wallet. Two attempts is enough for the realistic fan-in; three gives headroom
 * without turning a hot row into a retry storm.
 */
const UNIQUE_CONFLICT_RETRIES = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function applyTransaction(
  params: TokenTransactionParams,
  opts: { requireSufficientBalance?: boolean } = {},
) {
  const idempotencyKey = buildIdempotencyKey(
    params.sourceType,
    params.sourceId,
    params.idempotencyKey,
  );

  const existing = await prisma.tokenLedger.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const ledger = await prisma.$transaction(async (tx) => {
        const wallet = await tx.userWallet.upsert({
          where: { userId: params.userId },
          update: {},
          create: { userId: params.userId, balance: 0, version: 1 },
        });

        const balanceAfter = wallet.balance + params.amount;

        if (opts.requireSufficientBalance && balanceAfter < 0) {
          throw new ApiError('Insufficient token balance', 'INSUFFICIENT_FUNDS', 400);
        }

        const entry = await tx.tokenLedger.create({
          data: {
            userId: params.userId,
            type: params.type,
            amount: params.amount,
            balanceAfter,
            reason: params.reason,
            sourceType: params.sourceType ?? null,
            sourceId: params.sourceId ?? null,
            idempotencyKey,
            metadata: params.metadata as Prisma.InputJsonValue | undefined,
          },
        });

        await tx.userWallet.update({
          where: { id: wallet.id },
          data: { balance: balanceAfter, version: { increment: 1 } },
        });

        return { ...entry, balanceAfter };
      });

      // Live balance push — non-blocking. Open SSE streams under
      // GET /api/users/me/balance/stream pick this up instantly.
      sendBalanceUpdate(params.userId, {
        balance: ledger.balanceAfter,
        delta: params.amount,
        type: params.type,
        reason: params.reason,
        timestamp: ledger.createdAt.toISOString(),
      });

      // Invalidate the cached ledger summary (fires on every ledger write).
      await invalidateLedgerSummaryCache(params.userId);

      // Invalidate the store's balance cache (user:tokens:). Readers refill
      // from UserWallet on the next purchase check; blind INCRBY/DECRBY here
      // would double-count against concurrent writers.
      try {
        await redis.del(`user:tokens:${params.userId}`);
      } catch (err) {
        logger.warn({ err, userId: params.userId }, 'balance cache invalidation failed');
      }

      return ledger;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;

      // The winner of the idempotency race already recorded this credit. Return
      // their row so callers observe a stable balanceAfter instead of an error.
      if (uniqueViolationTarget(err).includes('idempotencyKey')) {
        const duplicate = await prisma.tokenLedger.findUnique({ where: { idempotencyKey } });
        if (duplicate) return duplicate;
      }

      // Some other unique index (today: UserWallet.userId from a concurrent
      // upsert) blocked us. Re-read our own key to be sure it wasn't a duplicate
      // credit, then retry now that the conflicting row exists.
      const maybeDuplicate = await prisma.tokenLedger.findUnique({ where: { idempotencyKey } });
      if (maybeDuplicate) return maybeDuplicate;

      if (attempt >= UNIQUE_CONFLICT_RETRIES) throw err;

      logger.warn(
        { userId: params.userId, attempt, target: uniqueViolationTarget(err) },
        'Ledger transaction lost a unique-constraint race; retrying',
      );
      await sleep(10 * (attempt + 1));
    }
  }
}

/** EARN-style credit. Positive amount. */
export function awardTokens(params: TokenTransactionParams) {
  return applyTransaction(params);
}

/** SPEND-style debit. Validates the user has enough balance. Negative amount. */
export function spendTokens(params: Omit<TokenTransactionParams, 'type'>) {
  if (params.amount >= 0) {
    throw new ApiError('Spend amount must be negative', 'VALIDATION_ERROR', 400);
  }
  return applyTransaction({ ...params, type: 'SPEND' }, { requireSufficientBalance: true });
}

/** PENALTY-style debit. Negative amount. */
export function penalizeTokens(params: Omit<TokenTransactionParams, 'type'>) {
  if (params.amount >= 0) {
    throw new ApiError('Penalty amount must be negative', 'VALIDATION_ERROR', 400);
  }
  return applyTransaction({ ...params, type: 'PENALTY' }, { requireSufficientBalance: true });
}

/**
 * PENALTY-style debit that may take a wallet negative. Used for governance
 * penalties (e.g. overturned approvals) where the penalty must be recorded
 * even if the moderator already spent their balance.
 */
export function forcePenalizeTokens(params: Omit<TokenTransactionParams, 'type'>) {
  if (params.amount >= 0) {
    throw new ApiError('Penalty amount must be negative', 'VALIDATION_ERROR', 400);
  }
  return applyTransaction({ ...params, type: 'PENALTY' });
}

/** TAX-style debit (moderator pool contribution). Negative amount. */
export function applyTax(params: Omit<TokenTransactionParams, 'type'>) {
  if (params.amount >= 0) {
    throw new ApiError('Tax amount must be negative', 'VALIDATION_ERROR', 400);
  }
  return applyTransaction({ ...params, type: 'TAX' }, { requireSufficientBalance: true });
}

/** TAX-style clawback that may take a wallet negative (overturned rewards). */
export function clawbackTokens(params: Omit<TokenTransactionParams, 'type'>) {
  if (params.amount >= 0) {
    throw new ApiError('Clawback amount must be negative', 'VALIDATION_ERROR', 400);
  }
  return applyTransaction({ ...params, type: 'TAX' });
}

/** ADMIN_ADJUST credit/debit. Amount may be positive or negative. */
export function adjustTokens(params: Omit<TokenTransactionParams, 'type'>) {
  if (params.amount === 0) {
    throw new ApiError('Adjustment amount cannot be zero', 'VALIDATION_ERROR', 400);
  }
  return applyTransaction({ ...params, type: 'ADMIN_ADJUST' });
}

/**
 * REFUND credit — returns GT the user already spent. Positive amount, never
 * balance-constrained (a refund can only raise the balance). The caller must
 * pass a deterministic idempotencyKey (or sourceType+sourceId) so a retried
 * refund can never credit twice.
 */
export function refundTokens(params: Omit<TokenTransactionParams, 'type'>) {
  if (params.amount <= 0) {
    throw new ApiError('Refund amount must be positive', 'VALIDATION_ERROR', 400);
  }
  return applyTransaction({ ...params, type: 'REFUND' });
}

export async function getBalance(userId: string): Promise<number> {
  const wallet = await prisma.userWallet.findUnique({ where: { userId } });
  return wallet?.balance ?? 0;
}

export async function getLedger(userId: string, page = 1, limit = 20, type?: string) {
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(50, Math.max(1, limit));

  const where: Prisma.TokenLedgerWhereInput = {
    userId,
    ...(type ? { type: type as TokenTransactionType } : {}),
  };

  const [rewards, total] = await Promise.all([
    prisma.tokenLedger.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    }),
    prisma.tokenLedger.count({ where }),
  ]);

  const summary = await getLedgerSummary(userId, type);

  return {
    rewards,
    summary,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    },
  };
}

/**
 * Earned / spent / penalized totals over the user's full ledger (optionally
 * filtered by transaction type). Powers the GT history header cards. The
 * unfiltered summary is cached in Redis for 5 minutes (invalidated on every
 * ledger write); filtered summaries are always computed fresh.
 */
export async function getLedgerSummary(userId: string, type?: string) {
  const cacheable = !type;

  if (cacheable) {
    try {
      const cached = await redis.get(ledgerSummaryCacheKey(userId));
      if (cached) {
        try {
          return JSON.parse(cached) as ReturnType<typeof computeSummary>;
        } catch (err) {
          logger.warn({ err }, 'Cached ledger summary is corrupt — recomputing');
        }
      }
    } catch (err) {
      logger.warn({ err, userId }, 'ledger summary cache read failed');
    }
  }

  const summary = await computeSummary(userId, type);

  if (cacheable) {
    try {
      await redis.set(ledgerSummaryCacheKey(userId), JSON.stringify(summary), 'EX', LEDGER_SUMMARY_CACHE_TTL);
    } catch (err) {
      logger.warn({ err, userId }, 'ledger summary cache write failed');
    }
  }

  return summary;
}

async function computeSummary(userId: string, type?: string) {
  const where: Prisma.TokenLedgerWhereInput = {
    userId,
    ...(type ? { type: type as TokenTransactionType } : {}),
  };

  const rows = await prisma.tokenLedger.groupBy({
    by: ['type'],
    _sum: { amount: true },
    where,
  });

  const byType = new Map(rows.map((r) => [r.type, r._sum.amount ?? 0]));

  return {
    earned: byType.get('EARN') ?? 0,
    spent: byType.get('SPEND') ?? 0,
    penalized: (byType.get('PENALTY') ?? 0) + (byType.get('TAX') ?? 0),
    adjusted: byType.get('ADMIN_ADJUST') ?? 0,
    refunded: byType.get('REFUND') ?? 0,
  } as const;
}

export async function getProfile(userId: string) {
  const [user, wallet, badges, tier, streak] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, displayName: true, photoUrl: true, role: true, createdAt: true },
    }),
    prisma.userWallet.findUnique({ where: { userId } }),
    prisma.userBadge.findMany({
      where: { userId },
      orderBy: { earnedAt: 'desc' },
    }),
    prisma.userTier.findUnique({ where: { userId } }),
    prisma.userStreak.findUnique({ where: { userId } }),
  ]);

  if (!user) {
    throw new ApiError('User not found', 'NOT_FOUND', 404);
  }

  return {
    id: user.id,
    displayName: user.displayName,
    photoUrl: user.photoUrl,
    role: user.role,
    tokenBalance: wallet?.balance ?? 0,
    badges,
    memberSince: user.createdAt,
    tier: tier
      ? { tier: tier.tier, multiplier: tier.multiplier, approvedCount: tier.approvedCount }
      : null,
    streak: streak
      ? { current: streak.currentStreak, longest: streak.longestStreak }
      : null,
  };
}
