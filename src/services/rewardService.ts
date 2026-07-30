import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { rewardQueue } from '../lib/queue';
import { logger } from '../lib/logger';

const TOKEN_CACHE_TTL = 3600;
const LEADERBOARD_CACHE_TTL = 900;
const TOKEN_BALANCE_PREFIX = 'user:tokens:';
const LEADERBOARD_PREFIX = 'leaderboard:';
const LEADERBOARD_ZSET = 'leaderboard:zset';

interface LeaderboardEntry {
  userId: string;
  totalTokens: number;
}

type LeaderboardPeriod = 'all' | 'week' | 'month';

const PERIOD_WINDOW: Record<Exclude<LeaderboardPeriod, 'all'>, number> = {
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

async function safeRedisOp<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err, label }, `Redis ${label} failed — using fallback`);
    return fallback;
  }
}

function logMetric(event: string, data: Record<string, unknown>) {
  logger.info({ metric: event, ...data }, `metric:${event}`);
}

export async function creditTokens(userId: string, amount: number, reason: string, idempotencyKey?: string): Promise<string> {
  const reward = await prisma.tokenReward.create({
    data: { userId, amount, reason, idempotencyKey },
    select: { id: true },
  });

  const key = `${TOKEN_BALANCE_PREFIX}${userId}`;
  await safeRedisOp('incrby', () => redis.incrby(key, amount), undefined);
  await safeRedisOp('expire', () => redis.expire(key, TOKEN_CACHE_TTL), undefined);

  await safeRedisOp('zincrby', () => redis.zincrby(LEADERBOARD_ZSET, amount, userId), undefined);

  await safeRedisOp('del leaderboards', () => redis.del(`${LEADERBOARD_PREFIX}all`, `${LEADERBOARD_PREFIX}week`, `${LEADERBOARD_PREFIX}month`), undefined);

  logMetric('tokens_credited', { rewardId: reward.id, userId, amount, reason, idempotencyKey });

  return reward.id;
}

export async function dedupeCreditTokens(
  idempotencyKey: string,
  userId: string,
  amount: number,
  reason: string,
): Promise<boolean> {
  try {
    await creditTokens(userId, amount, reason, idempotencyKey);
    return true;
  } catch (err: any) {
    if (err?.code === 'P2002' && err?.meta?.target?.includes('idempotencyKey')) {
      logMetric('reward_dedup_blocked', { userId, reason, idempotencyKey });
      return false;
    }
    throw err;
  }
}

export async function getUserTokenBalance(userId: string): Promise<number> {
  const key = `${TOKEN_BALANCE_PREFIX}${userId}`;
  const cached = await safeRedisOp('get balance', () => redis.get(key), null);

  if (cached !== null) {
    return parseInt(cached, 10);
  }

  const result = await prisma.tokenReward.aggregate({
    _sum: { amount: true },
    where: { userId },
  });

  const balance = result._sum.amount ?? 0;

  await safeRedisOp('set balance', () => redis.set(key, balance.toString(), 'EX', TOKEN_CACHE_TTL), undefined);

  return balance;
}

export async function getUserTokenHistory(userId: string, page = 1, limit = 20) {
  const skip = (page - 1) * limit;

  const [rewards, total] = await Promise.all([
    prisma.tokenReward.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        amount: true,
        reason: true,
        createdAt: true,
      },
    }),
    prisma.tokenReward.count({ where: { userId } }),
  ]);

  return {
    rewards,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

function leaderboardCacheKey(period: LeaderboardPeriod): string {
  return `${LEADERBOARD_PREFIX}${period}`;
}

async function fetchLeaderboardFromZset(): Promise<LeaderboardEntry[]> {
  const raw = await safeRedisOp<(string | null)[] | null>(
    'zrevrange',
    () => redis.zrevrange(LEADERBOARD_ZSET, 0, 19, 'WITHSCORES'),
    null,
  );
  if (!raw || raw.length === 0) return [];
  const entries: LeaderboardEntry[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const userId = raw[i];
    const score = parseInt(raw[i + 1] ?? '0', 10);
    if (userId) entries.push({ userId, totalTokens: score });
  }
  return entries;
}

async function fetchLeaderboardFromDb(where?: Record<string, unknown>): Promise<LeaderboardEntry[]> {
  const results = await prisma.tokenReward.groupBy({
    by: ['userId'],
    _sum: { amount: true },
    orderBy: { _sum: { amount: 'desc' } },
    take: 20,
    ...(where ? { where } : {}),
  });
  return results.map((r) => ({ userId: r.userId, totalTokens: r._sum.amount ?? 0 }));
}

async function warmLeaderboardZset(): Promise<void> {
  const entries = await fetchLeaderboardFromDb();
  if (entries.length === 0) return;
  const pipeline = redis.pipeline();
  for (const e of entries) {
    pipeline.zadd(LEADERBOARD_ZSET, e.totalTokens, e.userId);
  }
  await safeRedisOp('pipeline exec', () => pipeline.exec(), undefined);
}

async function buildLeaderboardResponse(period: LeaderboardPeriod): Promise<unknown[]> {
  let entries: LeaderboardEntry[];

  if (period === 'all') {
    entries = await fetchLeaderboardFromZset();
    if (entries.length === 0) {
      entries = await fetchLeaderboardFromDb();
      await warmLeaderboardZset();
    }
  } else {
    entries = await fetchLeaderboardFromDb({ createdAt: { gte: new Date(Date.now() - PERIOD_WINDOW[period]) } });
  }

  const userIds = entries.map((e) => e.userId);
  const [users, artists, rewardCounts] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, displayName: true, photoUrl: true },
    }),
    prisma.artist.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, name: true },
    }),
    prisma.tokenReward.groupBy({
      by: ['userId'],
      _count: { id: true },
      where: { userId: { in: userIds } },
    }),
  ]);

  const userMap = new Map(users.map((u) => [u.id, u]));
  const artistMap = new Map(artists.filter((a) => a.userId).map((a) => [a.userId!, a.name]));
  const rewardCountMap = new Map(rewardCounts.map((r) => [r.userId, r._count.id]));

  return entries.map((entry, index) => ({
    rank: index + 1,
    userId: entry.userId,
    displayName: userMap.get(entry.userId)?.displayName ?? 'Anonymous',
    photoUrl: userMap.get(entry.userId)?.photoUrl ?? null,
    artistName: artistMap.get(entry.userId) ?? null,
    totalTokens: entry.totalTokens,
    rewardCount: rewardCountMap.get(entry.userId) ?? 0,
  }));
}

export async function getLeaderboard(period: LeaderboardPeriod = 'all') {
  const cacheKey = leaderboardCacheKey(period);
  const cached = await safeRedisOp('get leaderboard', () => redis.get(cacheKey), null);
  if (cached) {
    return JSON.parse(cached);
  }

  const leaderboard = await buildLeaderboardResponse(period);

  await safeRedisOp('set leaderboard', () => redis.set(cacheKey, JSON.stringify(leaderboard), 'EX', LEADERBOARD_CACHE_TTL), undefined);

  logMetric('leaderboard_served', { period, entries: leaderboard.length });

  return leaderboard;
}

export async function getUserRank(userId: string, period: LeaderboardPeriod = 'all') {
  if (period === 'all') {
    const score = await safeRedisOp('zscore', () => redis.zscore(LEADERBOARD_ZSET, userId), null);
    if (score !== null) {
      const rank = await safeRedisOp('zrevrank', () => redis.zrevrank(LEADERBOARD_ZSET, userId), null);
      const rewardCount = await prisma.tokenReward.count({ where: { userId } });
      return {
        rank: rank !== null ? rank + 1 : null,
        totalTokens: parseInt(score, 10),
        rewardCount,
      };
    }
  }

  const where: Record<string, unknown> = period !== 'all'
    ? { createdAt: { gte: new Date(Date.now() - PERIOD_WINDOW[period]) } }
    : {};

  const userTotal = await prisma.tokenReward.aggregate({
    _sum: { amount: true },
    _count: { id: true },
    where: { userId, ...where },
  });

  const totalTokens = userTotal._sum.amount ?? 0;
  const rewardCount = userTotal._count.id;

  if (rewardCount === 0) {
    return { rank: null, totalTokens: 0, rewardCount: 0 };
  }

  // Count how many users have a higher total than this user
  const allTotals = await prisma.tokenReward.groupBy({
    by: ['userId'],
    _sum: { amount: true },
    where,
    orderBy: { _sum: { amount: 'desc' } },
  });

  const rank = allTotals.findIndex((e) => e.userId === userId) + 1;

  return {
    rank: rank || null,
    totalTokens,
    rewardCount,
  };
}

export async function getRewardQueueStats() {
  try {
    const [waiting, active, completed, failed] = await Promise.all([
      rewardQueue.getWaitingCount(),
      rewardQueue.getActiveCount(),
      rewardQueue.getCompletedCount(),
      rewardQueue.getFailedCount(),
    ]);

    return { waiting, active, completed, failed, status: 'ok' as const };
  } catch (err) {
    logger.warn({ err }, 'Failed to get reward queue stats');
    return { waiting: 0, active: 0, completed: 0, failed: 0, status: 'error' as const };
  }
}

export async function queueReward(
  userId: string,
  amount: number,
  reason: string,
  event?: string,
  idempotencyKey?: string,
): Promise<void> {
  await rewardQueue.add(`${reason.toLowerCase().replace(/\s+/g, '-')}`, {
    userId,
    amount,
    reason,
    event,
    idempotencyKey,
  });
  logMetric('reward_queued', { userId, amount, reason });
}
