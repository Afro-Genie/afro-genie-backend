import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { syncQueue, syncPopularTracksQueue } from '../../lib/queue';
import { getLastSyncStatus, getSyncDashboard } from '../../services/syncEngine';

export const adminSyncRouter = Router();

adminSyncRouter.use(authenticate, requireRole('ADMIN'));

const SYNC_JOB_TYPES = ['artist', 'artist-albums', 'artist-full', 'sync-all', 'refresh-stale', 'sync-genres', 'sync-popular-tracks'];

const syncRunLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sync requests. Please wait before triggering another sync.', code: 'RATE_LIMITED' },
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
});

const syncStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many status requests. Please wait.', code: 'RATE_LIMITED' },
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
});

// ---------------------------------------------------------------------------
// POST /api/admin/sync/run
// Queue a sync job. Type must be one of the supported job types.
// ---------------------------------------------------------------------------
adminSyncRouter.post(
  '/sync/run',
  syncRunLimiter,
  [
    body('type')
      .isString()
      .isIn(SYNC_JOB_TYPES)
      .withMessage(`type must be one of: ${SYNC_JOB_TYPES.join(', ')}`),
    body('artistId')
      .optional({ nullable: true })
      .isString()
      .withMessage('artistId must be a string when provided'),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type, artistId } = req.body as {
        type: string;
        artistId?: string;
      };

      const needsArtistId = type === 'artist' || type === 'artist-albums' || type === 'artist-full';
      if (needsArtistId && !artistId) {
        res.status(400).json({
          error: `artistId is required when type is "${type}"`,
          code: 'MISSING_ARTIST_ID',
        });
        return;
      }

      const jobName =
        type === 'sync-all'
          ? 'sync-all'
          : type === 'refresh-stale'
            ? 'refresh-stale'
            : type === 'sync-genres'
              ? 'sync-genres'
              : type === 'sync-popular-tracks'
                ? 'sync-popular-tracks'
                : `sync-${type}-${artistId}`;

      const targetQueue = type === 'sync-popular-tracks' ? syncPopularTracksQueue : syncQueue;

      const job = await targetQueue.add(jobName, { type, artistId }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      });

      res.status(202).json({ jobId: job.id, type, status: 'queued' });
    } catch (error) {
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/sync/status
// Legacy status endpoint — backward-compatible.
// ---------------------------------------------------------------------------
adminSyncRouter.get(
  '/sync/status',
  syncStatusLimiter,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await getLastSyncStatus();
      res.status(200).json(status);
    } catch (error) {
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/sync/dashboard
// Rich monitoring dashboard with queue depth, durations, and failure rates.
// ---------------------------------------------------------------------------
adminSyncRouter.get(
  '/sync/dashboard',
  syncStatusLimiter,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const dashboard = await getSyncDashboard();
      res.status(200).json(dashboard);
    } catch (error) {
      next(error);
    }
  },
);
