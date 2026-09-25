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
}

export async function purchasePass(userId: string, passType: PassType): Promise<PurchasePassResult> {
  if (!isPassType(passType)) {
    throw new ApiError('Unknown pass type', 'VALIDATION_ERROR', 400);
  }

  const gtCost = REWARD_CONFIG.PREMIUM_PASS_COSTS[passType];
  const label = REWARD_CONFIG.PREMIUM_PASS_LABELS[passType];
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

    logger.info({ userId, passId: pass.id, passType, gtCost }, 'Premium pass purchased');

    return {
      passId: pass.id,
      type: passType,
      label,
      expiresAt,
      newBalance: ledger.balanceAfter,
    };
  } catch (err) {
    await prisma.premiumPass.delete({ where: { id: pass.id } }).catch(() => undefined);
    throw err;
  }
}

export async function getActivePass(userId: string) {
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
