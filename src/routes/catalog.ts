import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { query, param } from 'express-validator';
import { validateRequest } from '../middleware/validateRequest';
import { catalogService } from '../services/catalogService';

export const catalogRouter = Router();

catalogRouter.get(
  '/catalog/home',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await catalogService.getHomepageData();
      res.json(data);
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
