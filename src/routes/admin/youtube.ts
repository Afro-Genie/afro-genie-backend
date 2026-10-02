import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body, param } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { prisma } from '../../lib/prisma';
import { createRedisRateLimitStore } from '../../lib/rateLimitStore';
import { invalidatePlaybackSourceCache } from '../../lib/playbackCache';
import { ApiError } from '../../middleware/errorHandler';
import { youtubeService } from '../../services/youtubeService';
import { enqueueLibraryEnrichment } from '../../jobs/libraryEnrichmentJob';

export const adminYoutubeRouter = Router();

adminYoutubeRouter.use(authenticate, requireRole('ADMIN'));

// G-3 (2.16 adj.) — this limiter used the default in-process MemoryStore, so the
// effective cap was 5/min x instanceCount with nothing in the response to say so.
// Shared via Redis so the cap is a real control. Keyed on the admin's user id,
// not their IP, so it cannot be sidestepped by an admin behind NAT.
const matchAllLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisRateLimitStore('admin-youtube-match'),
  message: { error: 'Too many match requests. Please wait.', code: 'RATE_LIMITED' },
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
});

// ---------------------------------------------------------------------------
// POST /api/admin/youtube/match
// Body { songId? } — match a single song, or batch-match the top 50 unmatched.
// ---------------------------------------------------------------------------
adminYoutubeRouter.post(
  '/youtube/match',
  matchAllLimiter,
  [body('songId').optional().isString().notEmpty(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { songId } = req.body as { songId?: string };

      if (songId) {
        const match = await youtubeService.matchSong(songId);
        if (!match) {
          throw new ApiError('No YouTube match found for song', 'NO_MATCH', 404);
        }
        await invalidatePlaybackSourceCache(songId);
        return res.status(200).json({ matched: 1, failed: 0, match });
      }

      const result = await youtubeService.batchMatchSongs(50);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/youtube/match-all
// Enqueue the library-enrichment job for the whole (unmatched) catalog.
// Idempotent: repeated triggers within the same day collapse to one job.
// ---------------------------------------------------------------------------
adminYoutubeRouter.post(
  '/youtube/match-all',
  matchAllLimiter,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await enqueueLibraryEnrichment({ reason: 'admin-match-all' });
      if (!result.ok) {
        return res.status(200).json({ queued: false, reason: result.reason });
      }
      return res.status(202).json({ queued: true, jobId: result.jobId });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/youtube/status
// Library enrichment coverage: total songs, matched, unmatched.
// ---------------------------------------------------------------------------
adminYoutubeRouter.get('/youtube/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [total, matched] = await Promise.all([
      prisma.song.count({ where: { softDeleted: false } }),
      prisma.song.count({ where: { softDeleted: false, youtubeVideoId: { not: null } } }),
    ]);
    return res.status(200).json({ total, matched, unmatched: total - matched });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/youtube/match/:songId
// Match a single song by id.
// ---------------------------------------------------------------------------
adminYoutubeRouter.post(
  '/youtube/match/:songId',
  [param('songId').isString().notEmpty().withMessage('songId is required'), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { songId } = req.params;
      const match = await youtubeService.matchSong(songId);
      if (!match) {
        return res.status(200).json({ match: null });
      }
      await invalidatePlaybackSourceCache(songId);
      return res.status(200).json({ match });
    } catch (err) {
      return next(err);
    }
  },
);
