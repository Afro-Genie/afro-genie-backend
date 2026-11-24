import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { getRewardConfig, isRewardActive } from '../config/rewards';
import { awardTokensWithResult } from './tokenService';
import { getMultiplier, recomputeTier } from './tierService';
import { createNotification } from './notificationService';
import { contributeTax } from './modPoolService';
import { evaluateTranslationBadges } from './badgeService';
import { isRewardPaused } from './abuseService';

// ---------------------------------------------------------------------------
// Reward event hooks (Phase 1).
//
// These functions fire token awards, tier recomputation and reward
// notifications at the point of the underlying event. Each hook is defensive:
// a failure here must never break the underlying review/job transaction, and
// every award carries a unique idempotencyKey so replays can't double-award.
// ---------------------------------------------------------------------------

export interface TranslationApprovedEvent {
  translationId: string;
  userId: string;
  reviewerId: string;
}

export interface TranslationRejectedEvent {
  translationId: string;
  userId: string;
  reviewerId: string;
  reason?: string;
}

export interface CorrectionApprovedEvent {
  correctionId: string;
  translationId: string;
  userId: string;
  reviewerId: string;
}

export interface CorrectionRejectedEvent {
  correctionId: string;
  translationId: string;
  userId: string;
  reviewerId: string;
}

export interface AiTranslationCompletedEvent {
  jobId: string;
  userId: string;
  translationId: string;
}

export interface TopicShareEvent {
  topicId: string;
  userId: string;
}

const startOfDayUtc = (): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

const countToday = async (userId: string, sourceType: string): Promise<number> =>
  prisma.tokenLedger.count({
    where: { userId, sourceType, createdAt: { gte: startOfDayUtc() } },
  });

/** Moderator +10 (flat) for an approval; contributor +10 for approved work. */
export async function onTranslationApproved(event: TranslationApprovedEvent): Promise<void> {
  try {
    const config = await getRewardConfig();

    const [reviewerPaused, contributorPaused] = await Promise.all([
      isRewardPaused(event.reviewerId),
      isRewardPaused(event.userId),
    ]);

    // Check if translator approval reward is currently active.
    const reviewerActive = await isRewardActive('TRANSLATOR_REWARD');
    const contributorActive = await isRewardActive('TRANSLATOR_REWARD');

    if (!reviewerPaused && reviewerActive) {
      const { created: reviewerRewardCreated } = await awardTokensWithResult({
        userId: event.reviewerId,
        type: 'EARN',
        amount: config.TRANSLATION_APPROVED_AMOUNT,
        reason: 'Translation approved',
        sourceType: 'TRANSLATION_APPROVED',
        sourceId: event.translationId,
        idempotencyKey: `translation-approved:${event.translationId}:${event.reviewerId}`,
      });

      if (reviewerRewardCreated) {
        await createNotification({
          userId: event.reviewerId,
          title: 'Review reward',
          message: `You earned +${config.TRANSLATION_APPROVED_AMOUNT} tokens for approving a translation.`,
          type: 'REWARD',
        });
      }

      // The tax operation is independently idempotent, so retries can repair
      // a failed tax write without repeating the reward notification.
      await contributeTax({
        userId: event.reviewerId,
        rewardAmount: config.TRANSLATION_APPROVED_AMOUNT,
        sourceId: event.translationId,
      });
    } else if (!reviewerActive) {
      logger.info({ event }, 'Translator approval reward is currently inactive');
    } else {
      logger.warn({ event }, 'reward hook onTranslationApproved skipped reviewer reward — reviewer paused');
    }

    await createNotification({
      userId: event.userId,
      title: 'Translation approved',
      message: 'Your translation was approved by a moderator.',
      type: 'TRANSLATION',
    });

    // Contributor (translator) GT for approved work (Phase 1, 2.2.3).
    if (!contributorPaused && contributorActive) {
      const { created: contributorRewardCreated } = await awardTokensWithResult({
        userId: event.userId,
        type: 'EARN',
        amount: config.TRANSLATOR_APPROVED_AMOUNT,
        reason: 'Translation approved',
        sourceType: 'TRANSLATION_APPROVED',
        sourceId: event.translationId,
        idempotencyKey: `translation-contributor:${event.translationId}`,
      });

      if (contributorRewardCreated) {
        await createNotification({
          userId: event.userId,
          title: 'Tokens earned',
          message: `Your translation was approved. You earned +${config.TRANSLATOR_APPROVED_AMOUNT} tokens.`,
          type: 'REWARD',
        });
      }
    } else if (!contributorActive) {
      logger.info({ event }, 'Translator contribution reward is currently inactive');
    } else {
      logger.warn({ event }, 'reward hook onTranslationApproved skipped contributor reward — contributor paused');
    }

    // Phase 4: EARLY_ADOPTER / TOP_TRANSLATOR / CULTURE_CURATOR thresholds.
    await evaluateTranslationBadges(event.userId);
  } catch (err) {
    logger.error({ err, event }, 'reward hook onTranslationApproved failed');
  }
}

/** Notify the contributor their translation was rejected. */
export async function onTranslationRejected(event: TranslationRejectedEvent): Promise<void> {
  try {
    await createNotification({
      userId: event.userId,
      title: 'Translation not approved',
      message: event.reason ? `Your translation was rejected: ${event.reason}` : 'Your translation was rejected.',
      type: 'TRANSLATION',
    });
  } catch (err) {
    logger.error({ err, event }, 'reward hook onTranslationRejected failed');
  }
}

/** Contributor +20 (×tier) for an applied correction. */
export async function onCorrectionApproved(event: CorrectionApprovedEvent): Promise<void> {
  try {
    if (await isRewardPaused(event.userId)) {
      logger.warn({ event }, 'reward hook onCorrectionApproved skipped — user paused');
      return;
    }

    // Check if correction approval reward is currently active.
    const correctionActive = await isRewardActive('CORRECTION');
    if (!correctionActive) {
      logger.info({ event }, 'Correction approval reward is currently inactive');
      return;
    }

    const config = await getRewardConfig();
    if (await countToday(event.userId, 'CORRECTION') >= config.CORRECTION_DAILY_CAP) {
      return;
    }

    const multiplier = await getMultiplier(event.userId);
    const amount = Math.round(config.CORRECTION_APPROVED_AMOUNT * multiplier);

    const { created } = await awardTokensWithResult({
      userId: event.userId,
      type: 'EARN',
      amount,
      reason: 'Correction approved',
      sourceType: 'CORRECTION',
      sourceId: event.correctionId,
      idempotencyKey: `correction:${event.correctionId}`,
    });

    if (created) {
      await createNotification({
        userId: event.userId,
        title: 'Correction approved',
        message: `Your correction was approved. You earned +${amount} tokens.`,
        type: 'REWARD',
      });
    }
  } catch (err) {
    logger.error({ err, event }, 'reward hook onCorrectionApproved failed');
  }
}

/** Notify the contributor their correction was rejected. */
export async function onCorrectionRejected(event: CorrectionRejectedEvent): Promise<void> {
  try {
    await createNotification({
      userId: event.userId,
      title: 'Correction not approved',
      message: 'Your correction suggestion was not approved by a moderator.',
      type: 'REWARD',
    });
  } catch (err) {
    logger.error({ err, event }, 'reward hook onCorrectionRejected failed');
  }
}

/** 2 GT x tier when an AI translation job actually generates real content. */
export async function onAiTranslationCompleted(event: AiTranslationCompletedEvent): Promise<void> {
  try {
    if (await isRewardPaused(event.userId)) {
      logger.warn({ event }, 'reward hook onAiTranslationCompleted skipped — user paused');
      return;
    }

    if (!(await isRewardActive('AI_TRANSLATION_REWARD'))) {
      logger.info({ event }, 'AI translation completion reward is currently inactive');
      return;
    }

    // The job auto-approves the translation, so refresh the tier before paying.
    const tier = await recomputeTier(event.userId);
    const config = await getRewardConfig();
    const amount = Math.round(Number(config.AI_TRANSLATION_REWARD_AMOUNT) * tier.multiplier);

    const { created } = await awardTokensWithResult({
      userId: event.userId,
      type: 'EARN',
      amount,
      reason: 'AI translation completed',
      sourceType: 'AI_TRANSLATION',
      sourceId: event.translationId,
      idempotencyKey: `ai-translation-reward:${event.translationId}`,
      metadata: { jobId: event.jobId, tier: tier.tier, multiplier: tier.multiplier },
    });

    if (created) {
      await createNotification({
        userId: event.userId,
        title: 'Tokens earned',
        message: `Your translation was generated. You earned +${amount} GT (${tier.tier} x${tier.multiplier}).`,
        type: 'REWARD',
      });
    }
  } catch (err) {
    logger.error({ err, event }, 'reward hook onAiTranslationCompleted failed');
  }
}

/** +2 for sharing a topic. */
export async function onTopicShare(event: TopicShareEvent): Promise<void> {
  try {
    if (await isRewardPaused(event.userId)) {
      logger.warn({ event }, 'reward hook onTopicShare skipped — user paused');
      return;
    }

    // Check if topic share reward is currently active.
    const shareActive = await isRewardActive('TOPIC_SHARE');
    if (!shareActive) {
      logger.info({ event }, 'Topic share reward is currently inactive');
      return;
    }

    const config = await getRewardConfig();
    if (await countToday(event.userId, 'SHARE') >= config.TOPIC_SHARE_DAILY_CAP) {
      return;
    }

    const { created } = await awardTokensWithResult({
      userId: event.userId,
      type: 'EARN',
      amount: config.TOPIC_SHARE_AMOUNT,
      reason: 'Topic shared',
      sourceType: 'SHARE',
      sourceId: event.topicId,
      idempotencyKey: `share:${event.topicId}:${event.userId}`,
    });

    if (created) {
      await createNotification({
        userId: event.userId,
        title: 'Tokens earned',
        message: `You earned +${config.TOPIC_SHARE_AMOUNT} tokens for sharing a topic.`,
        type: 'REWARD',
      });
    }
  } catch (err) {
    logger.error({ err, event }, 'reward hook onTopicShare failed');
  }
}
