import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { requireRole, authenticate } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import {
  createSong,
  getSongById,
  getSongTranslations,
  getSongsByLanguage,
  listSongs,
  softDeleteSong,
  updateSong,
} from '../services/songService';

export const songsRouter = Router();

songsRouter.get(
  '/songs',
  [
    query('cursor').optional().isString(),
    query('lastId').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 500 }),
    query('page').optional().isInt({ min: 1 }),
    query('language').optional().isString(),
    query('lang').optional().isString(),
    query('genre').optional().isString(),
    query('artistId').optional().isString(),
    query('search').optional().isString(),
    query('sortBy').optional().isIn(['views', 'popularity', 'createdAt']),
    query('sortOrder').optional().isIn(['asc', 'desc']),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await listSongs({
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        lastId: typeof req.query.lastId === 'string' ? req.query.lastId : undefined,
        limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
        page: typeof req.query.page === 'string' ? Number(req.query.page) : undefined,
        language: typeof req.query.language === 'string' ? req.query.language : undefined,
        lang: typeof req.query.lang === 'string' ? req.query.lang : undefined,
        genre: typeof req.query.genre === 'string' ? req.query.genre : undefined,
        artistId: typeof req.query.artistId === 'string' ? req.query.artistId : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        sortBy: typeof req.query.sortBy === 'string' ? (req.query.sortBy as 'views' | 'popularity' | 'createdAt') : undefined,
        sortOrder: typeof req.query.sortOrder === 'string' ? (req.query.sortOrder as 'asc' | 'desc') : undefined,
      });

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
);

songsRouter.get(
  '/songs/by-language/:languageCode',
  [
    param('languageCode').isString().trim().isLength({ min: 2, max: 10 }),
    query('limit').optional().isInt({ min: 1, max: 500 }),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const songs = await getSongsByLanguage(
        req.params.languageCode,
        typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
      );

      res.status(200).json({ languageCode: req.params.languageCode, songs, total: songs.length });
    } catch (error) {
      next(error);
    }
  },
);

songsRouter.get(
  '/songs/:id',
  [param('id').isString().notEmpty().withMessage('id is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const song = await getSongById(req.params.id);
      res.status(200).json(song);
    } catch (error) {
      next(error);
    }
  },
);

songsRouter.get(
  '/songs/:id/translations',
  [param('id').isString().notEmpty().withMessage('id is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const translations = await getSongTranslations(req.params.id);
      res.status(200).json({ songId: req.params.id, translations });
    } catch (error) {
      next(error);
    }
  },
);

songsRouter.post(
  '/songs',
  authenticate,
  requireRole('ADMIN'),
  [
    body('title').isString().trim().notEmpty(),
    body('artistId').isString().notEmpty(),
    body('albumName').optional({ nullable: true }).isString(),
    body('releaseYear').optional({ nullable: true }).isInt({ min: 1800, max: 2200 }),
    body('spotifyId').optional({ nullable: true }).isString(),
    body('coverImageUrl').optional({ nullable: true }).isString(),
    body('imageUrl').optional({ nullable: true }).isString(),
    body('primaryLanguage').optional({ nullable: true }).isString(),
    body('languages').optional().isArray(),
    body('genres').optional().isArray(),
    body('lyrics.rawText').optional().isString(),
    body('lyrics.lineBreaks').optional().isArray(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = await createSong(req.body);
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  },
);

songsRouter.patch(
  '/songs/:id',
  authenticate,
  requireRole('ADMIN'),
  [
    param('id').isString().notEmpty(),
    body('title').optional().isString().trim().notEmpty(),
    body('artistId').optional().isString().notEmpty(),
    body('albumName').optional({ nullable: true }).isString(),
    body('releaseYear').optional({ nullable: true }).isInt({ min: 1800, max: 2200 }),
    body('spotifyId').optional({ nullable: true }).isString(),
    body('coverImageUrl').optional({ nullable: true }).isString(),
    body('imageUrl').optional({ nullable: true }).isString(),
    body('primaryLanguage').optional({ nullable: true }).isString(),
    body('languages').optional().isArray(),
    body('genres').optional().isArray(),
    body('lyrics.rawText').optional().isString(),
    body('lyrics.lineBreaks').optional().isArray(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await updateSong(req.params.id, req.body);
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  },
);

songsRouter.delete(
  '/songs/:id',
  authenticate,
  requireRole('ADMIN'),
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await softDeleteSong(req.params.id);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
);
