import type { RepeatOptions } from 'bullmq';
import type { ChallengeType } from '@prisma/client';
import { challengeRotationQueue } from '../lib/queue';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

// ---------------------------------------------------------------------------
// Weekly challenge rotation (Phase 5 / 6.3).
//
// Upserts the current week's challenges (Monday 00:00 UTC → next Monday) so
// every week has a fresh, idempotent set. Reuses the reconciliation queue.
// ---------------------------------------------------------------------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ChallengeTemplate {
  type: ChallengeType;
  title: string;
  description: string;
  targetValue: number;
  gtReward: number;
}

/**
 * The weekly challenge lineup.
 *
 * `ACHIEVE_N_APPROVALS` was previously missing here even though the Prisma enum,
 * the progress counter (`challengeService.countApprovals`) and the reward path
 * all supported it — so that branch of `computeProgress` was unreachable dead
 * code. Two options existed: add the template, or delete the branch. Adding it
 * is the better of the two: the branch is correct, tested logic, and the type
 * exists in the schema precisely because this challenge was intended.
 *
 * It is also the most on-brand challenge available — every other template
 * rewards an indirect activity, while this one rewards the platform's core loop
 * (a translator getting work approved), which is the Phase 1.2.3 reward gap.
 *
 * NOTE FOR STAGE 4: this list is now 5 templates, so `runChallengeRotation()`
 * upserts 5 rows per week, not 4. Stage 4's post-check must expect 5.
 */
export const CHALLENGE_TEMPLATES: readonly ChallengeTemplate[] = [
  {
    type: 'TRANSLATE_N_SONGS',
    title: 'Translate 3 Songs',
    description: 'Translate 3 different songs this week.',
    targetValue: 3,
    gtReward: 30,
  },
  {
    type: 'EARN_N_GT',
    title: 'Earn 100 GT this week',
    description: 'Earn 100 GT from any activity this week.',
    targetValue: 100,
    gtReward: 50,
  },
  {
    type: 'ACHIEVE_N_APPROVALS',
    title: 'Get 3 Translations Approved',
    description: 'Have 3 of your translations approved this week.',
    targetValue: 3,
    gtReward: 30,
  },
  {
    type: 'STREAK_7_DAYS',
    title: '7-Day Streak',
    description: 'Log in for 7 consecutive days.',
    targetValue: 7,
    gtReward: 25,
  },
  {
    type: 'INVITE_3_FRIENDS',
    title: 'Invite 2 Friends',
    description: 'Invite 2 friends who join this week.',
    targetValue: 2,
    gtReward: 20,
  },
];

/** Monday 00:00 UTC → the following Monday. */
export function getWeekWindow(now: Date = new Date()): { startsAt: Date; expiresAt: Date } {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (midnight.getUTCDay() + 6) % 7;
  const startsAt = new Date(midnight.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  return { startsAt, expiresAt: new Date(startsAt.getTime() + WEEK_MS) };
}

export interface ChallengeRotationResult {
  upserted: number;
  deactivated: number;
}

export const runChallengeRotation = async (): Promise<ChallengeRotationResult> => {
  const { startsAt, expiresAt } = getWeekWindow();
  let upserted = 0;

  for (const template of CHALLENGE_TEMPLATES) {
    await prisma.challenge.upsert({
      where: { type_startsAt: { type: template.type, startsAt } },
      update: {
        title: template.title,
        description: template.description,
        targetValue: template.targetValue,
        gtReward: template.gtReward,
        expiresAt,
        active: true,
      },
      create: {
        type: template.type,
        title: template.title,
        description: template.description,
        targetValue: template.targetValue,
        gtReward: template.gtReward,
        startsAt,
        expiresAt,
        active: true,
      },
    });
    upserted += 1;
  }

  const { count: deactivated } = await prisma.challenge.updateMany({
    where: { expiresAt: { lt: new Date() }, active: true },
    data: { active: false },
  });

  logger.info({ upserted, deactivated, startsAt, expiresAt }, 'Weekly challenge rotation completed');

  return { upserted, deactivated };
};

const CHALLENGE_ROTATION_JOB_OPTIONS = {
  removeOnComplete: 20,
  removeOnFail: 20,
  repeat: {
    // Monday 00:05 UTC.
    pattern: '5 0 * * 1',
  } satisfies RepeatOptions,
};

export const scheduleChallengeRotation = async () => {
  // Own queue (2.6) — see `lib/queue.ts`. A long reconciliation pass used to
  // head-of-line block this weekly job indefinitely.
  await challengeRotationQueue.add(
    'challenge-rotation',
    {},
    { ...CHALLENGE_ROTATION_JOB_OPTIONS, jobId: 'challenge-rotation-weekly' },
  );

  // Ensure the current week's challenges exist immediately (idempotent).
  await runChallengeRotation().catch((err) =>
    logger.warn({ err }, 'Initial challenge rotation failed — will retry on schedule'),
  );
};

export const processChallengeRotationJob = async (): Promise<void> => {
  await runChallengeRotation();
};