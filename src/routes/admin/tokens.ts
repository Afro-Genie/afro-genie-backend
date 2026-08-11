import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../middleware/errorHandler';
import { adjustTokens } from '../../services/tokenService';

export const adminTokensRouter = Router();

adminTokensRouter.use(authenticate, requireRole('ADMIN'));

// ---------------------------------------------------------------------------
// POST /api/admin/tokens/adjust
// Body { userId, amount, reason }. Manual credit/debit with a fresh ledger row.
// ---------------------------------------------------------------------------
adminTokensRouter.post(
  '/tokens/adjust',
  [
    body('userId').isString().notEmpty().withMessage('userId is required'),
    body('amount').isInt({ allow_leading_zeroes: false }).withMessage('amount must be a non-zero integer'),
    body('reason').isString().isLength({ min: 1, max: 500 }).withMessage('reason is required'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, amount, reason } = req.body as { userId: string; amount: number; reason: string };

      if (amount === 0) {
        return next(new ApiError('Adjustment amount cannot be zero', 'VALIDATION_ERROR', 400));
      }

      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) {
        return next(new ApiError('User not found', 'NOT_FOUND', 404));
      }

      const ledger = await adjustTokens({
        userId,
        amount,
        reason,
        sourceType: 'ADMIN_ADJUST',
      });

      return res.status(200).json({ success: true, rewardId: ledger.id });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/admin/badges/:badgeId
// Revokes a badge from a user.
// ---------------------------------------------------------------------------
adminTokensRouter.delete(
  '/badges/:badgeId',
  [param('badgeId').isString().notEmpty().withMessage('Badge id is required'), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const badge = await prisma.userBadge.findUnique({ where: { id: req.params.badgeId } });
      if (!badge) {
        return next(new ApiError('Badge not found', 'NOT_FOUND', 404));
      }

      await prisma.userBadge.delete({ where: { id: badge.id } });

      return res.status(200).json({
        success: true,
        id: badge.id,
        badgeType: badge.badgeType,
        userId: badge.userId,
      });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/rewards?page=&limit=&userId=&search=
// Paginated ledger with user joins for the rewards manager.
// ---------------------------------------------------------------------------
adminTokensRouter.get(
  '/rewards',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('userId').optional().isString(),
    query('search').optional().isString(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const userId = req.query.userId as string | undefined;
      const search = req.query.search as string | undefined;

      const where: Record<string, unknown> = userId ? { userId } : {};

      const [rows, total] = await Promise.all([
        prisma.tokenLedger.findMany({
          where,
          include: {
            user: {
              select: { id: true, displayName: true, email: true, photoUrl: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.tokenLedger.count({ where }),
      ]);

      const data = search
        ? rows.filter(
            (row) =>
              row.user.displayName?.toLowerCase().includes(search.toLowerCase()) ||
              row.user.email.toLowerCase().includes(search.toLowerCase()),
          )
        : rows;

      return res.status(200).json({
        data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/rewards/stats
// Aggregates for the rewards manager dashboard.
// ---------------------------------------------------------------------------
adminTokensRouter.get(
  '/rewards/stats',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [totalRewards, tokensDistributed, totalBadges, reasonGroups] = await Promise.all([
        prisma.tokenLedger.count(),
        prisma.tokenLedger.aggregate({
          _sum: { amount: true },
          where: { amount: { gt: 0 } },
        }),
        prisma.userBadge.count(),
        prisma.tokenLedger.groupBy({
          by: ['reason'],
          where: { amount: { gt: 0 } },
          _count: { amount: true },
          _sum: { amount: true },
          orderBy: { _sum: { amount: 'desc' } },
          take: 10,
        }),
      ]);

      return res.status(200).json({
        totalRewards,
        totalTokensDistributed: tokensDistributed._sum.amount ?? 0,
        totalBadges,
        topReasons: reasonGroups.map((group) => ({
          reason: group.reason,
          count: group._count.amount,
          totalTokens: group._sum.amount ?? 0,
        })),
      });
    } catch (err) {
      return next(err);
    }
  },
);
