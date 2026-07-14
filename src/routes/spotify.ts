import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authenticate, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import {
  getTrack,
  searchSpotify,
  syncArtistFromSpotify,
  getLastSpotifyRateLimit
} from '../services/spotifyService';

export const spotifyRouter = Router();

const applyRateLimitHeaders = (res: Response) => {
  const rl = getLastSpotifyRateLimit();
  if (rl?.remaining != null) res.set('X-Spotify-RateLimit-Remaining', rl.remaining);
  if (rl?.reset != null) res.set('X-Spotify-RateLimit-Reset', rl.reset);
};

spotifyRouter.get(
  '/spotify/track/:trackId',
  [param('trackId').isString().trim().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const track = await getTrack(req.params.trackId);
      applyRateLimitHeaders(res);
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
      applyRateLimitHeaders(res);
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
