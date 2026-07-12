import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { param } from 'express-validator';
import { validateRequest } from '../middleware/validateRequest';
import { prisma } from '../lib/prisma';

export const languagesRouter = Router();

languagesRouter.get(
  '/languages',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const languages = await prisma.language.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, code: true, name: true, isActive: true },
      });
      res.status(200).json(languages);
    } catch (error) {
      next(error);
    }
  },
);

languagesRouter.get(
  '/languages/:code',
  [
    param('code').isString().trim().isLength({ min: 2, max: 10 }),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const language = await prisma.language.findUnique({
        where: { code: req.params.code.trim().toLowerCase() },
        select: { id: true, code: true, name: true, isActive: true },
      });

      if (!language) {
        res.status(200).json({ code: req.params.code, name: req.params.code.toUpperCase() });
        return;
      }

      res.status(200).json(language);
    } catch (error) {
      next(error);
    }
  },
);
