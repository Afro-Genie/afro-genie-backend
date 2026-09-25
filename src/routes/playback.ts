import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param } from 'express-validator';
import { authenticate } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { ApiError } from '../middleware/errorHandler';
import { youtubeService, type PlaybackSourceKind } from '../services/youtubeService';
import { queueReward } from '../services/rewardService';
import { getRewardConfig } from '../config/rewards';

export const playbackRouter = Router();

const SOURCE_CACHE_TTL_SECONDS = 60 * 60; // 1 hour
const VIEW_COUNT_TTL_SECONDS = 6 * 60 * 60;

const VALID_SOURCES: PlaybackSourceKind[] = ['AUDIO_URL', 'YOUTUBE', 'SPOTIFY_PREVIEW', 'NONE'];
const VALID_EVENTS = ['play', 'pause', 'complete', 'skip'] as const;

const sourceCacheKey = (songId: string) => `playback:source:${songId}`;

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// GET /api/playback/:songId/source
// Public. Resolves the best available playback source (Redis-cached 1h).
// ---------------------------------------------------------------------------
playbackRouter.get(
  '/playback/:songId/source',
  [param('songId').isString().notEmpty().withMessage('songId is required'), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { songId } = req.params;

      // Spotify-synthesized ids (`spotify:track:...`) are not DB songs.
      if (songId.startsWith('spotify:')) {
        throw new ApiError('Playback source lookup is only supported for catalog songs', 'BAD_REQUEST', 400);
      }

      const cacheKey = sourceCacheKey(songId);
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return res.status(200).json(JSON.parse(cached));
        }
      } catch (err) {
        logger.warn({ err, songId }, 'Playback source cache read failed');
      }

      const result = await youtubeService.getPlaybackSource(songId);
      if (!result.song) {
        throw new ApiError('Song not found', 'NOT_FOUND', 404);
      }

      try {
        await redis.set(cacheKey, JSON.stringify(result), 'EX', SOURCE_CACHE_TTL_SECONDS);
      } catch (err) {
        logger.warn({ err, songId }, 'Playback source cache write failed');
      }

      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/playback/report
// Body { songId, source, eventType: 'play'|'pause'|'complete'|'skip', positionMs? }
// Records a SongPlay on 'play', increments the view counter, and grants the
// daily-listen reward on 'complete'.
// ---------------------------------------------------------------------------
playbackRouter.post(
  '/playback/report',
  authenticate,
  [
    body('songId').isString().notEmpty().withMessage('songId is required'),
    body('source').isIn(VALID_SOURCES).withMessage('source is invalid'),
    body('eventType').isIn(VALID_EVENTS as unknown as string[]).withMessage('eventType is invalid'),
    body('positionMs').optional().isInt({ min: 0 }).withMessage('positionMs must be a positive integer'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const { songId, eventType } = req.body as {
        songId: string;
        source: PlaybackSourceKind;
        eventType: (typeof VALID_EVENTS)[number];
        positionMs?: number;
      };

      if (songId.startsWith('spotify:')) {
        // Nothing to persist for synthesized Spotify tracks.
        return res.status(202).json({ success: true, recorded: false });
      }

      const song = await prisma.song.findUnique({
        where: { id: songId },
        select: { id: true, durationMs: true },
      });
      if (!song) {
        throw new ApiError('Song not found', 'NOT_FOUND', 404);
      }

      if (eventType === 'play') {
        await prisma.songPlay.create({
          data: { songId, userId },
        });

        try {
          const key = `song:views:${songId}`;
          const count = await redis.incr(key);
          if (count === 1) {
            await redis.expire(key, VIEW_COUNT_TTL_SECONDS);
          }
        } catch (err) {
          logger.warn({ err, songId }, 'View counter increment failed');
        }
      }

      if (eventType === 'complete') {
        const config = await getRewardConfig();
        const idempotencyKey = `daily-listen:${userId}:${dayKey()}`;
        await queueReward(
          userId,
          config.DAILY_LISTEN_AMOUNT,
          'Daily listen',
          'DAILY_LISTEN',
          idempotencyKey,
        ).catch((err) => logger.warn({ err, userId, songId }, 'Failed to queue daily listen reward'));
      }

      return res.status(200).json({ success: true, recorded: true });
    } catch (err) {
      return next(err);
    }
  },
);
