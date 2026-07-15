import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { param } from 'express-validator';
import { validateRequest } from '../middleware/validateRequest';
import { getLyricsForSong } from '../services/lyricsService';

export const lyricsRouter = Router();

/**
 * GET /lyrics/:songId
 *
 * Returns the latest non-taken-down lyrics for a song with structured data.
 *
 * Response contract:
 * {
 *   songId: string,
 *   content: string | null,          // Plain text lyrics
 *   syncedLyrics: string | null,     // Raw LRC format with timestamps
 *   lyricLines: Array<{ time: number, text: string }> | null,  // Parsed timestamp lines
 *   sourceProvider: string,           // LRCLIB | MUSICMATCH | LYRICFIND | GENIUS | MANUAL | ARTIST
 *   licenseStatus: string,            // LICENSED | UNKNOWN | UNLICENSED | TAKEDOWN
 *   language: string | null           // Detected language code (e.g. "en", "yo", "pcm")
 * }
 */
lyricsRouter.get(
  '/lyrics/:songId',
  [param('songId').isString().notEmpty().withMessage('songId is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const lyrics = await getLyricsForSong(req.params.songId);

      if (!lyrics) {
        res.status(404).json({ error: 'Lyrics not found for this song', code: 'LYRICS_NOT_FOUND' });
        return;
      }

      res.status(200).json(lyrics);
    } catch (error) {
      next(error);
    }
  },
);
