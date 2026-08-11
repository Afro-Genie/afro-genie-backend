import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { ApiError } from '../middleware/errorHandler';
import { REWARD_CONFIG } from '../config/rewards';
import { getLeaderboardBetween } from './leaderboardService';
import { awardTokens } from './tokenService';
import { awardBadge } from './badgeService';
import { createNotification } from './notificationService';

// ---------------------------------------------------------------------------
// Seasonal snapshot service (Phase 3).
//
// Each month the token leaderboard is frozen into a SeasonalSnapshot keyed by
// a unique `period` (YYYY-MM), so the job is idempotent per month. The top 3
// get a bonus + SEASON_CHAMPION badge; every reward is idempotent so retried
// runs can never double-pay.
// ---------------------------------------------------------------------------

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export const periodKeyOf = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

const periodBounds = (
  period: string,
): { start: Date; end: Date } => {
  const [year, month] = period.split('-').map((part) => Number(part));
  if (!year || !month || month < 1 || month > 12) {
    throw new ApiError('Invalid season period', 'VALIDATION_ERROR', 400);
  }
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
};

/**
 * Freeze the current monthly leaderboard into a SeasonalSnapshot. Idempotent
 * per period: re-running for an already-frozen month returns the existing
 * snapshot and never re-awards.
 */
export async function freezeSeason(date = new Date()) {
  const period = periodKeyOf(date);
  const { start, end } = periodBounds(period);

  const existing = await prisma.seasonalSnapshot.findUnique({ where: { period } });
  if (existing) return existing;

  const { entries } = await getLeaderboardBetween(start, end, 100);
  const topThree = entries.slice(0, 3);

  const data = {
    period,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    entries,
    topThree,
  } as Prisma.InputJsonValue;

  try {
    const snapshot = await prisma.seasonalSnapshot.create({
      data: {
        period,
        startDate: start,
        endDate: end,
        data,
      },
    });

    await rewardTopThree(period, topThree);

    logger.info(
      { period, entries: entries.length },
      'season snapshot frozen',
    );

    return snapshot;
  } catch (err) {
    // Concurrent freeze: the unique period already won elsewhere.
    if (isUniqueViolation(err)) {
      const duplicate = await prisma.seasonalSnapshot.findUnique({ where: { period } });
      if (duplicate) return duplicate;
    }
    throw err;
  }
}

async function rewardTopThree(
  period: string,
  topThree: Array<{ userId: string; displayName: string; rank: number }>,
) {
  for (const entry of topThree) {
    const bonus = REWARD_CONFIG.SEASON_TOP3_BONUS[entry.rank - 1];
    if (!bonus || bonus <= 0) continue;

    await awardTokens({
      userId: entry.userId,
      type: 'EARN',
      amount: bonus,
      reason: `Season ${period} top ${entry.rank} bonus`,
      sourceType: 'SEASON_BONUS',
      sourceId: period,
      idempotencyKey: `season:${period}:bonus:${entry.userId}`,
    });

    await awardBadge(entry.userId, 'SEASON_CHAMPION');

    await createNotification({
      userId: entry.userId,
      title: 'Season champion',
      message: `You finished #${entry.rank} in season ${period} and earned a ${bonus} token bonus!`,
      type: 'REWARD',
    });
  }
}

export async function getSeasons() {
  const snapshots = await prisma.seasonalSnapshot.findMany({
    orderBy: { period: 'desc' },
  });

  return snapshots.map((snapshot) => {
    const data = snapshot.data as Prisma.JsonValue;
    const topThree =
      data && typeof data === 'object' && 'topThree' in data
        ? (data as Record<string, unknown>).topThree
        : [];
    return {
      id: snapshot.id,
      period: snapshot.period,
      startDate: snapshot.startDate,
      endDate: snapshot.endDate,
      createdAt: snapshot.createdAt,
      topThree,
    };
  });
}

export async function getSeason(id: string) {
  const snapshot = await prisma.seasonalSnapshot.findUnique({ where: { id } });
  if (!snapshot) {
    throw new ApiError('Season not found', 'NOT_FOUND', 404);
  }

  return {
    id: snapshot.id,
    period: snapshot.period,
    startDate: snapshot.startDate,
    endDate: snapshot.endDate,
    createdAt: snapshot.createdAt,
    data: snapshot.data as Prisma.JsonValue,
  };
}
