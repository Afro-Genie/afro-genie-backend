import type { Job } from 'bullmq';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { creditTokens, dedupeCreditTokens } from '../services/rewardService';
import { checkAndAwardBadges } from '../services/badgeService';

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
        const commissionAmount = Math.max(1, Math.floor(amount * REFERRAL_COMMISSION_RATE));
        const commissionKey = idempotencyKey ? `${idempotencyKey}:commission` : undefined;
        if (commissionKey) {
          await dedupeCreditTokens(commissionKey, user.referredByUserId, commissionAmount, `REFERRAL_COMMISSION:${reason}`);
        } else {
          await creditTokens(user.referredByUserId, commissionAmount, `REFERRAL_COMMISSION:${reason}`);
        }
        await prisma.notification.create({
          data: {
            userId: user.referredByUserId,
            title: 'Referral Commission',
            message: `You earned ${commissionAmount} tokens from a referred user's reward.`,
            type: 'REWARD',
          },
        });
        logger.info(
          { jobId: job.id, referrerId: user.referredByUserId, commissionAmount, originalUserId: userId },
          'Referral commission credited',
        );
      }
    }

    const newBadges = await checkAndAwardBadges(userId, event);

    logger.info(
      { jobId: job.id, userId, amount, newBadges },
      'Reward job completed',
    );
  } catch (err) {
    logger.error({ err, jobId: job.id, userId, amount, reason, event }, 'Reward job failed');
    throw err;
  }
}
