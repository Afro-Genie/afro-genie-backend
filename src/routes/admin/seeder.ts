import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { catalogSeeder } from '../../services/seeder/catalogSeeder';

export const adminSeederRouter = Router();

adminSeederRouter.use(authenticate, requireRole('ADMIN'));

adminSeederRouter.get('/seeder/status', (_req: Request, res: Response) => {
  res.json(catalogSeeder.getStatus());
});

adminSeederRouter.post(
  '/seeder/run',
  [
    body('source').isString().notEmpty(),
    body('params').optional().isObject(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await catalogSeeder.run(req.body.source, req.body.params || {});
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminSeederRouter.post(
  '/seeder/spotify-genre',
  [
    body('genre').isString().notEmpty(),
    body('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await catalogSeeder.run('spotify-genre', {
        genre: req.body.genre,
        limit: req.body.limit || 50,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminSeederRouter.post(
  '/seeder/spotify-playlist',
  [
    body('playlistUrl').optional().isString().notEmpty(),
    body('url').optional().isString().notEmpty(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inputUrl = req.body.playlistUrl || req.body.url;
      if (!inputUrl) {
        res.status(400).json({ error: 'playlistUrl or url is required' });
        return;
      }
      const playlistId = extractPlaylistId(inputUrl);
      if (!playlistId) {
        res.status(400).json({ error: 'Could not extract Spotify playlist ID from URL' });
        return;
      }
      const result = await catalogSeeder.run('spotify-playlist', { playlistId });
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminSeederRouter.post(
  '/seeder/curated-african',
  [
    body('playlistIds').optional().isArray(),
    body('limitPerPlaylist').optional().isInt({ min: 1, max: 100 }).toInt(),
    body('genres').optional().isArray(),
    body('limitPerGenre').optional().isInt({ min: 1, max: 100 }).toInt(),
    body('skipPlaylists').optional().isBoolean().toBoolean(),
    body('skipGenres').optional().isBoolean().toBoolean(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const results: any[] = [];

      if (!req.body.skipPlaylists) {
        const playlistResult = await catalogSeeder.run('curated-african', {
          playlistIds: req.body.playlistIds,
          limitPerPlaylist: req.body.limitPerPlaylist || 100,
        });
        results.push({ type: 'curated-playlists', ...playlistResult });
      }

      if (!req.body.skipGenres) {
        const genreResult = await catalogSeeder.run('genre-discovery', {
          genres: req.body.genres,
          limitPerGenre: req.body.limitPerGenre || 50,
        });
        results.push({ type: 'genre-discovery', ...genreResult });
      }

      const combined = results.reduce(
        (acc, r) => ({
          songsCreated: acc.songsCreated + (r.songsCreated || 0),
          songsSkipped: acc.songsSkipped + (r.songsSkipped || 0),
          artistsCreated: acc.artistsCreated + (r.artistsCreated || 0),
          albumsCreated: acc.albumsCreated + (r.albumsCreated || 0),
          lyricsQueued: acc.lyricsQueued + (r.lyricsQueued || 0),
          errors: acc.errors + (r.errors || 0),
        }),
        { songsCreated: 0, songsSkipped: 0, artistsCreated: 0, albumsCreated: 0, lyricsQueued: 0, errors: 0 },
      );

      res.json({ combined, details: results });
    } catch (error) {
      next(error);
    }
  },
);

function extractPlaylistId(url: string): string | null {
  // Handle spotify:playlist:xxx
  if (url.startsWith('spotify:playlist:')) {
    return url.split(':')[2] || null;
  }
  // Handle https://open.spotify.com/playlist/xxx
  const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
  return match?.[1] || null;
}
