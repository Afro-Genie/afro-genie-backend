import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export async function takeLeaderboardSnapshot(period: string): Promise<{ success: boolean; snapshotId?: string }> {
  const now = new Date();
  let startDate: Date;
  let endDate = now;

  if (period === 'Q1') {
    startDate = new Date(now.getFullYear(), 0, 1);
    endDate = new Date(now.getFullYear(), 2, 31, 23, 59, 59);
  } else if (period === 'Q2') {
    startDate = new Date(now.getFullYear(), 3, 1);
    endDate = new Date(now.getFullYear(), 5, 30, 23, 59, 59);
  } else if (period === 'Q3') {
    startDate = new Date(now.getFullYear(), 6, 1);
    endDate = new Date(now.getFullYear(), 8, 30, 23, 59, 59);
  } else if (period === 'Q4') {
    startDate = new Date(now.getFullYear(), 9, 1);
    endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59);
  } else {
    // Custom: last 30 days
    startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }

  const periodLabel = `${now.getFullYear()}-${period}`;

  // Check if snapshot already exists
  const existing = await prisma.leaderboardSnapshot.findFirst({
    where: { period: periodLabel, startDate },
  });
  if (existing) {
    return { success: false };
  }

  // Get leaderboard data
  const results = await prisma.tokenReward.groupBy({
    by: ['userId'],
    _sum: { amount: true },
    _count: { id: true },
    where: { createdAt: { gte: startDate, lte: endDate } },
    orderBy: { _sum: { amount: 'desc' } },
    take: 50,
  });

  const userIds = results.map((r) => r.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, displayName: true, photoUrl: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  const data = results.map((entry, index) => ({
    rank: index + 1,
    userId: entry.userId,
    displayName: userMap.get(entry.userId)?.displayName ?? 'Anonymous',
    photoUrl: userMap.get(entry.userId)?.photoUrl ?? null,
    totalTokens: entry._sum.amount ?? 0,
    rewardCount: entry._count.id,
  }));

  const snapshot = await prisma.leaderboardSnapshot.create({
    data: { period: periodLabel, startDate, endDate, data },
    select: { id: true },
  });

  logger.info({ snapshotId: snapshot.id, period: periodLabel, entries: data.length }, 'Leaderboard snapshot taken');

  return { success: true, snapshotId: snapshot.id };
}

export async function getSeasonalSnapshots() {
  return prisma.leaderboardSnapshot.findMany({
    orderBy: { startDate: 'desc' },
    take: 12,
    select: {
      id: true,
      period: true,
      startDate: true,
      endDate: true,
      createdAt: true,
    },
  });
}

export async function getSnapshotById(id: string) {
  return prisma.leaderboardSnapshot.findUnique({
    where: { id },
    select: {
      id: true,
      period: true,
      startDate: true,
      endDate: true,
      data: true,
      createdAt: true,
    },
  });
}
