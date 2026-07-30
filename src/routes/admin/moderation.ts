import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../middleware/errorHandler';
import { queueReward, getUserTokenBalance } from '../../services/rewardService';
import { logger } from '../../lib/logger';
import { logModAction } from '../../services/moderationAuditService';
import { getGuidelines, upsertGuidelines } from '../../services/guidelinesService';

export const adminModerationRouter = Router();

adminModerationRouter.use(authenticate, requireRole('MODERATOR', 'ADMIN'));

adminModerationRouter.get(
  '/moderation/reports',
  [
    query('status').optional().isIn(['PENDING', 'DISMISSED', 'RESOLVED']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(parseInt(req.query.page as string) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const status = req.query.status as string | undefined;
      const skip = (page - 1) * limit;

      const where: Record<string, unknown> = {};
      if (status) where.status = status;

      const [reports, total] = await Promise.all([
        prisma.contentReport.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            targetType: true,
            targetId: true,
            reason: true,
            description: true,
            status: true,
            createdAt: true,
            resolvedAt: true,
            reporter: { select: { id: true, displayName: true, email: true } },
            moderator: { select: { id: true, displayName: true } },
          },
        }),
        prisma.contentReport.count({ where }),
      ]);

      res.json({
        data: reports,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  },
);

adminModerationRouter.patch(
  '/moderation/reports/:id/resolve',
  [param('id').isString().notEmpty(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reportId = req.params.id;
      const moderatorId = req.user!.id;

      const report = await prisma.contentReport.findUnique({ where: { id: reportId } });
      if (!report) throw new ApiError('Report not found', 'NOT_FOUND', 404);
      if (report.status !== 'PENDING') throw new ApiError('Report is already resolved or dismissed', 'CONFLICT', 409);

      const resolved = await prisma.contentReport.update({
        where: { id: reportId },
        data: { status: 'RESOLVED', moderatorId, resolvedAt: new Date() },
        select: { id: true, status: true, resolvedAt: true, moderatorId: true },
      });

      await queueReward(moderatorId, 2, 'Report resolved', 'MODERATOR_ACTION', `report-resolve:${reportId}:${moderatorId}`);

      logger.info({ reportId, moderatorId }, 'Content report resolved');

      res.json(resolved);
    } catch (error) {
      next(error);
    }
  },
);

adminModerationRouter.patch(
  '/moderation/reports/:id/dismiss',
  [param('id').isString().notEmpty(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reportId = req.params.id;
      const moderatorId = req.user!.id;

      const report = await prisma.contentReport.findUnique({ where: { id: reportId } });
      if (!report) throw new ApiError('Report not found', 'NOT_FOUND', 404);
      if (report.status !== 'PENDING') throw new ApiError('Report is already resolved or dismissed', 'CONFLICT', 409);

      const dismissed = await prisma.contentReport.update({
        where: { id: reportId },
        data: { status: 'DISMISSED', moderatorId, resolvedAt: new Date() },
        select: { id: true, status: true, resolvedAt: true },
      });

      logger.info({ reportId, moderatorId }, 'Content report dismissed');

      res.json(dismissed);
    } catch (error) {
      next(error);
    }
  },
);

adminModerationRouter.get(
  '/moderation/reports/stats',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [pending, resolved, dismissed] = await Promise.all([
        prisma.contentReport.count({ where: { status: 'PENDING' } }),
        prisma.contentReport.count({ where: { status: 'RESOLVED' } }),
        prisma.contentReport.count({ where: { status: 'DISMISSED' } }),
      ]);

      const topModerators = await prisma.contentReport.groupBy({
        by: ['moderatorId'],
        where: { status: 'RESOLVED', moderatorId: { not: null } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      });

      const modIds = topModerators.map((m) => m.moderatorId).filter(Boolean) as string[];
      const modUsers = modIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: modIds } },
            select: { id: true, displayName: true },
          })
        : [];

      const modMap = new Map(modUsers.map((u) => [u.id, u.displayName]));

      res.json({
        pending,
        resolved,
        dismissed,
        total: pending + resolved + dismissed,
        topModerators: topModerators.map((m) => ({
          moderatorId: m.moderatorId,
          displayName: modMap.get(m.moderatorId!) ?? 'Unknown',
          resolvedCount: m._count.id,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

// ─── 1.2 Translation listing for review queue ─────────────────────────────────

adminModerationRouter.get(
  '/moderation/translations',
  [
    query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED', 'PUBLISHED']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(parseInt(req.query.page as string) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const status = req.query.status as string | undefined;
      const skip = (page - 1) * limit;

      const where: Record<string, unknown> = {};
      if (status) where.status = status;

      const [translations, total] = await Promise.all([
        prisma.translation.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            originalLyrics: true,
            translatedLyrics: true,
            culturalContext: true,
            sourceLang: true,
            targetLang: true,
            status: true,
            createdAt: true,
            user: { select: { id: true, displayName: true, email: true } },
            song: { select: { id: true, title: true, artist: { select: { name: true } } } },
          },
        }),
        prisma.translation.count({ where }),
      ]);

      res.json({
        data: translations,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  },
);

adminModerationRouter.patch(
  '/moderation/translations/:id/approve',
  [param('id').isString().notEmpty(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const translationId = req.params.id;
      const moderatorId = req.user!.id;

      const translation = await prisma.translation.findUnique({
        where: { id: translationId },
        select: { id: true, userId: true, status: true, songId: true },
      });

      if (!translation) throw new ApiError('Translation not found', 'NOT_FOUND', 404);
      if (translation.status !== 'PENDING') {
        throw new ApiError('Translation is not in PENDING status', 'CONFLICT', 409);
      }

      await prisma.translation.update({
        where: { id: translationId },
        data: { status: 'APPROVED', updatedAt: new Date() },
      });

      await queueReward(translation.userId, 5, 'Translation approved', 'TRANSLATION_APPROVED', `translation-approve:${translationId}`);

      await prisma.notification.create({
        data: {
          userId: translation.userId,
          title: 'Translation Approved',
          message: 'Your translation has been approved by a moderator.',
          type: 'REWARD',
        },
      });

      await logModAction({
        moderatorId,
        actionType: 'TRANSLATION_APPROVE',
        targetId: translationId,
        targetType: 'translation',
      });

      logger.info({ translationId, moderatorId }, 'Translation approved');

      res.json({ id: translationId, status: 'APPROVED' as const });
    } catch (error) {
      next(error);
    }
  },
);

// ─── 1.3 Correction listing endpoint ──────────────────────────────────────────

adminModerationRouter.get(
  '/moderation/corrections',
  [
    query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(parseInt(req.query.page as string) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const status = req.query.status as string | undefined;
      const skip = (page - 1) * limit;

      const where: Record<string, unknown> = {};
      if (status) where.status = status;

      const [corrections, total] = await Promise.all([
        prisma.translationCorrection.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            originalText: true,
            suggestedText: true,
            reason: true,
            status: true,
            createdAt: true,
            user: { select: { id: true, displayName: true, email: true } },
            translation: {
              select: {
                id: true,
                originalLyrics: true,
                translatedLyrics: true,
                sourceLang: true,
                targetLang: true,
                song: { select: { id: true, title: true } },
              },
            },
          },
        }),
        prisma.translationCorrection.count({ where }),
      ]);

      res.json({
        data: corrections,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  },
);

// ─── 1.4 Correction Requests listing endpoint ─────────────────────────────────

adminModerationRouter.get(
  '/moderation/correction-requests',
  [
    query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(parseInt(req.query.page as string) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const status = req.query.status as string | undefined;
      const skip = (page - 1) * limit;

      const where: Record<string, unknown> = {};
      if (status) where.status = status;

      const [requests, total] = await Promise.all([
        prisma.correctionRequest.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            createdAt: true,
            resolvedAt: true,
            moderatorNote: true,
            user: { select: { id: true, displayName: true, email: true } },
            resolvedBy: { select: { id: true, displayName: true } },
            song: { select: { id: true, title: true } },
            translation: { select: { id: true, sourceLang: true, targetLang: true } },
          },
        }),
        prisma.correctionRequest.count({ where }),
      ]);

      res.json({
        data: requests,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  },
);

// ─── 1.5 Resolve a correction request ──────────────────────────────────────────

adminModerationRouter.patch(
  '/moderation/correction-requests/:id/resolve',
  [
    param('id').isString().notEmpty(),
    body('correctedLyrics').isString().notEmpty().withMessage('correctedLyrics is required'),
    body('moderatorNote').optional().isString(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestId = req.params.id;
      const moderatorId = req.user!.id;
      const { correctedLyrics, moderatorNote } = req.body as { correctedLyrics: string; moderatorNote?: string };

      const correctionRequest = await prisma.correctionRequest.findUnique({
        where: { id: requestId },
        include: { translation: { select: { id: true, songId: true } } },
      });

      if (!correctionRequest) throw new ApiError('Correction request not found', 'NOT_FOUND', 404);
      if (correctionRequest.status !== 'PENDING') throw new ApiError('Correction request is not in PENDING status', 'CONFLICT', 409);
      if (!correctionRequest.translation) throw new ApiError('Associated translation not found', 'NOT_FOUND', 404);

      await prisma.$transaction([
        prisma.translation.update({
          where: { id: correctionRequest.translation.id },
          data: {
            translatedLyrics: correctedLyrics,
            correctedById: moderatorId,
            correctionRequestId: requestId,
            correctedAt: new Date(),
            updatedAt: new Date(),
          },
        }),
        prisma.correctionRequest.update({
          where: { id: requestId },
          data: { status: 'APPROVED', resolvedById: moderatorId, resolvedAt: new Date(), moderatorNote: moderatorNote ?? null },
        }),
      ]);

      await queueReward(moderatorId, 3, 'Correction request resolved', 'MODERATOR_ACTION', `correction-request-resolve:${requestId}:${moderatorId}`);

      await queueReward(
        correctionRequest.userId,
        5,
        'Correction request fulfilled',
        'TRANSLATION_REQUEST_FULFILLED',
        `correction-request-fulfilled:${requestId}`,
      );

      await prisma.notification.create({
        data: {
          userId: correctionRequest.userId,
          title: 'Correction Request Completed',
          message: `Your correction request "${correctionRequest.title}" has been resolved and the translation has been updated.`,
          type: 'REWARD',
        },
      });

      logger.info({ requestId, moderatorId, translationId: correctionRequest.translation.id }, 'Correction request resolved');

      res.json({ id: requestId, status: 'APPROVED' });
    } catch (error) {
      next(error);
    }
  },
);

// ─── 1.6 Reject a correction request ───────────────────────────────────────────

adminModerationRouter.patch(
  '/moderation/correction-requests/:id/reject',
  [
    param('id').isString().notEmpty(),
    body('moderatorNote').optional().isString(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestId = req.params.id;
      const moderatorId = req.user!.id;
      const { moderatorNote } = req.body as { moderatorNote?: string };

      const correctionRequest = await prisma.correctionRequest.findUnique({
        where: { id: requestId },
        select: { id: true, status: true, userId: true, title: true },
      });

      if (!correctionRequest) throw new ApiError('Correction request not found', 'NOT_FOUND', 404);
      if (correctionRequest.status !== 'PENDING') throw new ApiError('Correction request is not in PENDING status', 'CONFLICT', 409);

      await prisma.correctionRequest.update({
        where: { id: requestId },
        data: { status: 'REJECTED', resolvedById: moderatorId, resolvedAt: new Date(), moderatorNote: moderatorNote ?? null },
      });

      await prisma.notification.create({
        data: {
          userId: correctionRequest.userId,
          title: 'Correction Request Not Approved',
          message: `Your correction request "${correctionRequest.title}" was not approved.${moderatorNote ? ` Reason: ${moderatorNote}` : ''}`,
          type: 'MODERATION',
        },
      });

      logger.info({ requestId, moderatorId }, 'Correction request rejected');

      res.json({ id: requestId, status: 'REJECTED' });
    } catch (error) {
      next(error);
    }
  },
);

// ─── 1.7 Moderator stats endpoint ─────────────────────────────────────────────

adminModerationRouter.get(
  '/moderation/moderator/:id/stats',
  [param('id').isString().notEmpty(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const moderatorId = req.params.id;

      const [
        reportsResolved,
        totalTokensResult,
        badges,
        modActionCounts,
      ] = await Promise.all([
        prisma.contentReport.count({ where: { moderatorId, status: 'RESOLVED' } }),
        prisma.tokenReward.aggregate({
          _sum: { amount: true },
          where: { userId: moderatorId },
        }),
        prisma.userBadge.findMany({
          where: { userId: moderatorId },
          select: { badgeType: true, earnedAt: true },
          orderBy: { earnedAt: 'desc' },
        }),
        prisma.modActionLog.groupBy({
          by: ['actionType'],
          where: { moderatorId },
          _count: { id: true },
        }),
      ]);

      const currentTokenBalance = await getUserTokenBalance(moderatorId);

      const statsMap = new Map(modActionCounts.map((m) => [m.actionType, m._count.id]));

      res.json({
        reportsResolved,
        correctionsApproved: statsMap.get('CORRECTION_APPROVE') ?? 0,
        translationsApproved: statsMap.get('TRANSLATION_APPROVE') ?? 0,
        translationsRejected: statsMap.get('TRANSLATION_REJECT') ?? 0,
        topicsPinned: statsMap.get('TOPIC_PIN') ?? 0,
        topicsLocked: statsMap.get('TOPIC_LOCK') ?? 0,
        topicsDeleted: statsMap.get('TOPIC_DELETE') ?? 0,
        totalTokensEarned: totalTokensResult._sum.amount ?? 0,
        currentTokenBalance,
        badges,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ─── 1.5 Artist verification support for moderators ───────────────────────────

adminModerationRouter.get(
  '/moderation/artist-applications',
  [
    query('status').optional().isIn(['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(parseInt(req.query.page as string) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const status = req.query.status as string | undefined;
      const skip = (page - 1) * limit;

      const where: Record<string, unknown> = {};
      if (status) where.status = status;

      const [applications, total] = await Promise.all([
        prisma.artistApplication.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            stageName: true,
            genre: true,
            bio: true,
            status: true,
            createdAt: true,
            user: { select: { id: true, displayName: true, email: true } },
            recommendations: {
              select: { id: true, moderatorId: true, notes: true, createdAt: true },
            },
          },
        }),
        prisma.artistApplication.count({ where }),
      ]);

      res.json({
        data: applications,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  },
);

adminModerationRouter.patch(
  '/moderation/artist-applications/:id/recommend',
  [
    param('id').isString().notEmpty(),
    body('notes').isString().notEmpty().withMessage('Recommendation notes are required'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const applicationId = req.params.id;
      const { notes } = req.body as { notes: string };
      const moderatorId = req.user!.id;

      const application = await prisma.artistApplication.findUnique({
        where: { id: applicationId },
        select: { id: true, status: true },
      });

      if (!application) throw new ApiError('Application not found', 'NOT_FOUND', 404);

      const recommendation = await prisma.artistApplicationRecommendation.upsert({
        where: { applicationId_moderatorId: { applicationId, moderatorId } },
        create: { applicationId, moderatorId, notes },
        update: { notes },
      });

      await logModAction({
        moderatorId,
        actionType: 'ARTIST_APPLICATION_RECOMMEND',
        targetId: applicationId,
        targetType: 'artist_application',
        details: notes,
      });

      logger.info({ applicationId, moderatorId }, 'Artist application recommendation added');

      res.json(recommendation);
    } catch (error) {
      next(error);
    }
  },
);

// ─── 1.6 New users listing for onboarding ─────────────────────────────────────

adminModerationRouter.get(
  '/moderation/new-users',
  [
    query('days').optional().isInt({ min: 1, max: 365 }).toInt(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(parseInt(req.query.page as string) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 365);
      const skip = (page - 1) * limit;

      const since = new Date();
      since.setDate(since.getDate() - days);

      const where = { createdAt: { gte: since } };

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            displayName: true,
            email: true,
            photoUrl: true,
            role: true,
            createdAt: true,
            lastLoginAt: true,
            _count: {
              select: {
                translations: true,
                topics: true,
                topicComments: true,
              },
            },
          },
        }),
        prisma.user.count({ where }),
      ]);

      res.json({
        data: users,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  },
);

// ─── 1.7 Community guidelines endpoints ──────────────────────────────────────

adminModerationRouter.get(
  '/moderation/guidelines',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const guideline = await getGuidelines();

      if (!guideline) {
        res.json({
          content: 'No community guidelines have been set yet.',
          version: 0,
          updatedBy: null,
          updatedAt: null,
        });
        return;
      }

      res.json(guideline);
    } catch (error) {
      next(error);
    }
  },
);

adminModerationRouter.put(
  '/moderation/guidelines',
  [
    body('content').isString().notEmpty().withMessage('Guidelines content is required'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { content } = req.body as { content: string };
      const moderatorId = req.user!.id;

      const guideline = await upsertGuidelines(content, moderatorId);

      await logModAction({
        moderatorId,
        actionType: 'GUIDELINES_UPDATE',
        targetId: guideline.id,
        targetType: 'guideline',
        details: `Updated to version ${guideline.version}`,
      });

      logger.info({ guidelineId: guideline.id, version: guideline.version, moderatorId }, 'Community guidelines updated');

      res.json(guideline);
    } catch (error) {
      next(error);
    }
  },
);
