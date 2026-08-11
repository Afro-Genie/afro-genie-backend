import { ModerationAction } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { ApiError } from '../middleware/errorHandler';
import { REWARD_CONFIG } from '../config/rewards';
import { clawbackTokens, forcePenalizeTokens } from './tokenService';
import { recomputeTier } from './tierService';
import { createNotification } from './notificationService';

// ---------------------------------------------------------------------------
// Arbitration (Phase 2 governance).
//
// ARBITERs (and admins) can overturn an erroneous translation approval. The
// moderator's reward is clawed back (idempotent), the contributor's tier is
// recomputed and the event is recorded so approval quality can be measured
// via the overturn rate.
// ---------------------------------------------------------------------------

export async function overturnApproval(
  translationId: string,
  arbiterId: string,
  reason?: string,
): Promise<{ id: string; status: string; overturned: boolean }> {
  const result = await prisma.$transaction(async (tx) => {
    const translation = await tx.translation.findUnique({
      where: { id: translationId },
      select: {
        id: true,
        status: true,
        userId: true,
        approvedById: true,
        approvedAt: true,
      },
    });

    if (!translation) {
      throw new ApiError('Translation not found', 'NOT_FOUND', 404);
    }

    if (translation.status !== 'APPROVED') {
      return { id: translation.id, status: translation.status, applied: false };
    }

    await tx.translation.update({
      where: { id: translationId },
      data: {
        status: 'PENDING',
        approvedById: null,
        approvedAt: null,
        reviewedById: arbiterId,
        reviewedAt: new Date(),
        rejectionReason: reason ?? 'Overturned by arbiter review',
      },
    });

    await tx.moderationLog.create({
      data: {
        action: ModerationAction.APPROVAL_OVERTURNED,
        moderatorId: arbiterId,
        targetType: 'TRANSLATION',
        targetId: translationId,
        reason: reason ?? null,
        metadata: { previouslyApprovedById: translation.approvedById },
      },
    });

    return {
      id: translation.id,
      status: 'PENDING',
      applied: true,
      authorId: translation.userId,
      reviewerId: translation.approvedById,
    };
  });

  if (result.applied) {
    if (result.reviewerId) {
      try {
        // Reverse the reward that was paid out for the approval.
        await clawbackTokens({
          userId: result.reviewerId,
          amount: -REWARD_CONFIG.TRANSLATION_APPROVED_AMOUNT,
          reason: 'Reward clawed back after approval overturned',
          sourceType: 'OVERTURN_CLAWBACK',
          sourceId: translationId,
          idempotencyKey: `translation-overturn:${translationId}`,
        });

        // Governance penalty on top of the clawback (recorded even if the
        // moderator's balance is already spent).
        await forcePenalizeTokens({
          userId: result.reviewerId,
          amount: -REWARD_CONFIG.OVERTURN_PENALTY_AMOUNT,
          reason: 'Approval overturned by arbiter',
          sourceType: 'OVERTURN_PENALTY',
          sourceId: translationId,
          idempotencyKey: `overturn-penalty:${translationId}`,
        });

        await createNotification({
          userId: result.reviewerId,
          title: 'Approval overturned',
          message: `An approval you made was overturned by an arbiter. The reward was revoked and a ${REWARD_CONFIG.OVERTURN_PENALTY_AMOUNT}-token penalty was applied.`,
          type: 'MODERATION',
        });
      } catch (err) {
        logger.error({ err, translationId }, 'penalty after overturn failed');
      }
    }

    try {
      if (result.authorId) {
        await recomputeTier(result.authorId);
      }
    } catch (err) {
      logger.error({ err, translationId }, 'tier recompute after overturn failed');
    }
  }

  return { id: result.id, status: result.status, overturned: result.applied };
}

export async function getOverturnRate(days = 30): Promise<{
  periodDays: number;
  approvals: number;
  overturns: number;
  rate: number;
}> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [overturns, approvals] = await Promise.all([
    prisma.moderationLog.count({
      where: {
        action: ModerationAction.APPROVAL_OVERTURNED,
        createdAt: { gte: since },
      },
    }),
    prisma.translation.count({
      where: { approvedAt: { gte: since }, status: { not: 'PENDING' } },
    }),
  ]);

  const rate = approvals > 0 ? overturns / approvals : 0;

  return { periodDays: days, approvals, overturns, rate: Number(rate.toFixed(4)) };
}
