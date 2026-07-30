import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';

const BALANCE_PREFIX = 'user:tokens:';
const BALANCE_TTL = 3600;
const LEADERBOARD_ZSET = 'leaderboard:zset';

async function safeRedisOp<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

export interface StoreItemResponse {
  id: string;
  name: string;
  description: string;
  tokenCost: number;
  category: string;
  metadata: unknown;
  active: boolean;
}

export async function getStoreItems(): Promise<StoreItemResponse[]> {
  return prisma.storeItem.findMany({
    where: { active: true },
    orderBy: { tokenCost: 'asc' },
    select: {
      id: true,
      name: true,
      description: true,
      tokenCost: true,
      category: true,
      metadata: true,
      active: true,
    },
  });
}

export async function purchaseItem(userId: string, itemId: string): Promise<{ success: boolean; message: string }> {
  const item = await prisma.storeItem.findUnique({ where: { id: itemId } });
  if (!item || !item.active) {
    return { success: false, message: 'Item not found or unavailable' };
  }

  const existing = await prisma.storePurchase.findFirst({
    where: { userId, itemId },
    select: { id: true },
  });
  if (existing) {
    return { success: false, message: 'You already own this item' };
  }

  // Check balance
  const balanceKey = `${BALANCE_PREFIX}${userId}`;
  let balance = await safeRedisOp('get', () => redis.get(balanceKey), null);
  if (balance === null) {
    const result = await prisma.tokenReward.aggregate({ _sum: { amount: true }, where: { userId } });
    balance = String(result._sum.amount ?? 0);
    await safeRedisOp('set', () => redis.set(balanceKey, balance!, 'EX', BALANCE_TTL), undefined);
  }

  if (parseInt(balance, 10) < item.tokenCost) {
    return { success: false, message: `Insufficient tokens. You need ${item.tokenCost} but have ${balance}` };
  }

  // Deduct tokens and record purchase atomically
  await prisma.$transaction([
    prisma.tokenReward.create({
      data: { userId, amount: -item.tokenCost, reason: `Store purchase: ${item.name}` },
    }),
    prisma.storePurchase.create({
      data: { userId, itemId, spentAmount: item.tokenCost },
    }),
  ]);

  // Update Redis balance
  await safeRedisOp('decrby', () => redis.decrby(balanceKey, item.tokenCost), undefined);

  // Update leaderboard ZSET
  await safeRedisOp('zincrby', () => redis.zincrby(LEADERBOARD_ZSET, -item.tokenCost, userId), undefined);

  // Invalidate leaderboard
  await safeRedisOp('del leaderboards', () => redis.del('leaderboard:all', 'leaderboard:week', 'leaderboard:month'), undefined);

  logger.info({ userId, itemId, itemName: item.name, cost: item.tokenCost }, 'Store purchase completed');

  return { success: true, message: `Successfully purchased ${item.name}` };
}

export async function getUserPurchases(userId: string) {
  return prisma.storePurchase.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      spentAmount: true,
      createdAt: true,
      item: {
        select: { id: true, name: true, description: true, category: true, metadata: true },
      },
    },
  });
}
