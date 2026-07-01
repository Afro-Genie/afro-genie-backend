import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import path from 'path';
import { authenticate, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import {
  getTrack,
  searchSpotify,
  syncArtistFromSpotify
} from '../services/spotifyService';

export const spotifyRouter = Router();

spotifyRouter.get('/spotify/fallback-preview.mp3', (req: Request, res: Response) => {
  const fallbackPath = path.resolve(process.cwd(), 'assets', 'fallback-preview.mp3');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(fallbackPath, (error) => {
    if (error) {
      res.status(404).json({ error: 'Fallback preview file not found' });
    }
  });
});

spotifyRouter.get(
  '/spotify/track/:trackId',
  [param('trackId').isString().trim().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const track = await getTrack(req.params.trackId);
      res.status(200).json(track);
    } catch (error) {
      next(error);
    }
  }
);

spotifyRouter.get(
  '/spotify/search',
  [
    query('q').isString().trim().notEmpty().withMessage('q is required'),
    query('type').isString().trim().notEmpty().withMessage('type is required')
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = String(req.query.q);
      const type = String(req.query.type);
      const results = await searchSpotify(q, type);
      res.status(200).json(results);
    } catch (error) {
      next(error);
    }
  }
);

spotifyRouter.post(
  '/admin/spotify/sync-artist',
  authenticate,
  requireRole('ADMIN'),
  [
    body('artistId').isString().trim().notEmpty().withMessage('artistId is required'),
    body('spotifyArtistId').isString().trim().notEmpty().withMessage('spotifyArtistId is required')
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artistId = String(req.body.artistId);
      const spotifyArtistId = String(req.body.spotifyArtistId);
      const updatedArtist = await syncArtistFromSpotify(spotifyArtistId, artistId);

      res.status(200).json({
        success: true,
        artist: updatedArtist
      });
    } catch (error) {
      next(error);
    }
  }
);
