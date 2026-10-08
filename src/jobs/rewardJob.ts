import type { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { creditTokens, dedupeCreditTokens } from '../services/rewardService';
import { checkAndAwardBadges } from '../services/badgeService';
import { isRewardPaused } from '../services/abuseService';
import { hasMutualReferral } from '../services/referralService';

const REFERRAL_COMMISSION_RATE = 0.1;

export interface RewardJobData {
  userId: string;
  amount: number;
  reason: string;
  event?: string;
  idempotencyKey?: string;
}

export async function processRewardJob(job: Job<RewardJobData>): Promise<void> {
  const { userId, reason, event, idempotencyKey } = job.data;
  let { amount } = job.data;

  logger.info({ jobId: job.id, userId, amount, reason, event, idempotencyKey }, 'Processing reward job');

  try {
    // Auto-pause: HIGH-severity abuse flags suspend earning until reviewed.
    if (await isRewardPaused(userId)) {
      logger.warn({ jobId: job.id, userId, reason }, 'Reward skipped — earning paused by abuse flag');
      return;
    }

    // 1.5× artist bonus for verified artists on translation rewards
    const artist = await prisma.artist.findFirst({
      where: { userId, verified: true },
      select: { id: true },
    });
    let appliedArtistBonus = false;
    if (artist && event === 'TRANSLATION_APPROVED') {
      const originalAmount = amount;
      amount = Math.floor(amount * 1.5);
      logger.info({ jobId: job.id, userId, originalAmount, newAmount: amount }, 'Artist bonus applied (1.5×)');
      appliedArtistBonus = true;
    }

    let credited: boolean;

    if (idempotencyKey) {
      credited = await dedupeCreditTokens(idempotencyKey, userId, amount, reason);
    } else {
      await creditTokens(userId, amount, reason);
      credited = true;
    }

    if (!credited) {
      logger.info({ jobId: job.id, userId, reason }, 'Reward skipped — duplicate');
      return;
    }

    if (appliedArtistBonus) {
      await prisma.notification.create({
        data: {
          userId,
          title: 'Artist Bonus!',
          message: 'You earned a 1.5× bonus as a verified artist on this translation reward.',
          type: 'REWARD',
        },
      });
    }

    // 10% referral commission for the referrer (skip referral and mod events to avoid loops)
    if (!reason.startsWith('REFERRAL') && event !== 'MODERATOR_ACTION') {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { referredByUserId: true },
      });
      if (user?.referredByUserId) {
        const referrerId = user.referredByUserId;
        if (await hasMutualReferral(userId, referrerId)) {
          // Self-referral ring (A→B→A) — block the commission.
          logger.warn({ jobId: job.id, userId, referrerId }, 'Referral commission blocked — mutual referral detected');
        } else {
          const commissionAmount = Math.max(1, Math.floor(amount * REFERRAL_COMMISSION_RATE));
          const commissionKey = idempotencyKey ? `${idempotencyKey}:commission` : undefined;
          if (commissionKey) {
            await dedupeCreditTokens(commissionKey, referrerId, commissionAmount, `REFERRAL_COMMISSION:${reason}`);
          } else {
            await creditTokens(referrerId, commissionAmount, `REFERRAL_COMMISSION:${reason}`);
          }
          await prisma.notification.create({
            data: {
              userId: referrerId,
              title: 'Referral Commission',
              message: `You earned ${commissionAmount} tokens from a referred user's reward.`,
              type: 'REWARD',
            },
          });
          logger.info(
            { jobId: job.id, referrerId, commissionAmount, originalUserId: userId },
            'Referral commission credited',
          );
        }
      }
    }

    const newBadges = await checkAndAwardBadges(userId, event);

    logger.info(
      { jobId: job.id, userId, amount, newBadges },
      'Reward job completed',
    );
  } catch (err) {
    // The user was deleted between enqueue and processing. `User` has no
    // soft-delete, so the wallet upsert trips the UserWallet_userId_fkey
    // constraint and there is nobody left to pay. Retrying can never succeed,
    // so complete the job as a no-op instead of parking it in the failed set
    // forever — 42 of 44 historical failures were exactly this, and they made
    // the queue's failure count useless as a health signal.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2003'
    ) {
      logger.warn(
        { jobId: job.id, userId, reason, event },
        'Reward discarded — user no longer exists',
      );
      return;
    }

    logger.error({ err, jobId: job.id, userId, amount, reason, event }, 'Reward job failed');
    throw err;
  }
}
