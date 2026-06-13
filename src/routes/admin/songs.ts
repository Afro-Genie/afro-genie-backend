import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { createSong, softDeleteSong, updateSong } from '../../services/songService';

export const adminSongsRouter = Router();

adminSongsRouter.use(authenticate, requireRole('ADMIN'));

adminSongsRouter.post(
  '/admin/songs',
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
      const song = await createSong(req.body);
      res.status(201).json(song);
    } catch (error) {
      next(error);
    }
  },
);

adminSongsRouter.put(
  '/admin/songs/:id',
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
      const song = await updateSong(req.params.id, req.body);
      res.status(200).json(song);
    } catch (error) {
      next(error);
    }
  },
);

adminSongsRouter.delete(
  '/admin/songs/:id',
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
