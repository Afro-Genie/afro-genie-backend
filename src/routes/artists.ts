import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authenticate, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import {
  createArtist,
  getArtistById,
  listArtists,
  softDeleteArtist,
  updateArtist,
} from '../services/artistsService';

export const artistsRouter = Router();

artistsRouter.get(
  '/artists',
  [
    query('cursor').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 50 }),
    query('genre').optional().isString(),
    query('search').optional().isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await listArtists({
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
        genre: typeof req.query.genre === 'string' ? req.query.genre : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
      });

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
);

artistsRouter.get(
  '/artists/:id',
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistById(req.params.id);
      res.status(200).json(artist);
    } catch (error) {
      next(error);
    }
  },
);

artistsRouter.post(
  '/artists',
  authenticate,
  requireRole('ADMIN'),
  [
    body('name').isString().trim().notEmpty(),
    body('bio').optional({ nullable: true }).isString(),
    body('imageUrl').optional({ nullable: true }).isString(),
    body('spotifyId').optional({ nullable: true }).isString(),
    body('genres').optional().isArray(),
    body('popularity').optional().isInt({ min: 0 }),
    body('followers').optional().isInt({ min: 0 }),
    body('externalUrl').optional({ nullable: true }).isString(),
    body('verified').optional().isBoolean(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await createArtist(req.body);
      res.status(201).json(artist);
    } catch (error) {
      next(error);
    }
  },
);

artistsRouter.patch(
  '/artists/:id',
  authenticate,
  requireRole('ADMIN'),
  [
    param('id').isString().notEmpty(),
    body('name').optional().isString().trim().notEmpty(),
    body('bio').optional({ nullable: true }).isString(),
    body('imageUrl').optional({ nullable: true }).isString(),
    body('spotifyId').optional({ nullable: true }).isString(),
    body('genres').optional().isArray(),
    body('popularity').optional().isInt({ min: 0 }),
    body('followers').optional().isInt({ min: 0 }),
    body('externalUrl').optional({ nullable: true }).isString(),
    body('verified').optional().isBoolean(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await updateArtist(req.params.id, req.body);
      res.status(200).json(artist);
    } catch (error) {
      next(error);
    }
  },
);

artistsRouter.delete(
  '/artists/:id',
  authenticate,
  requireRole('ADMIN'),
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await softDeleteArtist(req.params.id);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
);
