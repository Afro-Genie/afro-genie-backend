import { createHash } from 'node:crypto';
import { Prisma, TokenTransactionType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ApiError } from '../middleware/errorHandler';

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

  try {
    return await prisma.$transaction(async (tx) => {
      const wallet = await tx.userWallet.upsert({
        where: { userId: params.userId },
        update: {},
        create: { userId: params.userId, balance: 0, version: 1 },
      });

      const balanceAfter = wallet.balance + params.amount;

      if (opts.requireSufficientBalance && balanceAfter < 0) {
        throw new ApiError('Insufficient token balance', 'INSUFFICIENT_FUNDS', 400);
      }

      const ledger = await tx.tokenLedger.create({
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

      return ledger;
    });
  } catch (err) {
    // Concurrent duplicate award: the unique idempotencyKey already won elsewhere.
    if (isUniqueViolation(err)) {
      const duplicate = await prisma.tokenLedger.findUnique({ where: { idempotencyKey } });
      if (duplicate) return duplicate;
    }
    throw err;
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

export async function getBalance(userId: string): Promise<number> {
  const wallet = await prisma.userWallet.findUnique({ where: { userId } });
  return wallet?.balance ?? 0;
}

export async function getLedger(userId: string, page = 1, limit = 20) {
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(50, Math.max(1, limit));

  const [rewards, total] = await Promise.all([
    prisma.tokenLedger.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    }),
    prisma.tokenLedger.count({ where: { userId } }),
  ]);

  return {
    rewards,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    },
  };
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
