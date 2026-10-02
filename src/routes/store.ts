import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, query } from 'express-validator';
import { authenticate } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import {
  getStoreItems,
  getFeaturedItems,
  getLimitedTimeOffers,
  purchaseItem,
  getUserPurchases,
} from '../services/storeService';
import { ApiError } from '../middleware/errorHandler';

export const storeRouter = Router();

storeRouter.get(
  '/store/items',
  [
    query('featured').optional().isIn(['true', 'false']).withMessage('featured must be true or false'),
    query('limited').optional().isIn(['true', 'false']).withMessage('limited must be true or false'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await getStoreItems({
        featured: req.query.featured === 'true',
        limited: req.query.limited === 'true',
      });
      res.json(items);
    } catch (error) {
      next(error);
    }
  },
);

storeRouter.get(
  '/store/featured',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await getFeaturedItems();
      res.json(items);
    } catch (error) {
      next(error);
    }
  },
);

storeRouter.get(
  '/store/offers',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const offers = await getLimitedTimeOffers();
      res.json(offers);
    } catch (error) {
      next(error);
    }
  },
);

storeRouter.post(
  '/store/purchase',
  authenticate,
  [body('itemId').isString().notEmpty().withMessage('Item ID is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { itemId } = req.body as { itemId: string };
      const result = await purchaseItem(req.user!.id, itemId);
      if (!result.success) {
        throw new ApiError(result.message, 'PURCHASE_FAILED', 400);
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

storeRouter.get(
  '/store/me/purchases',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const purchases = await getUserPurchases(req.user!.id);
      res.json(purchases);
    } catch (error) {
      next(error);
    }
  },
);
