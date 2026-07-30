import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param } from 'express-validator';
import { authenticate } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { getStoreItems, purchaseItem, getUserPurchases } from '../services/storeService';
import { ApiError } from '../middleware/errorHandler';

export const storeRouter = Router();

storeRouter.get(
  '/store/items',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await getStoreItems();
      res.json(items);
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
