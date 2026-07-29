import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../middleware/errorHandler';
import { queueReward } from '../../services/rewardService';
import { logger } from '../../lib/logger';

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
