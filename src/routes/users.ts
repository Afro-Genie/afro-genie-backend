import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param } from 'express-validator';
import { validateRequest } from '../middleware/validateRequest';
import { authenticate } from '../middleware/auth';

export const usersRouter = Router();

usersRouter.post(
  '/users/history',
  authenticate,
  [body('songId').isString().notEmpty()],
  validateRequest,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

usersRouter.get(
  '/users/favorites',
  authenticate,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json([]);
    } catch (error) {
      next(error);
    }
  },
);

usersRouter.post(
  '/users/favorites',
  authenticate,
  [body('songId').isString().notEmpty()],
  validateRequest,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json({ id: 'stub-favorite-id', success: true });
    } catch (error) {
      next(error);
    }
  },
);

usersRouter.delete(
  '/users/favorites/:id',
  authenticate,
  [param('id').isString().notEmpty()],
  validateRequest,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);
