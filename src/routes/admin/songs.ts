import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { lyricsEnrichmentQueue } from '../../lib/queue';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { createSong, listSongs, softDeleteSong, updateSong } from '../../services/songService';

export const adminSongsRouter = Router();

adminSongsRouter.use(authenticate, requireRole('ADMIN'));

adminSongsRouter.get(
  '/songs',
  [
    query('limit').optional().isInt({ min: 1, max: 500 }),
    query('page').optional().isInt({ min: 1 }),
    query('language').optional().isString(),
    query('lang').optional().isString(),
    query('genre').optional().isString(),
    query('artistId').optional().isString(),
    query('artistName').optional().isString(),
    query('search').optional().isString(),
    query('sortBy').optional().isIn(['views', 'popularity', 'createdAt', 'title', 'artist', 'releaseYear']),
    query('sortOrder').optional().isIn(['asc', 'desc']),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await listSongs({
        limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
        page: typeof req.query.page === 'string' ? Number(req.query.page) : undefined,
        language: typeof req.query.language === 'string' ? req.query.language : undefined,
        lang: typeof req.query.lang === 'string' ? req.query.lang : undefined,
        genre: typeof req.query.genre === 'string' ? req.query.genre : undefined,
        artistId: typeof req.query.artistId === 'string' ? req.query.artistId : undefined,
        artistName: typeof req.query.artistName === 'string' ? req.query.artistName : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        sortBy: typeof req.query.sortBy === 'string'
          ? (req.query.sortBy as 'views' | 'popularity' | 'createdAt' | 'title' | 'artist' | 'releaseYear')
          : undefined,
        sortOrder: typeof req.query.sortOrder === 'string' ? (req.query.sortOrder as 'asc' | 'desc') : undefined,
        includeUnreleased: true,
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminSongsRouter.post(
  '/songs',
  [
    body('title').isString().trim().notEmpty(),
    body('artistId').isString().notEmpty(),
    body('albumName').optional({ nullable: true }).isString(),
    body('releaseYear').optional({ nullable: true }).isInt({ min: 1800, max: 2200 }),
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
      const song = await createSong(req.body);
      res.status(201).json(song);
    } catch (error) {
      next(error);
    }
  },
);

adminSongsRouter.put(
  '/songs/:id',
  [
    param('id').isString().notEmpty(),
    body('title').optional().isString().trim().notEmpty(),
    body('artistId').optional().isString().notEmpty(),
    body('artistName').optional().isString().trim().notEmpty(),
    body('albumName').optional({ nullable: true }).isString(),
    body('releaseYear').optional({ nullable: true }).isInt({ min: 1800, max: 2200 }),
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
      const song = await updateSong(req.params.id, req.body);
      res.status(200).json(song);
    } catch (error) {
      next(error);
    }
  },
);

adminSongsRouter.delete(
  '/songs/:id',
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

adminSongsRouter.post(
  '/songs/:id/fetch-lyrics',
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await lyricsEnrichmentQueue.add(
        'enrichLyrics',
        { songId: req.params.id },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: 500,
          jobId: `lyrics-enrichment-${req.params.id}`,
        },
      );

      res.status(202).json({ jobId: job.id, status: 'queued' });
    } catch (error) {
      next(error);
    }
  },
);
