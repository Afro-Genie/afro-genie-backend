import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { ApiError } from '../../middleware/errorHandler';
import { creditTokens } from '../../services/rewardService';
import { checkAndAwardBadges } from '../../services/badgeService';

export const adminRewardsRouter = Router();

adminRewardsRouter.use(authenticate, requireRole('ADMIN'));

adminRewardsRouter.post(
  '/tokens/adjust',
  [
    body('userId').isString().notEmpty().withMessage('User ID is required'),
    body('amount').isInt({ min: -1000, max: 1000 }).withMessage('Amount must be an integer between -1000 and 1000'),
    body('reason').isString().notEmpty().withMessage('Reason is required').isLength({ max: 255 }),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, amount, reason } = req.body as { userId: string; amount: number; reason: string };
      const adminId = req.user!.id;

      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true } });
      if (!user) {
        throw new ApiError('User not found', 'NOT_FOUND', 404);
      }

      const rewardId = await creditTokens(userId, amount, `Admin adjustment: ${reason}`);

      await checkAndAwardBadges(userId, 'ADMIN_ADJUSTMENT').catch((err) => {
        logger.warn({ err, userId }, 'Badge evaluation after admin adjustment failed');
      });

      await prisma.notification.create({
        data: {
          userId,
          title: amount > 0 ? 'Tokens Awarded' : 'Tokens Deducted',
          message: `An admin ${amount > 0 ? 'awarded you' : 'deducted'} ${Math.abs(amount)} token${Math.abs(amount) === 1 ? '' : 's'}: ${reason}`,
          type: 'REWARD',
        },
      });

      res.status(200).json({
        success: true,
        rewardId,
        userId,
        amount,
        reason,
        adjustedBy: adminId,
      });
    } catch (error) {
      next(error);
    }
  },
);

adminRewardsRouter.delete(
  '/badges/:id',
  [param('id').isString().notEmpty().withMessage('Badge ID is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const badge = await prisma.userBadge.findUnique({ where: { id }, select: { id: true, userId: true, badgeType: true } });
      if (!badge) {
        throw new ApiError('Badge not found', 'NOT_FOUND', 404);
      }

      await prisma.userBadge.delete({ where: { id } });

      await prisma.notification.create({
        data: {
          userId: badge.userId,
          title: 'Badge Revoked',
          message: `Your ${badge.badgeType.replace(/_/g, ' ').toLowerCase()} badge has been removed by an administrator.`,
          type: 'REWARD',
        },
      });

      res.status(200).json({ success: true, id, badgeType: badge.badgeType, userId: badge.userId });
    } catch (error) {
      next(error);
    }
  },
);

adminRewardsRouter.get(
  '/rewards',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('userId').optional().isString(),
    query('search').optional().isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(parseInt(req.query.page as string) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const userId = req.query.userId as string | undefined;
      const search = req.query.search as string | undefined;
      const skip = (page - 1) * limit;

      const where: Record<string, unknown> = {};

      if (userId) {
        where.userId = userId;
      }

      if (search) {
        where.OR = [
          { reason: { contains: search, mode: 'insensitive' } },
          { user: { displayName: { contains: search, mode: 'insensitive' } } },
          { user: { email: { contains: search, mode: 'insensitive' } } },
        ];
      }

      const [rewards, total] = await Promise.all([
        prisma.tokenReward.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            userId: true,
            amount: true,
            reason: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                displayName: true,
                email: true,
                photoUrl: true,
              },
            },
          },
        }),
        prisma.tokenReward.count({ where }),
      ]);

      res.status(200).json({
        data: rewards,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

adminRewardsRouter.get(
  '/rewards/stats',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [totalRewards, totalTokensResult, totalBadges, recentRewards] = await Promise.all([
        prisma.tokenReward.count(),
        prisma.tokenReward.aggregate({ _sum: { amount: true } }),
        prisma.userBadge.count(),
        prisma.tokenReward.groupBy({
          by: ['reason'],
          _count: { id: true },
          _sum: { amount: true },
          orderBy: { _count: { id: 'desc' } },
          take: 10,
        }),
      ]);

      res.status(200).json({
        totalRewards,
        totalTokensDistributed: totalTokensResult._sum.amount ?? 0,
        totalBadges,
        topReasons: recentRewards.map((r) => ({
          reason: r.reason,
          count: r._count.id,
          totalTokens: r._sum.amount ?? 0,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);
