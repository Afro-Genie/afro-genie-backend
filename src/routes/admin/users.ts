import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { UserRole, type Prisma } from '@prisma/client';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { ApiError } from '../../middleware/errorHandler';

export const adminUsersRouter = Router();

adminUsersRouter.use(authenticate, requireRole('ADMIN'));

export const USER_SORT_FIELDS = ['createdAt', 'displayName', 'email', 'role', 'lastLoginAt'] as const;
export type UserSortBy = (typeof USER_SORT_FIELDS)[number];

export const buildUserWhere = (params: { search?: string; role?: string }): Prisma.UserWhereInput => {
  const where: Prisma.UserWhereInput = {};
  const search = params.search?.trim();

  if (search) {
    where.OR = [
      { email: { contains: search, mode: 'insensitive' } },
      { displayName: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (params.role) {
    where.role = params.role as UserRole;
  }

  return where;
};

export const buildUserOrderBy = (
  sortBy?: string,
  sortOrder?: string,
): Prisma.UserOrderByWithRelationInput[] => {
  const order = sortOrder === 'asc' ? 'asc' : 'desc';
  switch (sortBy) {
    case 'displayName':
      return [{ displayName: order }, { id: 'desc' }];
    case 'email':
      return [{ email: order }, { id: 'desc' }];
    case 'role':
      return [{ role: order }, { id: 'desc' }];
    case 'lastLoginAt':
      return [{ lastLoginAt: order }, { id: 'desc' }];
    default:
      return [{ createdAt: order }, { id: 'desc' }];
  }
};

adminUsersRouter.get(
  '/users',
  [
    query('cursor').optional().isString(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('search').optional().isString(),
    query('role').optional().isIn(['USER', 'ADMIN', 'ARTIST', 'MODERATOR', 'ARBITER']),
    query('sortBy').optional().isIn([...USER_SORT_FIELDS]),
    query('sortOrder').optional().isIn(['asc', 'desc']),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const cursor = req.query.cursor as string | undefined;
      const page = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
      const search = req.query.search as string | undefined;
      const role = req.query.role as string | undefined;
      const sortBy = req.query.sortBy as string | undefined;
      const sortOrder = req.query.sortOrder as string | undefined;

      const where = buildUserWhere({ search, role });
      const orderBy = buildUserOrderBy(sortBy, sortOrder);

      const [users, total, roleGroups] = await Promise.all([
        prisma.user.findMany({
          where,
          select: {
            id: true,
            email: true,
            displayName: true,
            photoUrl: true,
            role: true,
            createdAt: true,
            updatedAt: true,
            lastLoginAt: true,
          },
          orderBy,
          ...(cursor
            ? { cursor: { id: cursor }, skip: 1, take: limit + 1 }
            : { skip: (page - 1) * limit, take: limit }),
        }),
        prisma.user.count({ where }),
        prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
      ]);

      const roleCounts: Record<string, number> = {};
      for (const group of roleGroups) {
        roleCounts[group.role] = group._count._all;
      }

      if (cursor) {
        const hasMore = users.length > limit;
        const data = hasMore ? users.slice(0, limit) : users;
        const nextCursor = hasMore ? data[data.length - 1].id : null;
        res.status(200).json({ data, total, nextCursor, roleCounts });
        return;
      }

      const totalPages = Math.max(1, Math.ceil(total / limit));
      res.status(200).json({ data: users, total, page, totalPages, nextCursor: null, roleCounts });
    } catch (error) {
      next(error);
    }
  },
);

adminUsersRouter.patch(
  '/users/:id/role',
  [
    param('id').isString().notEmpty().withMessage('User ID is required'),
    body('role')
      .isIn(['USER', 'ADMIN', 'ARTIST', 'MODERATOR', 'ARBITER'])
      .withMessage('Role must be one of: USER, ADMIN, ARTIST, MODERATOR, ARBITER'),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { role } = req.body as { role: UserRole };

      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        throw new ApiError('User not found', 'NOT_FOUND', 404);
      }

      const updated = await prisma.user.update({
        where: { id },
        data: { role },
        select: {
          id: true,
          email: true,
          displayName: true,
          photoUrl: true,
          role: true,
          createdAt: true,
          updatedAt: true,
          lastLoginAt: true,
        },
      });

      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  },
);

adminUsersRouter.delete(
  '/users/:id',
  [param('id').isString().notEmpty().withMessage('User ID is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        throw new ApiError('User not found', 'NOT_FOUND', 404);
      }

      await prisma.user.delete({ where: { id } });

      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// POST /admin/users/:id/remove-moderator — demote MODERATOR back to USER
adminUsersRouter.post(
  '/users/:id/remove-moderator',
  [param('id').isString().notEmpty().withMessage('User ID is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        throw new ApiError('User not found', 'NOT_FOUND', 404);
      }
      if (user.role !== 'MODERATOR') {
        throw new ApiError('User is not a MODERATOR', 'BAD_REQUEST', 400);
      }

      const updated = await prisma.user.update({
        where: { id },
        data: { role: 'USER' },
        select: {
          id: true,
          email: true,
          displayName: true,
          photoUrl: true,
          role: true,
          createdAt: true,
          updatedAt: true,
          lastLoginAt: true,
        },
      });

      // Unassign open reports assigned to this moderator
      await prisma.contentReport.updateMany({
        where: { moderatorId: id, status: 'PENDING' },
        data: { moderatorId: null },
      });

      // Notify the user
      await prisma.notification.create({
        data: {
          userId: id,
          title: 'Moderator Privileges Removed',
          message: 'Your moderator privileges have been removed by an admin. You can still use the platform as a regular user.',
          type: 'SYSTEM',
        },
      });

      logger.info({ userId: id, adminId: req.user!.id }, 'Moderator privileges removed');

      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  },
);
