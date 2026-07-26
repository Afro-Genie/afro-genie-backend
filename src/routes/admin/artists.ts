import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { param, query } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../middleware/errorHandler';
import { enqueueIndexArtist } from '../../jobs/searchIndexJob';
import { deleteArtist } from '../../services/searchService';

export const adminArtistsRouter = Router();

adminArtistsRouter.use(authenticate, requireRole('ADMIN'));

// GET /api/admin/artists
adminArtistsRouter.get(
  '/artists',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('search').optional().isString(),
    query('verified').optional().isBoolean(),
    query('suspended').optional().isBoolean(),
    query('isFeatured').optional().isBoolean(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
      const limit = Math.min(typeof req.query.limit === 'string' ? Number(req.query.limit) : 20, 100);
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;

      const where: Record<string, unknown> = {};

      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { user: { email: { contains: search, mode: 'insensitive' } } },
        ];
      }
      if (req.query.verified !== undefined) {
        where.verified = req.query.verified === 'true';
      }
      if (req.query.suspended !== undefined) {
        where.suspended = req.query.suspended === 'true';
      }
      if (req.query.isFeatured !== undefined) {
        where.isFeatured = req.query.isFeatured === 'true';
      }

      const [artists, total] = await Promise.all([
        prisma.artist.findMany({
          where,
          select: {
            id: true,
            name: true,
            verified: true,
            suspended: true,
            isFeatured: true,
            popularity: true,
            followers: true,
            createdAt: true,
            user: { select: { email: true, role: true } },
            _count: { select: { songs: true, releases: true } },
          },
          orderBy: { createdAt: 'desc' as const },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.artist.count({ where }),
      ]);

      res.status(200).json({
        artists,
        total,
        page,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      });
    } catch (error) {
      next(error);
    }
  },
);

// PATCH /api/admin/artists/:id/verify
adminArtistsRouter.patch(
  '/artists/:id/verify',
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await prisma.artist.findUnique({
        where: { id: req.params.id },
        select: { id: true, verified: true },
      });
      if (!artist) {
        throw new ApiError('Artist not found', 'NOT_FOUND', 404);
      }

      const updated = await prisma.artist.update({
        where: { id: artist.id },
        data: { verified: !artist.verified },
        select: { id: true, verified: true },
      });

      await enqueueIndexArtist(updated.id);

      res.status(200).json({ id: updated.id, verified: updated.verified });
    } catch (error) {
      next(error);
    }
  },
);

// PATCH /api/admin/artists/:id/suspend
adminArtistsRouter.patch(
  '/artists/:id/suspend',
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await prisma.artist.findUnique({
        where: { id: req.params.id },
        select: { id: true, suspended: true },
      });
      if (!artist) {
        throw new ApiError('Artist not found', 'NOT_FOUND', 404);
      }

      const updated = await prisma.artist.update({
        where: { id: artist.id },
        data: { suspended: !artist.suspended },
        select: { id: true, suspended: true },
      });

      // Remove from search index if suspended; re-index if unsuspended
      if (updated.suspended) {
        await deleteArtist(updated.id).catch(() => {});
      } else {
        await enqueueIndexArtist(updated.id);
      }

      res.status(200).json({ id: updated.id, suspended: updated.suspended });
    } catch (error) {
      next(error);
    }
  },
);

// PATCH /api/admin/artists/:id/feature
adminArtistsRouter.patch(
  '/artists/:id/feature',
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await prisma.artist.findUnique({
        where: { id: req.params.id },
        select: { id: true, isFeatured: true },
      });
      if (!artist) {
        throw new ApiError('Artist not found', 'NOT_FOUND', 404);
      }

      const updated = await prisma.artist.update({
        where: { id: artist.id },
        data: { isFeatured: !artist.isFeatured },
        select: { id: true, isFeatured: true },
      });

      res.status(200).json({ id: updated.id, isFeatured: updated.isFeatured });
    } catch (error) {
      next(error);
    }
  },
);
