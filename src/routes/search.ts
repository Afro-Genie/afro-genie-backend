import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { query } from 'express-validator';
import { validateRequest } from '../middleware/validateRequest';
import { searchCatalog, suggestCatalog, type SearchType } from '../services/searchService';

export const searchRouter = Router();

searchRouter.get(
  '/search',
  [
    query('q').optional().isString().withMessage('q must be a string'),
    query('type')
      .optional()
      .isIn(['song', 'artist', 'genre', 'all'])
      .withMessage("type must be one of 'song', 'artist', 'genre', 'all'"),
    query('lang').optional().isString().trim().isLength({ min: 2, max: 10 }).withMessage('lang must be a valid language code'),
    query('genre').optional().isString().trim().isLength({ min: 1, max: 64 }).withMessage('genre must be a non-empty string'),
    query('page').optional().isInt({ min: 1 }).withMessage('page must be an integer >= 1'),
    query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('limit must be between 1 and 50')
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await searchCatalog({
        q: typeof req.query.q === 'string' ? req.query.q : '',
        type: (typeof req.query.type === 'string' ? req.query.type : 'all') as SearchType,
        lang: typeof req.query.lang === 'string' ? req.query.lang : undefined,
        genre: typeof req.query.genre === 'string' ? req.query.genre : undefined,
        page: typeof req.query.page === 'string' ? Number(req.query.page) : undefined,
        limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined
      });

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

searchRouter.get(
  '/search/suggest',
  [query('q').isString().trim().isLength({ min: 1 }).withMessage('q is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = String(req.query.q);
      const result = await suggestCatalog(q);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);
