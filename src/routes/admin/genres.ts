import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { ApiError } from '../../middleware/errorHandler';

export const adminGenresRouter = Router();

adminGenresRouter.use(authenticate, requireRole('ADMIN'));

export const GENRE_SORT_FIELDS = ['name', 'songs'] as const;
export type GenreSortBy = (typeof GENRE_SORT_FIELDS)[number];

export const buildGenreWhere = (search?: string): Prisma.GenreWhereInput => {
  const trimmed = search?.trim();
  if (!trimmed) return {};
  return { name: { contains: trimmed, mode: 'insensitive' } };
};

export const buildGenreOrderBy = (
  sortBy?: string,
  sortOrder?: string,
): Prisma.GenreOrderByWithRelationInput => {
  const order = sortOrder === 'desc' ? 'desc' : 'asc';
  if (sortBy === 'songs') {
    return { songs: { _count: order } };
  }
  return { name: order };
};

adminGenresRouter.get(
  '/genres',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('search').optional().isString(),
    query('sortBy').optional().isIn([...GENRE_SORT_FIELDS]),
    query('sortOrder').optional().isIn(['asc', 'desc']),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
      const limit = Math.min(typeof req.query.limit === 'string' ? Number(req.query.limit) : 20, 100);
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const sortBy = typeof req.query.sortBy === 'string' ? req.query.sortBy : undefined;
      const sortOrder = typeof req.query.sortOrder === 'string' ? req.query.sortOrder : undefined;

      const where = buildGenreWhere(search);

      const [genres, total, totalSongLinks, genresInUse] = await Promise.all([
        prisma.genre.findMany({
          where,
          orderBy: buildGenreOrderBy(sortBy, sortOrder),
          skip: (page - 1) * limit,
          take: limit,
          include: { _count: { select: { songs: true } } },
        }),
        prisma.genre.count({ where }),
        prisma.songGenre.count(),
        prisma.genre.count({ where: { songs: { some: {} } } }),
      ]);

      res.status(200).json({
        data: genres,
        total,
        page,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        totalSongLinks,
        genresInUse,
      });
    } catch (error) {
      next(error);
    }
  },
);

adminGenresRouter.post(
  '/genres',
  [
    body('name').isString().trim().notEmpty().withMessage('Genre name is required'),
    body('imageUrl').optional({ nullable: true }).isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, imageUrl } = req.body as { name: string; imageUrl?: string | null };
      const trimmedName = name.trim();

      const existing = await prisma.genre.findFirst({
        where: { name: { equals: trimmedName, mode: 'insensitive' } },
        select: { id: true },
      });
      if (existing) {
        throw new ApiError('A genre with this name already exists', 'CONFLICT', 409);
      }

      const genre = await prisma.genre.create({
        data: { name: trimmedName, imageUrl: imageUrl || null },
        include: { _count: { select: { songs: true } } },
      });

      res.status(201).json(genre);
    } catch (error) {
      next(error);
    }
  },
);

adminGenresRouter.patch(
  '/genres/:id',
  [
    param('id').isString().notEmpty(),
    body('name').optional().isString().trim().notEmpty(),
    body('imageUrl').optional({ nullable: true }).isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { name, imageUrl } = req.body as { name?: string; imageUrl?: string | null };

      if (name === undefined && imageUrl === undefined) {
        throw new ApiError('Provide a name or imageUrl to update', 'BAD_REQUEST', 400);
      }

      const genre = await prisma.genre.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!genre) {
        throw new ApiError('Genre not found', 'NOT_FOUND', 404);
      }

      const data: Prisma.GenreUpdateInput = {};
      if (name !== undefined) {
        const trimmedName = name.trim();
        const duplicate = await prisma.genre.findFirst({
          where: { name: { equals: trimmedName, mode: 'insensitive' }, id: { not: id } },
          select: { id: true },
        });
        if (duplicate) {
          throw new ApiError('A genre with this name already exists', 'CONFLICT', 409);
        }
        data.name = trimmedName;
      }
      if (imageUrl !== undefined) {
        data.imageUrl = imageUrl || null;
      }

      const updated = await prisma.genre.update({
        where: { id },
        data,
        include: { _count: { select: { songs: true } } },
      });

      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  },
);

adminGenresRouter.delete(
  '/genres/:id',
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const genre = await prisma.genre.findUnique({
        where: { id },
        include: { _count: { select: { songs: true } } },
      });
      if (!genre) {
        throw new ApiError('Genre not found', 'NOT_FOUND', 404);
      }

      await prisma.genre.delete({ where: { id } });

      res.status(200).json({ success: true, id, removedSongLinks: genre._count.songs });
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
