import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { ApiError } from '../middleware/errorHandler';
import { sendBalanceUpdate } from '../lib/balanceSse';
import { invalidateLedgerSummaryCache, refundTokens } from './tokenService';

const BALANCE_PREFIX = 'user:tokens:';
const BALANCE_TTL = 3600;
const LEADERBOARD_ZSET = 'leaderboard:zset';

async function safeRedisOp<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

export interface StoreItemResponse {
  id: string;
  name: string;
  description: string | null;
  tokenCost: number;
  category: string;
  metadata: unknown;
  active: boolean;
  featured: boolean;
  limitedTime: boolean;
  originalPrice: number | null;
  discountedPrice: number | null;
  discountPercent: number | null;
  promoStartsAt: Date | null;
  promoEndsAt: Date | null;
  sortOrder: number;
  stock: number | null;
}

export interface StoreItemFilters {
  featured?: boolean;
  limited?: boolean;
}

const STORE_ITEM_SELECT = {
  id: true,
  name: true,
  description: true,
  tokenCost: true,
  category: true,
  metadata: true,
  active: true,
  featured: true,
  limitedTime: true,
  originalPrice: true,
  discountedPrice: true,
  discountPercent: true,
  promoStartsAt: true,
  promoEndsAt: true,
  sortOrder: true,
  stock: true,
} as const;

/**
 * Price actually charged: the discounted price while a promo window is active,
 * otherwise the base token cost.
 */
export function effectiveTokenCost(item: {
  tokenCost: number;
  discountedPrice: number | null;
  promoStartsAt: Date | null;
  promoEndsAt: Date | null;
}): number {
  const now = new Date();
  const started = !item.promoStartsAt || item.promoStartsAt <= now;
  const notEnded = !item.promoEndsAt || item.promoEndsAt > now;
  if (item.discountedPrice != null && started && notEnded) {
    return item.discountedPrice;
  }
  return item.tokenCost;
}

export async function getStoreItems(filters: StoreItemFilters = {}): Promise<StoreItemResponse[]> {
  return prisma.storeItem.findMany({
    where: {
      active: true,
      ...(filters.featured ? { featured: true } : {}),
      ...(filters.limited ? { limitedTime: true, promoEndsAt: { gt: new Date() } } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { tokenCost: 'asc' }],
    select: STORE_ITEM_SELECT,
  });
}

/** Featured items for the store hero carousel. */
export async function getFeaturedItems(): Promise<StoreItemResponse[]> {
  return prisma.storeItem.findMany({
    where: { active: true, featured: true },
    orderBy: [{ sortOrder: 'asc' }, { tokenCost: 'asc' }],
    select: STORE_ITEM_SELECT,
  });
}

export interface LimitedTimeOffer extends StoreItemResponse {
  timeRemainingMs: number;
}

/** Items with an active limited-time promo window, with a countdown. */
export async function getLimitedTimeOffers(): Promise<LimitedTimeOffer[]> {
  const now = new Date();
  const items = await prisma.storeItem.findMany({
    where: { active: true, limitedTime: true, promoEndsAt: { gt: now } },
    orderBy: [{ sortOrder: 'asc' }, { promoEndsAt: 'asc' }],
    select: STORE_ITEM_SELECT,
  });

  return items.map((item) => ({
    ...item,
    timeRemainingMs: item.promoEndsAt ? item.promoEndsAt.getTime() - now.getTime() : 0,
  }));
}

/**
 * Admin helper: put an item on sale. Keeps `tokenCost` intact and records the
 * original price so the discount can be reverted later.
 */
export async function applyDiscount(
  itemId: string,
  discountPercent: number,
  promoEndsAt: Date | null,
): Promise<StoreItemResponse> {
  if (discountPercent < 1 || discountPercent > 99) {
    throw new ApiError('discountPercent must be between 1 and 99', 'VALIDATION_ERROR', 400);
  }

  const item = await prisma.storeItem.findUnique({ where: { id: itemId } });
  if (!item) {
    throw new ApiError('Store item not found', 'NOT_FOUND', 404);
  }

  const originalPrice = item.originalPrice ?? item.tokenCost;
  const discountedPrice = Math.max(1, Math.floor((originalPrice * (100 - discountPercent)) / 100));

  return prisma.storeItem.update({
    where: { id: itemId },
    data: {
      originalPrice,
      discountedPrice,
      discountPercent,
      limitedTime: true,
      promoStartsAt: new Date(),
      promoEndsAt,
    },
    select: STORE_ITEM_SELECT,
  });
}

/** Admin helper: clear an active promotion, restoring the base cost. */
export async function clearDiscount(itemId: string): Promise<StoreItemResponse> {
  const item = await prisma.storeItem.findUnique({ where: { id: itemId } });
  if (!item) {
    throw new ApiError('Store item not found', 'NOT_FOUND', 404);
  }

  return prisma.storeItem.update({
    where: { id: itemId },
    data: {
      limitedTime: false,
      originalPrice: null,
      discountedPrice: null,
      discountPercent: null,
      promoStartsAt: null,
      promoEndsAt: null,
    },
    select: STORE_ITEM_SELECT,
  });
}

export async function purchaseItem(userId: string, itemId: string): Promise<{ success: boolean; message: string }> {
  const item = await prisma.storeItem.findUnique({ where: { id: itemId } });
  if (!item || !item.active) {
    return { success: false, message: 'Item not found or unavailable' };
  }

  if (item.stock !== null && item.stock <= 0) {
    return { success: false, message: 'This item is sold out' };
  }

  const existing = await prisma.storePurchase.findFirst({
    where: { userId, itemId },
    select: { id: true },
  });
  if (existing) {
    return { success: false, message: 'You already own this item' };
  }

  // Price may be discounted while a promo window is active.
  const cost = effectiveTokenCost(item);

  // Check balance
  const balanceKey = `${BALANCE_PREFIX}${userId}`;
  let balance = await safeRedisOp('get', () => redis.get(balanceKey), null);
  if (balance === null) {
    const wallet = await prisma.userWallet.findUnique({ where: { userId } });
    balance = String(wallet?.balance ?? 0);
    await safeRedisOp('set', () => redis.set(balanceKey, balance!, 'EX', BALANCE_TTL), undefined);
  }

  if (parseInt(balance, 10) < cost) {
    return { success: false, message: `Insufficient tokens. You need ${cost} but have ${balance}` };
  }

  // Deduct tokens and record purchase atomically
  let committedBalanceAfter: number | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      const wallet = await tx.userWallet.upsert({
        where: { userId },
        update: {},
        create: { userId, balance: 0, version: 1 },
      });

      const balanceAfter = wallet.balance - cost;
      if (balanceAfter < 0) {
        throw new Error(`Insufficient tokens. You need ${cost} but have ${wallet.balance}`);
      }
      committedBalanceAfter = balanceAfter;

      // Reserve stock first (conditional decrement guards against over-selling).
      if (item.stock !== null) {
        const reserved = await tx.storeItem.updateMany({
          where: { id: itemId, stock: { gt: 0 } },
          data: { stock: { decrement: 1 } },
        });
        if (reserved.count === 0) {
          throw new Error('This item is sold out');
        }
      }

      await tx.tokenLedger.create({
        data: {
          userId,
          type: 'SPEND',
          amount: -cost,
          balanceAfter,
          reason: `Store purchase: ${item.name}`,
          idempotencyKey: `store-purchase:${userId}:${itemId}`,
        },
      });

      await tx.userWallet.update({
        where: { id: wallet.id },
        data: { balance: balanceAfter, version: { increment: 1 } },
      });

      await tx.storePurchase.create({
        data: { userId, itemId, spentAmount: cost },
      });
    });
  } catch (err) {
    logger.warn({ err, userId, itemId }, 'Store purchase failed');
    return { success: false, message: err instanceof Error ? err.message : 'Purchase failed' };
  }

  // Update Redis balance
  await safeRedisOp('decrby', () => redis.decrby(balanceKey, cost), undefined);

  // Update leaderboard ZSET
  await safeRedisOp('zincrby', () => redis.zincrby(LEADERBOARD_ZSET, -cost, userId), undefined);

  // Invalidate leaderboard
  await safeRedisOp('del leaderboards', () => redis.del('leaderboard:all', 'leaderboard:week', 'leaderboard:month'), undefined);

  logger.info({ userId, itemId, itemName: item.name, cost }, 'Store purchase completed');

  // Live balance push + summary-cache invalidation, matching the tokenService contract.
  if (committedBalanceAfter !== null) {
    sendBalanceUpdate(userId, {
      balance: committedBalanceAfter,
      delta: -cost,
      type: 'SPEND',
      reason: `Store purchase: ${item.name}`,
      timestamp: new Date().toISOString(),
    });
  }
  await invalidateLedgerSummaryCache(userId);

  return { success: true, message: `Successfully purchased ${item.name}` };
}

export async function getUserPurchases(userId: string) {
  return prisma.storePurchase.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      spentAmount: true,
      status: true,
      fulfilledAt: true,
      createdAt: true,
      item: {
        select: { id: true, name: true, description: true, category: true, metadata: true },
      },
    },
  });
}

export interface UserEntitlementResponse {
  id: string;
  type: string;
  metadata: unknown;
  grantedAt: Date;
}

/** Entitlements (store decorations, titles, passes) owned by a user. */
export async function getUserEntitlements(userId: string): Promise<UserEntitlementResponse[]> {
  return prisma.userEntitlement.findMany({
    where: { userId },
    orderBy: { grantedAt: 'desc' },
    select: { id: true, type: true, metadata: true, grantedAt: true },
  });
}

const readEntitlementType = (metadata: unknown): string | null => {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>).entitlementType;
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
};

/**
 * Marks a purchase FULFILLED, grants the item's entitlement (if it has one)
 * and notifies the buyer - all in one transaction so the reward, the status
 * and the notification can never drift apart.
 */
export async function fulfillPurchase(purchaseId: string) {
  const purchase = await prisma.$transaction(async (tx) => {
    const existing = await tx.storePurchase.findUnique({
      where: { id: purchaseId },
      select: { status: true },
    });
    if (!existing) {
      throw new ApiError('Purchase not found', 'NOT_FOUND', 404);
    }
    // Re-fulfilling is allowed (it repairs rows that were fulfilled before
    // entitlements existed) but must not re-notify the buyer.
    const alreadyFulfilled = existing.status === 'FULFILLED';

    const updated = await tx.storePurchase.update({
      where: { id: purchaseId },
      data: { status: 'FULFILLED', fulfilledAt: alreadyFulfilled ? undefined : new Date() },
      include: {
        item: { select: { id: true, name: true, category: true, metadata: true } },
        user: { select: { id: true } },
      },
    });

    const entitlementType = readEntitlementType(updated.item.metadata);
    if (entitlementType) {
      // Idempotent: re-fulfilling an already-granted purchase is a no-op.
      await tx.userEntitlement.upsert({
        where: { userId_type: { userId: updated.user.id, type: entitlementType } },
        update: {},
        create: {
          userId: updated.user.id,
          type: entitlementType,
          metadata: { itemName: updated.item.name, itemCategory: updated.item.category },
        },
      });
    }

    if (!alreadyFulfilled) {
      await tx.notification.create({
        data: {
          userId: updated.user.id,
          title: 'Purchase fulfilled',
          message: `Your purchase of ${updated.item.name} has been fulfilled!`,
          type: 'STORE',
        },
      });
    }

    return updated;
  });

  logger.info({ purchaseId, userId: purchase.user.id }, 'Store purchase fulfilled');

  return purchase;
}

export interface RefundPurchaseResult {
  purchase: {
    id: string;
    status: string;
    spentAmount: number;
    refundedAt: Date | null;
    userId: string;
    itemId: string;
  };
  refund: { ledgerId: string; amount: number; balanceAfter: number; idempotencyKey: string };
}

/**
 * Reverses a store purchase (GT plan item 9).
 *
 * Order matters: the GT credit goes first through `refundTokens`, which is
 * idempotent on `store-refund:<purchaseId>` — so a retried or concurrent
 * refund can never credit twice. The domain flip then runs as a conditional
 * update (`status != REFUNDED`); only the caller that wins that update
 * removes the entitlement, restores stock and notifies the buyer, so the
 * side effects happen exactly once.
 */
export async function refundPurchase(purchaseId: string, adminReason?: string): Promise<RefundPurchaseResult> {
  const purchase = await prisma.storePurchase.findUnique({
    where: { id: purchaseId },
    include: {
      item: { select: { id: true, name: true, category: true, metadata: true, stock: true } },
      user: { select: { id: true } },
    },
  });
  if (!purchase) {
    throw new ApiError('Purchase not found', 'NOT_FOUND', 404);
  }
  if (purchase.status === 'REFUNDED') {
    throw new ApiError('Purchase already refunded', 'CONFLICT', 409);
  }

  const userId = purchase.user.id;
  const amount = purchase.spentAmount;

  const ledger = await refundTokens({
    userId,
    amount,
    reason: `Refund: ${purchase.item.name}`,
    sourceType: 'STORE_REFUND',
    sourceId: purchase.id,
    idempotencyKey: `store-refund:${purchase.id}`,
    metadata: {
      purchaseId: purchase.id,
      itemId: purchase.item.id,
      ...(adminReason ? { adminReason } : {}),
    },
  });

  const winner = await prisma.$transaction(async (tx) => {
    const flipped = await tx.storePurchase.updateMany({
      where: { id: purchaseId, status: { not: 'REFUNDED' } },
      data: { status: 'REFUNDED', refundedAt: new Date() },
    });
    if (flipped.count === 0) {
      return false;
    }

    // Drop the decoration/title entitlement — unless another fulfilled
    // purchase still grants the same entitlement type.
    const entitlementType = readEntitlementType(purchase.item.metadata);
    if (entitlementType) {
      const stillOwned = await tx.storePurchase.count({
        where: {
          userId,
          id: { not: purchaseId },
          status: 'FULFILLED',
          item: { is: { metadata: { path: ['entitlementType'], equals: entitlementType } } },
        },
      });
      if (stillOwned === 0) {
        await tx.userEntitlement.deleteMany({ where: { userId, type: entitlementType } });
      }
    }

    if (purchase.item.stock !== null) {
      await tx.storeItem.update({
        where: { id: purchase.item.id },
        data: { stock: { increment: 1 } },
      });
    }

    await tx.notification.create({
      data: {
        userId,
        title: 'Purchase refunded',
        message: `Your purchase of ${purchase.item.name} has been refunded. ${amount} GT was returned to your balance.`,
        type: 'STORE',
      },
    });
    return true;
  });

  // Mirror of the post-commit Redis upkeep in purchaseItem (the inverse signs).
  // Only the caller that won the status flip adjusts them, so concurrent
  // refunds can't double-apply the Redis side effects either.
  if (winner) {
    await safeRedisOp('incrby', () => redis.incrby(`${BALANCE_PREFIX}${userId}`, amount), undefined);
    await safeRedisOp('zincrby', () => redis.zincrby(LEADERBOARD_ZSET, amount, userId), undefined);
    await safeRedisOp('del leaderboards', () => redis.del('leaderboard:all', 'leaderboard:week', 'leaderboard:month'), undefined);
  }

  const current = await prisma.storePurchase.findUnique({
    where: { id: purchaseId },
    select: { id: true, status: true, spentAmount: true, refundedAt: true, userId: true, itemId: true },
  });

  logger.info(
    { purchaseId, userId, amount, ledgerId: ledger.id, sideEffectsApplied: winner },
    'Store purchase refunded',
  );

  return {
    purchase: current!,
    refund: {
      ledgerId: ledger.id,
      amount,
      balanceAfter: ledger.balanceAfter,
      idempotencyKey: ledger.idempotencyKey,
    },
  };
}
