import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { param, query } from 'express-validator';
import type { Prisma } from '@prisma/client';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../middleware/errorHandler';
import { enqueueIndexArtist } from '../../jobs/searchIndexJob';
import { deleteArtist } from '../../services/searchService';
import { catalogService } from '../../services/catalogService';

export const adminArtistsRouter = Router();

adminArtistsRouter.use(authenticate, requireRole('ADMIN'));

export const ADMIN_ARTIST_SORT_FIELDS = ['name', 'popularity', 'followers', 'createdAt', 'songs'] as const;
export type AdminArtistSortBy = (typeof ADMIN_ARTIST_SORT_FIELDS)[number];

export const buildAdminArtistWhere = (params: {
  search?: string;
  genre?: string;
  verified?: string;
  suspended?: string;
  isFeatured?: string;
}): Prisma.ArtistWhereInput => {
  const where: Prisma.ArtistWhereInput = { softDeleted: false };
  const search = params.search?.trim();

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { user: { email: { contains: search, mode: 'insensitive' } } },
    ];
  }
  if (params.genre) {
    where.genres = { has: params.genre };
  }
  if (params.verified !== undefined) {
    where.verified = params.verified === 'true';
  }
  if (params.suspended !== undefined) {
    where.suspended = params.suspended === 'true';
  }
  if (params.isFeatured !== undefined) {
    where.isFeatured = params.isFeatured === 'true';
  }

  return where;
};

export const buildAdminArtistOrderBy = (
  sortBy?: string,
  sortOrder?: string,
): Prisma.ArtistOrderByWithRelationInput => {
  const order = sortOrder === 'asc' ? 'asc' : 'desc';
  switch (sortBy) {
    case 'songs':
      return { songs: { _count: order } };
    case 'name':
      return { name: order };
    case 'popularity':
      return { popularity: order };
    case 'followers':
      return { followers: order };
    default:
      return { createdAt: order };
  }
};

// GET /api/admin/artists
adminArtistsRouter.get(
  '/artists',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('search').optional().isString(),
    query('genre').optional().isString(),
    query('verified').optional().isBoolean(),
    query('suspended').optional().isBoolean(),
    query('isFeatured').optional().isBoolean(),
    query('sortBy').optional().isIn([...ADMIN_ARTIST_SORT_FIELDS]),
    query('sortOrder').optional().isIn(['asc', 'desc']),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
      const limit = Math.min(typeof req.query.limit === 'string' ? Number(req.query.limit) : 20, 100);
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const genre = typeof req.query.genre === 'string' ? req.query.genre : undefined;
      const sortBy = typeof req.query.sortBy === 'string' ? req.query.sortBy : undefined;
      const sortOrder = typeof req.query.sortOrder === 'string' ? req.query.sortOrder : undefined;

      const where = buildAdminArtistWhere({
        search,
        genre,
        verified: req.query.verified as string | undefined,
        suspended: req.query.suspended as string | undefined,
        isFeatured: req.query.isFeatured as string | undefined,
      });

      const [artists, total, verifiedCount, suspendedCount, featuredCount] = await Promise.all([
        prisma.artist.findMany({
          where,
          select: {
            id: true,
            name: true,
            bio: true,
            imageUrl: true,
            genres: true,
            verified: true,
            suspended: true,
            isFeatured: true,
            popularity: true,
            followers: true,
            createdAt: true,
            user: { select: { email: true, role: true } },
            _count: { select: { songs: true, releases: true } },
          },
          orderBy: buildAdminArtistOrderBy(sortBy, sortOrder),
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.artist.count({ where }),
        prisma.artist.count({ where: { verified: true } }),
        prisma.artist.count({ where: { suspended: true } }),
        prisma.artist.count({ where: { isFeatured: true } }),
      ]);

      res.status(200).json({
        artists,
        total,
        page,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        verifiedCount,
        suspendedCount,
        featuredCount,
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

      await catalogService.invalidateHomepageCache();

      res.status(200).json({ id: updated.id, isFeatured: updated.isFeatured });
    } catch (error) {
      next(error);
    }
  },
);


// DELETE /api/admin/artists/:id
adminArtistsRouter.delete(
  '/artists/:id',
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await prisma.artist.findUnique({ where: { id: req.params.id }, select: { id: true, softDeleted: true } });
      if (!artist || artist.softDeleted) throw new ApiError('Artist not found', 'NOT_FOUND', 404);
      await prisma.$transaction([
        prisma.artist.update({ where: { id: artist.id }, data: { softDeleted: true, suspended: true, isFeatured: false } }),
        prisma.song.updateMany({ where: { artistId: artist.id, softDeleted: false }, data: { softDeleted: true } }),
      ]);
      await deleteArtist(artist.id).catch(() => {});
      res.status(200).json({ success: true, artistId: artist.id });
    } catch (error) { next(error); }
  },
);
