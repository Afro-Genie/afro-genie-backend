import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { Prisma, type PurchaseStatus } from '@prisma/client';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../middleware/errorHandler';
import { fulfillPurchase } from '../../services/storeService';

export const adminStoreRouter = Router();

adminStoreRouter.use(authenticate, requireRole('ADMIN'));

// ---------------------------------------------------------------------------
// GET /api/admin/store/items?active=
// List store items (optionally filtered by active state).
// ---------------------------------------------------------------------------
adminStoreRouter.get(
  '/store/items',
  [
    query('active').optional().isIn(['true', 'false']).withMessage('active must be true or false'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const active =
        req.query.active === undefined
          ? undefined
          : req.query.active === 'true';
      const items = await prisma.storeItem.findMany({
        where: active === undefined ? {} : { active },
        orderBy: { createdAt: 'desc' },
      });
      return res.status(200).json(items);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/store/items
// Body { name, description?, tokenCost, category, metadata?, active? }.
// ---------------------------------------------------------------------------
adminStoreRouter.post(
  '/store/items',
  [
    body('name').isString().isLength({ min: 1, max: 120 }).withMessage('name is required'),
    body('description').optional().isString().isLength({ max: 2000 }),
    body('tokenCost').isInt({ min: 1 }).withMessage('tokenCost must be a positive integer'),
    body('category').isString().isLength({ min: 1, max: 60 }).withMessage('category is required'),
    body('metadata').optional().isObject(),
    body('active').optional().isBoolean(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, description, tokenCost, category, metadata, active } = req.body as {
        name: string;
        description?: string;
        tokenCost: number;
        category: string;
        metadata?: Record<string, unknown>;
        active?: boolean;
      };

      const item = await prisma.storeItem.create({
        data: {
          name,
          description,
          tokenCost,
          category,
          metadata: metadata as Prisma.InputJsonValue | undefined,
          active: active ?? true,
        },
      });

      return res.status(201).json(item);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /api/admin/store/items/:id
// Update name/description/tokenCost/category/metadata/active.
// ---------------------------------------------------------------------------
adminStoreRouter.patch(
  '/store/items/:id',
  [
    param('id').isString().notEmpty().withMessage('Item id is required'),
    body('name').optional().isString().isLength({ min: 1, max: 120 }),
    body('description').optional().isString().isLength({ max: 2000 }),
    body('tokenCost').optional().isInt({ min: 1 }),
    body('category').optional().isString().isLength({ min: 1, max: 60 }),
    body('metadata').optional(),
    body('active').optional().isBoolean(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, description, tokenCost, category, metadata, active } = req.body as {
        name?: string;
        description?: string | null;
        tokenCost?: number;
        category?: string;
        metadata?: Record<string, unknown> | null;
        active?: boolean;
      };

      const existing = await prisma.storeItem.findUnique({ where: { id: req.params.id } });
      if (!existing) {
        return next(new ApiError('Store item not found', 'NOT_FOUND', 404));
      }

      const item = await prisma.storeItem.update({
        where: { id: existing.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(tokenCost !== undefined ? { tokenCost } : {}),
          ...(category !== undefined ? { category } : {}),
          ...(metadata !== undefined
            ? { metadata: metadata === null ? Prisma.DbNull : (metadata as Prisma.InputJsonValue) }
            : {}),
          ...(active !== undefined ? { active } : {}),
        },
      });

      return res.status(200).json(item);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/admin/store/items/:id
// Soft-hide via active=false (purchases reference items with Restrict).
// ---------------------------------------------------------------------------
adminStoreRouter.delete(
  '/store/items/:id',
  [param('id').isString().notEmpty().withMessage('Item id is required'), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.storeItem.findUnique({ where: { id: req.params.id } });
      if (!existing) {
        return next(new ApiError('Store item not found', 'NOT_FOUND', 404));
      }

      await prisma.storeItem.update({
        where: { id: existing.id },
        data: { active: false },
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/store/purchases?status=&page=&limit=
// Purchases filtered by status for the fulfillment queue.
// ---------------------------------------------------------------------------
adminStoreRouter.get(
  '/store/purchases',
  [
    query('status')
      .optional()
      .isIn(['PENDING_FULFILLMENT', 'FULFILLED', 'REFUNDED'])
      .withMessage('Invalid status'),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const status = req.query.status as PurchaseStatus | undefined;

      const where: Prisma.StorePurchaseWhereInput = status ? { status } : {};

      const [rows, total] = await Promise.all([
        prisma.storePurchase.findMany({
          where,
          include: {
            item: { select: { id: true, name: true, category: true } },
            user: { select: { id: true, displayName: true, email: true } },
          },
          orderBy: { createdAt: 'asc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.storePurchase.count({ where }),
      ]);

      return res.status(200).json({
        data: rows,
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
// PATCH /api/admin/store/purchases/:id/fulfill
// Marks a purchase FULFILLED and notifies the buyer.
// ---------------------------------------------------------------------------
adminStoreRouter.patch(
  '/store/purchases/:id/fulfill',
  [param('id').isString().notEmpty().withMessage('Purchase id is required'), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const purchase = await fulfillPurchase(req.params.id);
      return res.status(200).json(purchase);
    } catch (err) {
      return next(err);
    }
  },
);
