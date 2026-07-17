import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../middleware/errorHandler';

export const adminRoleRequestsRouter = Router();

adminRoleRequestsRouter.use(authenticate, requireRole('ADMIN'));

adminRoleRequestsRouter.get(
  '/role-requests',
  [
    query('cursor').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED']),
    query('role').optional().isIn(['ARTIST', 'MODERATOR']),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const cursor = req.query.cursor as string | undefined;
      const status = req.query.status as string | undefined;
      const role = req.query.role as string | undefined;

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (role) where.role = role;

      const [requests, total] = await Promise.all([
        prisma.roleRequest.findMany({
          where,
          include: {
            user: {
              select: {
                id: true,
                email: true,
                displayName: true,
                photoUrl: true,
                role: true,
              },
            },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
        prisma.roleRequest.count({ where }),
      ]);

      const hasMore = requests.length > limit;
      const data = hasMore ? requests.slice(0, limit) : requests;
      const nextCursor = hasMore ? data[data.length - 1].id : null;

      res.status(200).json({ data, total, nextCursor });
    } catch (error) {
      next(error);
    }
  },
);

adminRoleRequestsRouter.patch(
  '/role-requests/:id',
  [
    param('id').isString().notEmpty().withMessage('Request ID is required'),
    body('status')
      .isIn(['APPROVED', 'REJECTED'])
      .withMessage('Status must be APPROVED or REJECTED'),
    body('notes').optional().isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { status, notes } = req.body as { status: 'APPROVED' | 'REJECTED'; notes?: string };
      const adminId = (req as any).user.id;

      const roleRequest = await prisma.roleRequest.findUnique({
        where: { id },
        include: { user: true },
      });

      if (!roleRequest) {
        throw new ApiError('Role request not found', 'NOT_FOUND', 404);
      }

      if (roleRequest.status !== 'PENDING' && roleRequest.status !== 'UNDER_REVIEW') {
        throw new ApiError(
          `Request has already been ${roleRequest.status.toLowerCase()}`,
          'CONFLICT',
          409,
        );
      }

      const updated = await prisma.roleRequest.update({
        where: { id },
        data: {
          status,
          notes,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        },
      });

      if (status === 'APPROVED') {
        await prisma.user.update({
          where: { id: roleRequest.userId },
          data: { role: roleRequest.role },
        });
      }

      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  },
);
