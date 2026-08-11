import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { REWARD_CONFIG } from '../config/rewards';
import { awardTokens } from './tokenService';
import { getMultiplier, recomputeTier } from './tierService';
import { createNotification } from './notificationService';
import { contributeTax } from './modPoolService';
import { evaluateTranslationBadges } from './badgeService';

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

/** Moderator +10 (flat) for an approval; contributor tier recompute. */
export async function onTranslationApproved(event: TranslationApprovedEvent): Promise<void> {
  try {
    await recomputeTier(event.userId);

    await awardTokens({
      userId: event.reviewerId,
      type: 'EARN',
      amount: REWARD_CONFIG.TRANSLATION_APPROVED_AMOUNT,
      reason: 'Translation approved',
      sourceType: 'TRANSLATION_APPROVED',
      sourceId: event.translationId,
      idempotencyKey: `translation-approved:${event.translationId}:${event.reviewerId}`,
    });

    await createNotification({
      userId: event.userId,
      title: 'Translation approved',
      message: 'Your translation was approved by a moderator.',
      type: 'TRANSLATION',
    });
    await createNotification({
      userId: event.reviewerId,
      title: 'Review reward',
      message: `You earned +${REWARD_CONFIG.TRANSLATION_APPROVED_AMOUNT} tokens for approving a translation.`,
      type: 'REWARD',
    });

    // 10% of the reviewer reward flows into the moderation pool.
    await contributeTax({
      userId: event.reviewerId,
      rewardAmount: REWARD_CONFIG.TRANSLATION_APPROVED_AMOUNT,
      sourceId: event.translationId,
    });

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
    if (await countToday(event.userId, 'CORRECTION') >= REWARD_CONFIG.CORRECTION_DAILY_CAP) {
      return;
    }

    const multiplier = await getMultiplier(event.userId);
    const amount = Math.round(REWARD_CONFIG.CORRECTION_APPROVED_AMOUNT * multiplier);

    await awardTokens({
      userId: event.userId,
      type: 'EARN',
      amount,
      reason: 'Correction approved',
      sourceType: 'CORRECTION',
      sourceId: event.correctionId,
      idempotencyKey: `correction:${event.correctionId}`,
    });

    await createNotification({
      userId: event.userId,
      title: 'Correction approved',
      message: `Your correction was approved. You earned +${amount} tokens.`,
      type: 'REWARD',
    });
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

/** +2 (×tier) when an AI translation job actually generates content. */
export async function onAiTranslationCompleted(event: AiTranslationCompletedEvent): Promise<void> {
  try {
    if (await countToday(event.userId, 'AI_TRANSLATION') >= REWARD_CONFIG.AI_TRANSLATION_DAILY_CAP) {
      return;
    }

    const multiplier = await getMultiplier(event.userId);
    const amount = Math.round(REWARD_CONFIG.AI_TRANSLATION_AMOUNT * multiplier);

    await awardTokens({
      userId: event.userId,
      type: 'EARN',
      amount,
      reason: 'AI translation generated',
      sourceType: 'AI_TRANSLATION',
      sourceId: event.jobId,
      idempotencyKey: `ai-trigger:${event.jobId}`,
    });

    await createNotification({
      userId: event.userId,
      title: 'Tokens earned',
      message: `You earned +${amount} tokens for generating an AI translation.`,
      type: 'REWARD',
    });
  } catch (err) {
    logger.error({ err, event }, 'reward hook onAiTranslationCompleted failed');
  }
}

/** +2 for sharing a topic. */
export async function onTopicShare(event: TopicShareEvent): Promise<void> {
  try {
    if (await countToday(event.userId, 'SHARE') >= REWARD_CONFIG.TOPIC_SHARE_DAILY_CAP) {
      return;
    }

    await awardTokens({
      userId: event.userId,
      type: 'EARN',
      amount: REWARD_CONFIG.TOPIC_SHARE_AMOUNT,
      reason: 'Topic shared',
      sourceType: 'SHARE',
      sourceId: event.topicId,
      idempotencyKey: `share:${event.topicId}:${event.userId}`,
    });

    await createNotification({
      userId: event.userId,
      title: 'Tokens earned',
      message: `You earned +${REWARD_CONFIG.TOPIC_SHARE_AMOUNT} tokens for sharing a topic.`,
      type: 'REWARD',
    });
  } catch (err) {
    logger.error({ err, event }, 'reward hook onTopicShare failed');
  }
}
