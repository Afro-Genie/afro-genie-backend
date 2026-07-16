import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { query, param } from 'express-validator';
import { validateRequest } from '../middleware/validateRequest';
import { catalogService } from '../services/catalogService';
import { authenticate, requireRole } from '../middleware/auth';
import { prisma } from '../lib/prisma';

export const catalogRouter = Router();

catalogRouter.get(
  '/catalog/home',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await catalogService.getHomepageData({
        spotifyFallback: req.query.spotifyFallback !== 'false',
      });
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

catalogRouter.get(
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

catalogRouter.get(
  '/genres/:name',
  [param('name').isString().trim().isLength({ min: 1, max: 100 })],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const genre = await prisma.genre.findFirst({
        where: { name: { equals: req.params.name.trim(), mode: 'insensitive' } },
        include: { _count: { select: { songs: true } } },
      });

      if (!genre) {
        res.status(404).json({ error: 'Genre not found', code: 'NOT_FOUND' });
        return;
      }

      res.status(200).json(genre);
    } catch (error) {
      next(error);
    }
  },
);

catalogRouter.get(
  '/catalog/songs',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 500 }).toInt(),
    query('language').optional().isString(),
    query('genre').optional().isString(),
    query('artistId').optional().isString(),
    query('search').optional().isString(),
    query('sortBy').optional().isString(),
    query('sortOrder').optional().isIn(['asc', 'desc']),
    query('spotifyFallback').optional().isBoolean(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await catalogService.getCatalogSongs({
        ...req.query,
        spotifyFallback: req.query.spotifyFallback === 'true',
      } as any);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

catalogRouter.get(
  '/catalog/artists',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    query('search').optional().isString(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await catalogService.getCatalogArtists(req.query as any);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

catalogRouter.get(
  '/catalog/albums/:artistId',
  [param('artistId').isString(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await catalogService.getCatalogAlbums(req.params.artistId);
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

catalogRouter.post(
  '/catalog/cache/clear',
  authenticate,
  requireRole('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await catalogService.clearCache();
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  },
);
