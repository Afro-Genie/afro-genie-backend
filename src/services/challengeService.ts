import { Prisma, type Challenge } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { ApiError } from '../middleware/errorHandler';
import { awardTokens } from './tokenService';

// ---------------------------------------------------------------------------
// Challenges service (Phase 5 / 6.3).
//
// Challenges are time-boxed weekly goals. Progress is computed on demand from
// the underlying action tables (translations, ledger, referrals, streaks) so
// there is no denormalised counter to drift. Claiming is idempotent: the award
// carries a deterministic idempotencyKey and a UserEntitlement row
// (unique userId+type) blocks a second claim even under a race.
// ---------------------------------------------------------------------------

export interface ChallengeProgress {
  progress: number;
  targetValue: number;
  completed: boolean;
  claimed: boolean;
}

const entitlementType = (challengeId: string): string => `CHALLENGE:${challengeId}`;

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

async function countDistinctSongs(userId: string, challenge: Challenge): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(DISTINCT "songId")::int AS "count"
    FROM "Translation"
    WHERE "userId" = ${userId}
      AND "createdAt" >= ${challenge.startsAt}
      AND "createdAt" <= ${challenge.expiresAt}
  `;
  return rows[0]?.count ?? 0;
}

async function sumEarnedGt(userId: string, challenge: Challenge): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ total: number }>>`
    SELECT COALESCE(SUM("amount"), 0)::int AS "total"
    FROM "TokenLedger"
    WHERE "userId" = ${userId}
      AND "type" = 'EARN'
      AND "createdAt" >= ${challenge.startsAt}
      AND "createdAt" <= ${challenge.expiresAt}
  `;
  return rows[0]?.total ?? 0;
}

async function countApprovals(userId: string, challenge: Challenge): Promise<number> {
  return prisma.translation.count({
    where: {
      userId,
      status: 'APPROVED',
      approvedAt: { gte: challenge.startsAt, lte: challenge.expiresAt },
    },
  });
}

async function getStreak(userId: string): Promise<number> {
  const streak = await prisma.userStreak.findUnique({
    where: { userId },
    select: { currentStreak: true, longestStreak: true },
  });
  return Math.max(streak?.currentStreak ?? 0, streak?.longestStreak ?? 0);
}

async function countInvites(userId: string, challenge: Challenge): Promise<number> {
  return prisma.referral.count({
    where: {
      referrerId: userId,
      createdAt: { gte: challenge.startsAt, lte: challenge.expiresAt },
    },
  });
}

async function computeProgress(userId: string, challenge: Challenge): Promise<number> {
  switch (challenge.type) {
    case 'TRANSLATE_N_SONGS':
      return countDistinctSongs(userId, challenge);
    case 'EARN_N_GT':
      return sumEarnedGt(userId, challenge);
    case 'ACHIEVE_N_APPROVALS':
      return countApprovals(userId, challenge);
    case 'STREAK_7_DAYS':
      return getStreak(userId);
    case 'INVITE_3_FRIENDS':
      return countInvites(userId, challenge);
    default:
      return 0;
  }
}

/** Open challenges with the caller's progress merged in. */
export async function getCurrentChallenges(userId?: string) {
  const now = new Date();
  const challenges = await prisma.challenge.findMany({
    where: { active: true, startsAt: { lte: now }, expiresAt: { gt: now } },
    orderBy: { expiresAt: 'asc' },
  });

  if (!userId) {
    return challenges.map((challenge) => ({
      ...challenge,
      progress: 0,
      completed: false,
      claimed: false,
    }));
  }

  return Promise.all(
    challenges.map(async (challenge) => {
      const [progress, claimed] = await Promise.all([
        computeProgress(userId, challenge),
        prisma.userEntitlement
          .findUnique({
            where: { userId_type: { userId, type: entitlementType(challenge.id) } },
            select: { id: true },
          })
          .then((e) => Boolean(e)),
      ]);

      return {
        id: challenge.id,
        title: challenge.title,
        description: challenge.description,
        type: challenge.type,
        targetValue: challenge.targetValue,
        gtReward: challenge.gtReward,
        startsAt: challenge.startsAt,
        expiresAt: challenge.expiresAt,
        progress: Math.min(progress, challenge.targetValue),
        completed: progress >= challenge.targetValue,
        claimed,
      };
    }),
  );
}

/**
 * Progress for a single challenge, including whether the reward was claimed.
 *
 * The `active` / window guard is deliberately identical to the one
 * `getCurrentChallenges` applies. Previously this was a bare `findUnique({ id })`,
 * so a client holding an old challenge id could read live progress — and, for a
 * not-yet-started challenge, pre-compute progress against a window that had not
 * opened — for a challenge that is not currently offered to anyone. The claim
 * path already re-checked `active` + `expiresAt`, so this endpoint was the only
 * place the two disagreed.
 */
export async function getChallengeProgress(
  userId: string,
  challengeId: string,
): Promise<ChallengeProgress> {
  const now = new Date();
  const challenge = await prisma.challenge.findFirst({
    where: { id: challengeId, active: true, startsAt: { lte: now }, expiresAt: { gt: now } },
  });
  if (!challenge) {
    throw new ApiError('Challenge not found', 'NOT_FOUND', 404);
  }

  const [rawProgress, claimed] = await Promise.all([
    computeProgress(userId, challenge),
    prisma.userEntitlement
      .findUnique({
        where: { userId_type: { userId, type: entitlementType(challengeId) } },
        select: { id: true },
      })
      .then((e) => Boolean(e)),
  ]);

  return {
    progress: Math.min(rawProgress, challenge.targetValue),
    targetValue: challenge.targetValue,
    completed: rawProgress >= challenge.targetValue,
    claimed,
  };
}

export interface ClaimResult {
  challengeId: string;
  gtReward: number;
  claimed: true;
}

/**
 * Claim a completed challenge. Guarded by progress >= targetValue AND not
 * already claimed; the ledger award and the entitlement are both idempotent.
 */
export async function claimChallengeReward(
  userId: string,
  challengeId: string,
): Promise<ClaimResult> {
  const challenge = await prisma.challenge.findUnique({ where: { id: challengeId } });
  if (!challenge || !challenge.active) {
    throw new ApiError('Challenge not found', 'NOT_FOUND', 404);
  }

  // Not-yet-started challenges are not offered by `getCurrentChallenges` and are
  // now rejected by `getChallengeProgress` too; the claim path has to agree or a
  // client could complete and cash in a challenge before its window opens.
  // The expired case below keeps its existing CHALLENGE_EXPIRED (400) contract.
  const now = new Date();
  if (challenge.startsAt > now) {
    throw new ApiError('Challenge has not started yet', 'CHALLENGE_NOT_STARTED', 400);
  }

  if (challenge.expiresAt < now) {
    throw new ApiError('Challenge has expired', 'CHALLENGE_EXPIRED', 400);
  }

  const alreadyClaimed = await prisma.userEntitlement.findUnique({
    where: { userId_type: { userId, type: entitlementType(challengeId) } },
    select: { id: true },
  });
  if (alreadyClaimed) {
    throw new ApiError('Challenge reward already claimed', 'ALREADY_CLAIMED', 409);
  }

  const progress = await computeProgress(userId, challenge);
  if (progress < challenge.targetValue) {
    throw new ApiError('Challenge not yet complete', 'CHALLENGE_INCOMPLETE', 400);
  }

  // Idempotent award (safe to retry; unique idempotencyKey).
  await awardTokens({
    userId,
    type: 'EARN',
    amount: challenge.gtReward,
    reason: `Challenge reward: ${challenge.title}`,
    sourceType: 'CHALLENGE',
    sourceId: challenge.id,
    idempotencyKey: `challenge:${challenge.id}:${userId}`,
    metadata: { challengeId: challenge.id, challengeType: challenge.type },
  });

  try {
    await prisma.userEntitlement.create({
      data: {
        userId,
        type: entitlementType(challengeId),
        metadata: { challengeId: challenge.id, gtReward: challenge.gtReward },
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Lost the race to another claim — the award was idempotent, so this is
      // still a success from the user's perspective.
      return { challengeId, gtReward: challenge.gtReward, claimed: true };
    }
    throw err;
  }

  await prisma.notification
    .create({
      data: {
        userId,
        title: 'Challenge complete!',
        message: `You earned +${challenge.gtReward} GT for completing "${challenge.title}".`,
        type: 'REWARD',
      },
    })
    .catch((err) => logger.warn({ err, userId, challengeId }, 'Challenge notification failed'));

  return { challengeId, gtReward: challenge.gtReward, claimed: true };
}