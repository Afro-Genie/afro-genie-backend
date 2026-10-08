import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body, param } from 'express-validator';
import { authenticate } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { createRedisRateLimitStore } from '../lib/rateLimitStore';
import {
  playbackSourceCacheKey,
  readPlaybackSourceCacheEntry,
  packPlaybackSourceCacheEntry,
} from '../lib/playbackCache';
import { ApiError } from '../middleware/errorHandler';
import { youtubeService, youtubePlaybackEnabled, type PlaybackSource, type PlaybackSourceKind } from '../services/youtubeService';
import { queueReward } from '../services/rewardService';
import { getRewardConfig } from '../config/rewards';

export const playbackRouter = Router();

const SOURCE_CACHE_TTL_SECONDS = 60 * 60; // 1 hour
const VIEW_COUNT_TTL_SECONDS = 6 * 60 * 60;

const VALID_SOURCES: PlaybackSourceKind[] = ['AUDIO_URL', 'YOUTUBE', 'NONE'];
const VALID_EVENTS = ['play', 'pause', 'complete', 'skip'] as const;

const sourceCacheKey = playbackSourceCacheKey;

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Resolve a song's playback source, cache-first.
 *
 * Shared by the read endpoint and the report endpoint so the report's source
 * validation costs at most one Redis GET and never a second DB read of the same
 * row the read path would have just fetched.
 *
 * The 1h cache outlives the rollout decision, so entries are read and written
 * through the flag-aware helpers: a cached answer computed under a different
 * `FLAG_PLAYBACK_YOUTUBE` state is treated as a miss. That is what makes one env
 * change actually take effect, in both directions — see `readPlaybackSourceCacheEntry`
 * for why checking the source alone is not enough.
 */
const resolvePlaybackSource = async (songId: string): Promise<PlaybackSource | null> => {
  const cacheKey = sourceCacheKey(songId);
  const flagOn = youtubePlaybackEnabled();
  try {
    const cached = readPlaybackSourceCacheEntry<PlaybackSource>(await redis.get(cacheKey), flagOn);
    if (cached) return cached;
  } catch (err) {
    logger.warn({ err, songId }, 'Playback source cache read failed');
  }

  const result = await youtubeService.getPlaybackSource(songId);
  if (!result.song) return null;

  try {
    await redis.set(
      cacheKey,
      packPlaybackSourceCacheEntry(result, youtubePlaybackEnabled()),
      'EX',
      SOURCE_CACHE_TTL_SECONDS,
    );
  } catch (err) {
    logger.warn({ err, songId }, 'Playback source cache write failed');
  }

  return result;
};

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

      const result = await resolvePlaybackSource(songId);
      if (!result || !result.song) {
        throw new ApiError('Song not found', 'NOT_FOUND', 404);
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
//
// Rate limit (2.16): previously unlimited, so a single authenticated client
// could write unbounded SongPlay rows and inflate the view counter that feeds
// the leaderboard and the "most played" charts. 60/min per user, in Redis so
// the limit holds across instances. 60 is deliberately generous — a client emits
// up to 4 events per track, so it allows ~15 track changes a minute, which
// covers binge-skipping without tripping.
// ---------------------------------------------------------------------------
const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisRateLimitStore('playback-report'),
  message: { error: 'Too many playback events. Please wait.', code: 'RATE_LIMITED' },
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
});

playbackRouter.post(
  '/playback/report',
  authenticate,
  reportLimiter,
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
      const { songId, source, eventType } = req.body as {
        songId: string;
        source: PlaybackSourceKind;
        eventType: (typeof VALID_EVENTS)[number];
        positionMs?: number;
      };

      if (songId.startsWith('spotify:')) {
        // Nothing to persist for synthesized Spotify tracks.
        return res.status(202).json({ success: true, recorded: false });
      }

      // Server-side source validation (2.16). `source` was previously accepted,
      // checked only against a hardcoded enum, and then discarded — the server
      // never compared it to what it had actually served that song. So any
      // authenticated client could attribute a play to a tier it was never given.
      // On 'play' (the only event with side effects) the reported source must
      // now match the server's authoritative resolution.
      if (eventType === 'play') {
        const resolved = await resolvePlaybackSource(songId);
        if (!resolved || !resolved.song) {
          throw new ApiError('Song not found', 'NOT_FOUND', 404);
        }
        if (resolved.source !== source) {
          logger.warn(
            { userId, songId, reported: source, resolved: resolved.source },
            'Playback report source did not match the resolved source',
          );
          throw new ApiError(
            'Reported playback source does not match the source served for this song',
            'SOURCE_MISMATCH',
            409,
          );
        }
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
