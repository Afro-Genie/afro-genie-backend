import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { Prisma } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { prisma } from '../lib/prisma';
import { ApiError } from '../middleware/errorHandler';

export const roleRequestsRouter = Router();

roleRequestsRouter.use(authenticate);

roleRequestsRouter.post(
  '/',
  [
    body('role')
      .isIn(['ARTIST', 'MODERATOR'])
      .withMessage('Role must be one of: ARTIST, MODERATOR'),
    body('fields').isObject().withMessage('Fields object is required'),
    body('notes').optional().isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id;
      const { role, fields, notes } = req.body as {
        role: 'ARTIST' | 'MODERATOR';
        fields: Record<string, unknown>;
        notes?: string;
      };

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new ApiError('User not found', 'NOT_FOUND', 404);
      }

      if (user.role === role) {
        throw new ApiError(
          `You already have the ${role} role`,
          'CONFLICT',
          409,
        );
      }

      const existingRequest = await prisma.roleRequest.findFirst({
        where: {
          userId,
          role,
          status: { in: ['PENDING', 'UNDER_REVIEW'] },
        },
      });

      if (existingRequest) {
        throw new ApiError(
          'You already have a pending request for this role',
          'CONFLICT',
          409,
        );
      }

      const roleRequest = await prisma.roleRequest.create({
        data: {
          userId,
          role,
          fields: fields as Prisma.InputJsonValue,
          notes,
        },
      });

      res.status(201).json(roleRequest);
    } catch (error) {
      next(error);
    }
  },
);

roleRequestsRouter.get(
  '/',
  [
    query('status')
      .optional()
      .isIn(['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED']),
    query('role').optional().isIn(['ARTIST', 'MODERATOR']),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id;
      const status = req.query.status as string | undefined;
      const role = req.query.role as string | undefined;

      const where: Record<string, unknown> = { userId };
      if (status) where.status = status;
      if (role) where.role = role;

      const requests = await prisma.roleRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });

      res.status(200).json(requests);
    } catch (error) {
      next(error);
    }
  },
);

roleRequestsRouter.get(
  '/:id',
  [param('id').isString().notEmpty().withMessage('Request ID is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id;
      const { id } = req.params;

      const roleRequest = await prisma.roleRequest.findFirst({
        where: { id, userId },
      });

      if (!roleRequest) {
        throw new ApiError('Role request not found', 'NOT_FOUND', 404);
      }

      res.status(200).json(roleRequest);
    } catch (error) {
      next(error);
    }
  },
);
