import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param } from 'express-validator';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';

export const adminGenresRouter = Router();

adminGenresRouter.use(authenticate, requireRole('ADMIN'));

adminGenresRouter.get(
  '/genres',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const genres = await prisma.genre.findMany({
        orderBy: { name: 'asc' },
        include: { _count: { select: { songs: true } } },
      });
      res.status(200).json(genres);
    } catch (error) {
      next(error);
    }
  },
);

adminGenresRouter.patch(
  '/genres/:id',
  [
    param('id').isString().notEmpty(),
    body('imageUrl').isString().notEmpty().withMessage('imageUrl is required'),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { imageUrl } = req.body as { imageUrl: string };

      const genre = await prisma.genre.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!genre) {
        res.status(404).json({ error: 'Genre not found', code: 'NOT_FOUND' });
        return;
      }

      const updated = await prisma.genre.update({
        where: { id },
        data: { imageUrl },
      });

      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  },
);

adminGenresRouter.post(
  '/genres/backfill-images',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const genres = await prisma.genre.findMany({
        where: { imageUrl: null },
        select: { id: true, name: true },
      });

      let updated = 0;
      for (const genre of genres) {
        await prisma.genre.update({
          where: { id: genre.id },
          data: { imageUrl: '' },
        });
        updated++;
      }

      res.status(200).json({ updated, total: genres.length });
    } catch (error) {
      next(error);
    }
  },
);
