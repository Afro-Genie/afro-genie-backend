import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { UserRole } from '@prisma/client';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../middleware/errorHandler';

export const adminUsersRouter = Router();

adminUsersRouter.use(authenticate, requireRole('ADMIN'));

adminUsersRouter.get(
  '/users',
  [
    query('cursor').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('search').optional().isString(),
    query('role').optional().isIn(['USER', 'ADMIN', 'ARTIST', 'MODERATOR']),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const cursor = req.query.cursor as string | undefined;
      const search = req.query.search as string | undefined;
      const role = req.query.role as string | undefined;

      const where: Record<string, unknown> = {};

      if (search) {
        where.OR = [
          { email: { contains: search, mode: 'insensitive' } },
          { displayName: { contains: search, mode: 'insensitive' } },
        ];
      }

      if (role) {
        where.role = role;
      }

      const [users, total] = await Promise.all([
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
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
        prisma.user.count({ where }),
      ]);

      const hasMore = users.length > limit;
      const data = hasMore ? users.slice(0, limit) : users;
      const nextCursor = hasMore ? data[data.length - 1].id : null;

      res.status(200).json({ data, total, nextCursor });
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
      .isIn(['USER', 'ADMIN', 'ARTIST', 'MODERATOR'])
      .withMessage('Role must be one of: USER, ADMIN, ARTIST, MODERATOR'),
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
