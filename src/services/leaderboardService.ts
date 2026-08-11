import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

// ---------------------------------------------------------------------------
// Leaderboard service (Phase 1).
//
// Ranking is computed from the TokenLedger: "total earned" sums positive
// EARN + ADMIN_ADJUST amounts in the period; rewardCount counts those rows.
// Balance is server-computed only — the client never does local math.
// ---------------------------------------------------------------------------

export type LeaderboardPeriod = 'all' | 'week' | 'month';

export type LeaderboardScope = 'tokens' | 'quality';

const PERIOD_MS: Record<Exclude<LeaderboardPeriod, 'all'>, number> = {
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

export const isLeaderboardPeriod = (value: unknown): value is LeaderboardPeriod =>
  value === 'all' || value === 'week' || value === 'month';

export const isLeaderboardScope = (value: unknown): value is LeaderboardScope =>
  value === 'tokens' || value === 'quality';

const periodStart = (period: LeaderboardPeriod): Date => {
  if (period === 'all') return new Date(0);
  return new Date(Date.now() - PERIOD_MS[period]);
};

const earningWhere = (period: LeaderboardPeriod): Prisma.TokenLedgerWhereInput => ({
  createdAt: { gte: periodStart(period) },
  type: { in: ['EARN', 'ADMIN_ADJUST'] },
  amount: { gt: 0 },
});

const earningWhereBetween = (
  start: Date,
  end: Date,
): Prisma.TokenLedgerWhereInput => ({
  createdAt: { gte: start, lt: end },
  type: { in: ['EARN', 'ADMIN_ADJUST'] },
  amount: { gt: 0 },
});

const DEFAULT_TOP = 100;

const tokenEntry = (group: {
  userId: string;
  _sum: { amount: number | null } | null | undefined;
  _count: { _all: number };
}) => ({
  totalTokens: group._sum?.amount ?? 0,
  rewardCount: group._count._all ?? 0,
  approvedCount: 0,
});

const qualityEntry = (group: { userId: string; _count: { _all: number } }) => ({
  totalTokens: 0,
  rewardCount: 0,
  approvedCount: group._count._all ?? 0,
});

export async function getLeaderboard(
  period: LeaderboardPeriod = 'all',
  limit = DEFAULT_TOP,
  scope: LeaderboardScope = 'tokens',
) {
  const take = Math.min(Math.max(1, limit), 200);

  let groups: { userId: string }[];
  let metrics: Map<string, ReturnType<typeof tokenEntry>>;

  if (scope === 'quality') {
    const quality = await prisma.translation.groupBy({
      by: ['userId'],
      where: { status: 'APPROVED', approvedAt: { gte: periodStart(period) } },
      _count: { _all: true },
      orderBy: { _count: { userId: 'desc' } },
      take,
    });
    groups = quality;
    metrics = new Map(quality.map((g) => [g.userId, qualityEntry(g)]));
  } else {
    const tokenGroups = await prisma.tokenLedger.groupBy({
      by: ['userId'],
      where: earningWhere(period),
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { _sum: { amount: 'desc' } },
      take,
    });
    groups = tokenGroups;
    metrics = new Map(tokenGroups.map((g) => [g.userId, tokenEntry(g)]));
  }

  if (groups.length === 0) {
    return { entries: [] };
  }

  const userIds = groups.map((g) => g.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, displayName: true, photoUrl: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  const entries = groups.map((group, index) => ({
    rank: index + 1,
    userId: group.userId,
    displayName: userMap.get(group.userId)?.displayName ?? 'Unknown',
    photoUrl: userMap.get(group.userId)?.photoUrl ?? null,
    ...metrics.get(group.userId),
  }));

  return { entries };
}

/**
 * Leaderboard for an explicit date window (used to freeze monthly season
 * snapshots). Token scope only.
 */
export async function getLeaderboardBetween(start: Date, end: Date, limit = DEFAULT_TOP) {
  const take = Math.min(Math.max(1, limit), 200);

  const groups = await prisma.tokenLedger.groupBy({
    by: ['userId'],
    where: earningWhereBetween(start, end),
    _sum: { amount: true },
    _count: { _all: true },
    orderBy: { _sum: { amount: 'desc' } },
    take,
  });

  if (groups.length === 0) {
    return { entries: [] };
  }

  const userIds = groups.map((g) => g.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, displayName: true, photoUrl: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  const entries = groups.map((group, index) => ({
    rank: index + 1,
    userId: group.userId,
    displayName: userMap.get(group.userId)?.displayName ?? 'Unknown',
    photoUrl: userMap.get(group.userId)?.photoUrl ?? null,
    ...tokenEntry(group),
  }));

  return { entries };
}

export async function getMyRank(
  period: LeaderboardPeriod = 'all',
  userId: string,
  scope: LeaderboardScope = 'tokens',
) {  if (scope === 'quality') {
    const groups = await prisma.translation.groupBy({
      by: ['userId'],
      where: { status: 'APPROVED', approvedAt: { gte: periodStart(period) } },
      _count: { _all: true },
      orderBy: { _count: { userId: 'desc' } },
    });

    const index = groups.findIndex((g) => g.userId === userId);

    if (index === -1) {
      return { rank: null, approvedCount: 0 };
    }

    return {
      rank: index + 1,
      approvedCount: groups[index]._count._all ?? 0,
    };
  }

  const groups = await prisma.tokenLedger.groupBy({
    by: ['userId'],
    where: earningWhere(period),
    _sum: { amount: true },
    _count: { _all: true },
    orderBy: { _sum: { amount: 'desc' } },
  });

  const index = groups.findIndex((g) => g.userId === userId);

  if (index === -1) {
    return { rank: null, totalTokens: 0, rewardCount: 0 };
  }

  return {
    rank: index + 1,
    totalTokens: groups[index]._sum.amount ?? 0,
    rewardCount: groups[index]._count._all ?? 0,
  };
}
