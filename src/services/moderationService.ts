import type { CorrectionStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { ApiError } from '../middleware/errorHandler';
import { sendEmail } from './emailService';
import { updateLyrics } from './reviewService';
import { onCorrectionApproved, onCorrectionRejected } from './rewardHooks';

// ---------------------------------------------------------------------------
// Moderation analytics + extended moderation endpoints (Phase 2 governance).
// ---------------------------------------------------------------------------

interface ListParams {
  status?: string;
  page?: number;
  limit?: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const clampListParams = (params: ListParams) => {
  const page = Math.max(DEFAULT_PAGE, params.page ?? DEFAULT_PAGE);
  const limit = Math.min(MAX_LIMIT, Math.max(1, params.limit ?? DEFAULT_LIMIT));
  return { page, limit };
};

const buildPagination = <T>(data: T[], total: number, page: number, limit: number) => ({
  data,
  pagination: {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  },
});

// ---------------------------------------------------------------------------
// Moderator leaderboard / stats
// ---------------------------------------------------------------------------
export async function getModStats(moderatorId: string) {
  const [
    reportsResolved,
    correctionsApproved,
    translationsApproved,
    translationsRejected,
    topicsPinned,
    topicsLocked,
    topicsDeleted,
    commentsDeleted,
    tokenSum,
    wallet,
    badges,
  ] = await Promise.all([
    prisma.contentReport.count({ where: { moderatorId, status: 'RESOLVED' } }),
    prisma.translationCorrection.count({ where: { reviewedById: moderatorId, status: 'APPROVED' } }),
    prisma.translation.count({ where: { approvedById: moderatorId, status: 'APPROVED' } }),
    prisma.translation.count({ where: { reviewedById: moderatorId, status: 'REJECTED' } }),
    prisma.moderationLog.count({ where: { moderatorId, action: 'TOPIC_PINNED' } }),
    prisma.moderationLog.count({ where: { moderatorId, action: 'TOPIC_LOCKED' } }),
    prisma.moderationLog.count({ where: { moderatorId, action: 'TOPIC_DELETED' } }),
    prisma.moderationLog.count({ where: { moderatorId, action: 'COMMENT_DELETED' } }),
    prisma.tokenLedger.aggregate({
      where: { userId: moderatorId, type: 'EARN', amount: { gt: 0 } },
      _sum: { amount: true },
    }),
    prisma.userWallet.findUnique({ where: { userId: moderatorId } }),
    prisma.userBadge.findMany({
      where: { userId: moderatorId },
      orderBy: { earnedAt: 'desc' },
    }),
  ]);

  return {
    reportsResolved,
    correctionsApproved,
    translationsApproved,
    translationsRejected,
    topicsPinned,
    topicsLocked,
    topicsDeleted,
    commentsDeleted,
    totalTokensEarned: tokenSum._sum.amount ?? 0,
    currentTokenBalance: wallet?.balance ?? 0,
    badges: badges.map((badge) => ({
      badgeType: badge.badgeType,
      earnedAt: badge.earnedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Correction requests (legacy client contract)
// ---------------------------------------------------------------------------
export async function listCorrectionRequests(params: ListParams = {}) {
  const { page, limit } = clampListParams(params);
  const where: Prisma.TranslationCorrectionWhereInput = params.status
    ? { status: params.status as CorrectionStatus }
    : {};

  const [rows, total] = await Promise.all([
    prisma.translationCorrection.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: { select: { id: true, displayName: true, email: true } },
        reviewedBy: { select: { id: true, displayName: true } },
        translation: {
          select: {
            id: true,
            sourceLang: true,
            targetLang: true,
            song: { select: { id: true, title: true } },
          },
        },
      },
    }),
    prisma.translationCorrection.count({ where }),
  ]);

  const data = rows.map((correction) => ({
    id: correction.id,
    title: correction.reason ?? '',
    description: correction.suggestedText,
    status: correction.status,
    createdAt: correction.createdAt,
    resolvedAt: correction.reviewedAt,
    moderatorNote: correction.moderatorNote,
    user: correction.user,
    resolvedBy: correction.reviewedBy,
    song: correction.translation?.song ?? null,
    translation: correction.translation
      ? {
          id: correction.translation.id,
          sourceLang: correction.translation.sourceLang,
          targetLang: correction.translation.targetLang,
        }
      : null,
  }));

  return buildPagination(data, total, page, limit);
}

export async function resolveCorrectionRequest(
  id: string,
  correctedLyrics: string,
  moderatorId: string,
  moderatorNote?: string,
): Promise<{ id: string; status: string }> {
  const correction = await prisma.translationCorrection.findUnique({
    where: { id },
    include: { translation: { select: { id: true, userId: true, songId: true } } },
  });

  if (!correction) {
    throw new ApiError('Correction request not found', 'NOT_FOUND', 404);
  }

  if (correction.status !== 'PENDING') {
    return { id: correction.id, status: correction.status };
  }

  await prisma.$transaction(async (tx) => {
    await tx.translationCorrection.update({
      where: { id },
      data: {
        status: 'APPROVED',
        reviewedById: moderatorId,
        reviewedAt: new Date(),
        moderatorNote: moderatorNote ?? null,
      },
    });
    await tx.translation.update({
      where: { id: correction.translationId },
      data: {
        translatedLyrics: correctedLyrics,
        status: 'PENDING',
        approvedById: null,
        approvedAt: null,
        rejectionReason: null,
      },
    });
  });

  try {
    await updateLyrics(correction.translation.songId, correctedLyrics);
  } catch (err) {
    logger.error({ err, correctionId: id }, 'lyrics update on correction resolve failed');
  }

  await onCorrectionApproved({
    correctionId: correction.id,
    translationId: correction.translationId,
    userId: correction.userId,
    reviewerId: moderatorId,
  });

  return { id: correction.id, status: 'APPROVED' };
}

export async function rejectCorrectionRequest(
  id: string,
  moderatorId: string,
  moderatorNote?: string,
): Promise<{ id: string; status: string }> {
  const correction = await prisma.translationCorrection.findUnique({ where: { id } });

  if (!correction) {
    throw new ApiError('Correction request not found', 'NOT_FOUND', 404);
  }

  if (correction.status !== 'PENDING') {
    return { id: correction.id, status: correction.status };
  }

  await prisma.translationCorrection.update({
    where: { id },
    data: {
      status: 'REJECTED',
      reviewedById: moderatorId,
      reviewedAt: new Date(),
      moderatorNote: moderatorNote ?? null,
    },
  });

  await onCorrectionRejected({
    correctionId: correction.id,
    translationId: correction.translationId,
    userId: correction.userId,
    reviewerId: moderatorId,
  });

  return { id: correction.id, status: 'REJECTED' };
}

// ---------------------------------------------------------------------------
// Moderation guidelines
// ---------------------------------------------------------------------------
export async function getGuidelines() {
  const latest = await prisma.guideline.findFirst({
    orderBy: { updatedAt: 'desc' },
    include: { updatedByUser: { select: { id: true, displayName: true } } },
  });

  if (!latest) return null;

  return {
    id: latest.id,
    content: latest.content,
    version: latest.version,
    updatedBy: latest.updatedByUser.displayName ?? 'System',
    updatedAt: latest.updatedAt,
  };
}

export async function updateGuidelines(content: string, userId: string) {
  const latest = await prisma.guideline.findFirst({ orderBy: { updatedAt: 'desc' } });
  const version = (latest?.version ?? 0) + 1;

  const created = await prisma.guideline.create({
    data: { content, version, updatedBy: userId },
    include: { updatedByUser: { select: { id: true, displayName: true } } },
  });

  return {
    id: created.id,
    content: created.content,
    version: created.version,
    updatedBy: created.updatedByUser.displayName ?? 'System',
    updatedAt: created.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Welcome messages
// ---------------------------------------------------------------------------
export async function sendWelcomeMessage(userId: string, message: string) {
  const { user, alreadyWelcomed } = await prisma.$transaction(async (tx) => {
    const claimed = await tx.user.updateMany({
      where: { id: userId, moderatorWelcomedAt: null },
      data: { moderatorWelcomedAt: new Date() },
    });

    if (claimed.count === 0) {
      const existingUser = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, displayName: true, moderatorWelcomedAt: true },
      });
      if (!existingUser) throw new ApiError('User not found', 'NOT_FOUND', 404);
      if (existingUser.moderatorWelcomedAt) {
        return {
          user: {
            id: existingUser.id,
            email: existingUser.email,
            displayName: existingUser.displayName,
          },
          alreadyWelcomed: true,
        };
      }
      throw new ApiError('Unable to claim user for welcome message', 'CONFLICT', 409);
    }

    const welcomedUser = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, displayName: true },
    });

    await tx.notification.create({
      data: {
        userId,
        title: 'Welcome to Afro Genie!',
        message,
        type: 'SYSTEM',
      },
    });

    return { user: welcomedUser, alreadyWelcomed: false };
  });

  let emailSent = false;
  try {
    emailSent = await sendEmail({
      to: user.email,
      subject: 'Welcome to Afro Genie!',
      text: `Hi ${user.displayName ?? 'there'}, welcome to Afro Genie! ${message}`,
      html: `<p>Hi ${user.displayName ?? 'there'},</p><p>Welcome to Afro Genie!</p><p>${message}</p><p>Start translating songs and earning tokens today.</p>`,
    });
  } catch (err) {
    logger.error({ err, userId }, 'welcome email send failed');
  }

  return { ok: true, emailSent, alreadyWelcomed };
}

// ---------------------------------------------------------------------------
// Artist applications + recommendations
// ---------------------------------------------------------------------------
export async function listArtistApplications(params: ListParams = {}) {
  const { page, limit } = clampListParams(params);
  const where: Prisma.ArtistApplicationWhereInput = params.status
    ? { status: params.status as 'PENDING' | 'APPROVED' | 'REJECTED' }
    : {};

  const [rows, total] = await Promise.all([
    prisma.artistApplication.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: { select: { id: true, displayName: true, email: true } },
        recommendations: {
          select: {
            id: true,
            moderatorId: true,
            notes: true,
            createdAt: true,
            moderator: { select: { displayName: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    }),
    prisma.artistApplication.count({ where }),
  ]);

  const data = rows.map((application) => ({
    id: application.id,
    stageName: application.stageName,
    genre: application.genre,
    bio: application.bio,
    status: application.status,
    createdAt: application.createdAt,
    user: application.user,
    recommendations: application.recommendations.map((rec) => ({
      id: rec.id,
      moderatorId: rec.moderatorId,
      moderatorName: rec.moderator.displayName ?? 'Unknown',
      notes: rec.notes,
      createdAt: rec.createdAt,
    })),
  }));

  return buildPagination(data, total, page, limit);
}

export async function recommendApplication(id: string, notes: string, moderatorId: string) {
  const application = await prisma.artistApplication.findUnique({ where: { id } });
  if (!application) {
    throw new ApiError('Artist application not found', 'NOT_FOUND', 404);
  }

  const recommendation = await prisma.artistApplicationRecommendation.create({
    data: { applicationId: id, moderatorId, notes: notes.trim() || null },
  });

  return { id: recommendation.id, notes: recommendation.notes };
}

// ---------------------------------------------------------------------------
// New users
// ---------------------------------------------------------------------------
export async function listNewUsers(params: { days?: number; page?: number; limit?: number } = {}) {
  const { page, limit } = clampListParams(params);
  const days = Math.min(365, Math.max(1, params.days ?? 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const where: Prisma.UserWhereInput = { createdAt: { gte: since } };

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        displayName: true,
        email: true,
        photoUrl: true,
        role: true,
        createdAt: true,
        lastLoginAt: true,
        _count: { select: { translations: true, topics: true, topicComments: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return buildPagination(rows, total, page, limit);
}
