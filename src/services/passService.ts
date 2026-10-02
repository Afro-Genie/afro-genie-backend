import { PassType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { ApiError } from '../middleware/errorHandler';
import { REWARD_CONFIG } from '../config/rewards';
import { spendTokens } from './tokenService';

// ---------------------------------------------------------------------------
// Premium passes (Phase 2).
//
// Passes are bought with GT (not real money). The GT debit goes through the
// normal ledger via spendTokens(), so the balance is validated atomically and
// the SSE balance stream fires automatically. A pass row is created first, then
// the GT is spent keyed by the pass id; if the spend fails (insufficient
// balance) the pass row is rolled back.
// ---------------------------------------------------------------------------

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const PACK_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

export const isPassType = (value: unknown): value is PassType =>
  Object.prototype.hasOwnProperty.call(REWARD_CONFIG.PREMIUM_PASS_COSTS, value as string);

export interface PassCatalogEntry {
  type: PassType;
  gtCost: number;
  label: string;
}

/** Public catalog of purchasable passes (type, GT cost, display label). */
export function getPassCatalog(): PassCatalogEntry[] {
  return (Object.keys(REWARD_CONFIG.PREMIUM_PASS_COSTS) as PassType[]).map((type) => ({
    type,
    gtCost: REWARD_CONFIG.PREMIUM_PASS_COSTS[type],
    label: REWARD_CONFIG.PREMIUM_PASS_LABELS[type],
  }));
}

const expiryFor = (type: PassType): Date => {
  const now = Date.now();
  return new Date(now + (type === PassType.SEVEN_DAY_PREMIUM ? SEVEN_DAYS_MS : PACK_VALIDITY_MS));
};

export interface PurchasePassResult {
  passId: string;
  type: PassType;
  label: string;
  expiresAt: Date;
  newBalance: number;
  translationCredits: number;
}

export async function purchasePass(userId: string, passType: PassType): Promise<PurchasePassResult> {
  if (!isPassType(passType)) {
    throw new ApiError('Unknown pass type', 'VALIDATION_ERROR', 400);
  }

  const gtCost = REWARD_CONFIG.PREMIUM_PASS_COSTS[passType];
  const label = REWARD_CONFIG.PREMIUM_PASS_LABELS[passType];
  const credits = REWARD_CONFIG.PREMIUM_PASS_TRANSLATION_CREDITS[passType];
  const expiresAt = expiryFor(passType);

  const pass = await prisma.premiumPass.create({
    data: { userId, type: passType, gtCost, expiresAt, active: true },
  });

  try {
    const ledger = await spendTokens({
      userId,
      amount: -gtCost,
      reason: `Premium pass: ${label}`,
      sourceType: 'PREMIUM_PASS',
      sourceId: pass.id,
      idempotencyKey: `premium-pass:${pass.id}`,
      metadata: { passType },
    });

    // Grant the pack's translation credits once the GT debit has committed.
    if (credits > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: { translationCredits: { increment: credits } },
      }).catch(async (err) => {
        // Roll back the pass AND the GT debit if crediting fails, to keep the
        // ledger and the credit balance consistent.
        logger.error({ err, userId, passId: pass.id, passType }, 'Failed to grant translation credits; rolling back pass');
        await spendTokens({
          userId,
          amount: gtCost,
          reason: `Refund: ${label}`,
          sourceType: 'PREMIUM_PASS',
          sourceId: `refund-${pass.id}`,
          idempotencyKey: `premium-pass-refund:${pass.id}`,
          metadata: { passType },
        }).catch(() => undefined);
        await prisma.premiumPass.delete({ where: { id: pass.id } }).catch(() => undefined);
        throw err;
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { translationCredits: true },
    }).catch(() => null);

    logger.info({ userId, passId: pass.id, passType, gtCost, credits }, 'Premium pass purchased');

    return {
      passId: pass.id,
      type: passType,
      label,
      expiresAt,
      newBalance: ledger.balanceAfter,
      translationCredits: user?.translationCredits ?? 0,
    };
  } catch (err) {
    await prisma.premiumPass.delete({ where: { id: pass.id } }).catch(() => undefined);
    throw err;
  }
}

/**
 * The user's active PREMIUM pass, or null.
 *
 * The `type` filter is load-bearing, not tidiness. Translation packs live in the
 * same PremiumPass table, so an unfiltered `findFirst` on `active: true` returns
 * a TRANSLATION_PACK row whenever the user bought the cheaper (50 GT) pack. The
 * caller then renders — and any entitlement check later built on this reads —
 * a year-long "premium pass" that the user paid 50 GT for, instead of the
 * 200 GT seven-day entitlement. Translation packs are consumable credit
 * balances (User.translationCredits), not entitlements, so they must never be
 * returned here.
 */
export async function getActivePass(userId: string) {
  return prisma.premiumPass.findFirst({
    where: {
      userId,
      type: PassType.SEVEN_DAY_PREMIUM,
      active: true,
      expiresAt: { gt: new Date() },
    },
    orderBy: { expiresAt: 'desc' },
  });
}

/** Any still-active pass row, including packs. For history/display only. */
export async function getAnyActivePass(userId: string) {
  return prisma.premiumPass.findFirst({
    where: { userId, active: true, expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: 'desc' },
  });
}

export async function listPasses(userId: string) {
  return prisma.premiumPass.findMany({
    where: { userId },
    orderBy: { purchasedAt: 'desc' },
    take: 20,
  });
}

/**
 * Deactivate passes whose expiry has elapsed. Runs hourly via BullMQ; also
 * idempotent/safe to call manually.
 */
export async function revokeExpiredPasses(): Promise<number> {
  const result = await prisma.premiumPass.updateMany({
    where: { active: true, expiresAt: { lt: new Date() } },
    data: { active: false },
  });

  if (result.count > 0) {
    logger.info({ revoked: result.count }, 'Expired premium passes revoked');
  }

  return result.count;
}
