import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body, param, query } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { lyricsEnrichmentQueue, syncQueue } from '../../lib/queue';
import { redis } from '../../lib/redis';
import { ApiError } from '../../middleware/errorHandler';
import { logger } from '../../lib/logger';
import { getLyricsBackfillCoverage, getSongsNeedingLyrics } from '../../services/lyricsBackfillService';
import { getLastSyncStatus, getSyncDashboard } from '../../services/syncStatusService';
import { LYRICS_BACKFILL_PAUSED_KEY } from '../../services/syncStatusService';

export const adminSyncRouter = Router();

adminSyncRouter.use(authenticate, requireRole('ADMIN'));

const SYNC_JOB_TYPES = ['backfill-artists-lastfm', 'enrich-artist-lastfm', 'library-enrichment'];

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

const lyricsBackfillLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 2,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Lyrics backfill is limited to two runs per minute.', code: 'RATE_LIMITED' },
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
});

function getAdminId(req: Request): string {
  const adminId = req.user?.id;
  if (!adminId) throw new ApiError('Authenticated admin identity is unavailable', 'UNAUTHORIZED', 401);
  return adminId;
}

function hashSongIds(songIds: readonly string[]): string {
  return createHash('sha256').update([...songIds].sort().join('\n')).digest('hex');
}

function requireSyncQueueSupport(): void {
  if (
    typeof syncQueue.getJob !== 'function'
    || typeof syncQueue.getJobs !== 'function'
    || typeof syncQueue.add !== 'function'
  ) {
    throw new ApiError('Lyrics backfill queue is unavailable', 'SERVICE_UNAVAILABLE', 503);
  }
}

adminSyncRouter.get(
  '/sync/lyrics-backfill/preview',
  syncStatusLimiter,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const candidates = await getSongsNeedingLyrics();
      const coverage = await getLyricsBackfillCoverage(candidates);
      res.status(200).json({
        ...coverage,
        previewHash: hashSongIds(candidates.map((song) => song.id)),
      });
    } catch (error) {
      next(error);
    }
  },
);

adminSyncRouter.post(
  '/sync/lyrics-backfill',
  lyricsBackfillLimiter,
  [
    body('confirm').custom((value) => value === true).withMessage('Explicit confirmation is required'),
    body('previewHash').isString().matches(/^[a-f0-9]{64}$/i),
    body('requestId').isUUID(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireSyncQueueSupport();
      const adminId = getAdminId(req);
      const candidates = await getSongsNeedingLyrics();
      const candidateIds = candidates.map((song) => song.id);
      const currentHash = hashSongIds(candidateIds);
      if (candidateIds.length === 0) {
        throw new ApiError('There are no eligible YouTube-linked songs missing lyrics', 'NO_ELIGIBLE_SONGS', 409);
      }
      if (currentHash !== String(req.body.previewHash).toLowerCase()) {
        throw new ApiError('The eligible songs changed since preview. Refresh the preview before applying.', 'STALE_PREVIEW', 409);
      }

      const idempotencyKey = createHash('sha256')
        .update(`${adminId}:${currentHash}:${String(req.body.requestId)}`)
        .digest('hex');
      const uniqueJobId = `admin-lyrics-backfill-${idempotencyKey}`;
      const existing = await syncQueue.getJob(uniqueJobId);
      if (existing) {
        if (
          existing.data.adminId !== adminId
          || existing.data.previewHash !== currentHash
          || existing.data.requestId !== req.body.requestId
        ) {
          throw new ApiError('This backfill request conflicts with an existing job', 'IDEMPOTENCY_CONFLICT', 409);
        }
        res.status(202).json({
          jobId: String(existing.id),
          status: await existing.getState(),
          eligible: candidateIds.length,
        });
        return;
      }

      const activeJobs = await syncQueue.getJobs(['waiting', 'active', 'delayed'], 0, 249, false);
      const alreadyRunning = activeJobs.find((job) =>
        job.data.type === 'admin-lyrics-backfill',
      );
      if (alreadyRunning) {
        throw new ApiError(
          `A lyrics backfill is already ${await alreadyRunning.getState()}. Wait for it to finish before starting another.`,
          'BACKFILL_ALREADY_RUNNING',
          409,
        );
      }

      const job = await syncQueue.add(
        'admin-lyrics-backfill',
        {
          type: 'admin-lyrics-backfill',
          adminId,
          previewHash: currentHash,
          requestId: String(req.body.requestId),
          songIds: candidateIds,
        },
        {
          jobId: uniqueJobId,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
      logger.info({ adminId, jobId: job.id, eligible: candidateIds.length }, 'Admin queued confirmed lyrics backfill');
      res.status(202).json({ jobId: job.id, status: 'queued', eligible: candidateIds.length });
    } catch (error) {
      next(error);
    }
  },
);

adminSyncRouter.get(
  '/sync/lyrics-backfill/history',
  syncStatusLimiter,
  [query('limit').optional().isInt({ min: 1, max: 50 }), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (typeof syncQueue.getJobs !== 'function' || typeof lyricsEnrichmentQueue.getJobs !== 'function') {
        throw new ApiError('Lyrics backfill history is unavailable', 'SERVICE_UNAVAILABLE', 503);
      }
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const scanCount = Math.min(limit * 5, 250);
      const states = ['waiting', 'active', 'delayed', 'completed', 'failed'] as const;
      const [syncJobs, enrichmentJobs] = await Promise.all([
        syncQueue.getJobs([...states], 0, scanCount - 1, false),
        lyricsEnrichmentQueue.getJobs([...states], 0, scanCount - 1, false),
      ]);
      const backfillSyncJobs = syncJobs.filter((job) =>
        job.data.type === 'admin-lyrics-backfill' || job.data.type === 'backfill-lyrics',
      );
      const backfillSongJobs = enrichmentJobs.filter((job) =>
        String(job.id).startsWith('lyrics-enrichment-backfill-'),
      );
      const adminId = getAdminId(req);
      const history = await Promise.all([
        ...backfillSyncJobs.map(async (job) => {
          const status = await job.getState();
          return {
            jobId: String(job.id),
            type: job.data.type,
            status,
            queue: 'sync',
            attribution: job.data.adminId ? 'admin' : 'scheduled',
            adminId: job.data.adminId || null,
            createdAt: new Date(job.timestamp).toISOString(),
            finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
            progress: job.progress,
            result: status === 'completed' ? job.returnvalue : null,
            failedReason: status === 'failed' ? job.failedReason : null,
          };
        }),
        ...backfillSongJobs.map(async (job) => {
          const status = await job.getState();
          return {
            jobId: String(job.id),
            type: 'scheduled-lyrics-song',
            status,
            queue: 'lyrics-enrichment',
            attribution: 'scheduled',
            adminId: null,
            songId: job.data.songId || null,
            attemptsMade: job.attemptsMade,
            createdAt: new Date(job.timestamp).toISOString(),
            finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
            result: status === 'completed' ? job.returnvalue : null,
            failedReason: status === 'failed' ? job.failedReason : null,
          };
        }),
      ]);
      const visibleHistory = history
        .filter((entry) => entry.attribution !== 'admin' || entry.adminId === adminId)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit);
      res.status(200).json({ jobs: visibleHistory });
    } catch (error) {
      next(error);
    }
  },
);

adminSyncRouter.get(
  '/sync/lyrics-backfill/:jobId',
  syncStatusLimiter,
  [param('jobId').isString().notEmpty(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireSyncQueueSupport();
      const job = await syncQueue.getJob(req.params.jobId);
      const adminId = getAdminId(req);
      if (!job || job.data.type !== 'admin-lyrics-backfill' || job.data.adminId !== adminId) {
        throw new ApiError('Lyrics backfill job not found', 'NOT_FOUND', 404);
      }

      const status = await job.getState();
      res.status(200).json({
        jobId: String(job.id),
        status,
        progress: job.progress,
        result: status === 'completed' ? job.returnvalue : null,
        failedReason: status === 'failed' ? job.failedReason : null,
        createdAt: new Date(job.timestamp).toISOString(),
        finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
      });
    } catch (error) {
      next(error);
    }
  },
);

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
      const adminId = getAdminId(req);

      const needsArtistId = type === 'enrich-artist-lastfm';
      if (needsArtistId && !artistId) {
        res.status(400).json({
          error: `artistId is required when type is "${type}"`,
          code: 'MISSING_ARTIST_ID',
        });
        return;
      }

      const job = await syncQueue.add(
        type,
        { type, artistId, adminId },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      );

      logger.info({ adminId, jobId: job.id, type, artistId }, 'Admin queued sync job');
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

// ---------------------------------------------------------------------------
// POST /api/admin/sync/pause-lyrics-backfill
// Pause the recurring lyrics backfill cron job by setting a Redis flag.
// The cron will skip enqueuing new enrichment jobs while the flag is set.
// ---------------------------------------------------------------------------
adminSyncRouter.post(
  '/sync/pause-lyrics-backfill',
  syncRunLimiter,
  [
    body('adminId').isString().notEmpty().withMessage('adminId is required'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { adminId } = req.body as { adminId: string };
      await redis.set(LYRICS_BACKFILL_PAUSED_KEY, 'true', 'EX', 60 * 60 * 24 * 30); // 30-day expiry
      logger.info({ adminId }, 'Lyrics backfill paused by admin');
      res.status(200).json({ status: 'paused', key: LYRICS_BACKFILL_PAUSED_KEY });
    } catch (error) {
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/sync/resume-lyrics-backfill
// Resume the recurring lyrics backfill cron job by clearing the Redis flag.
// The cron will resume enqueuing enrichment jobs.
// ---------------------------------------------------------------------------
adminSyncRouter.post(
  '/sync/resume-lyrics-backfill',
  syncRunLimiter,
  [
    body('adminId').isString().notEmpty().withMessage('adminId is required'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { adminId } = req.body as { adminId: string };
      await redis.del(LYRICS_BACKFILL_PAUSED_KEY);
      logger.info({ adminId }, 'Lyrics backfill resumed by admin');
      res.status(200).json({ status: 'resumed', key: LYRICS_BACKFILL_PAUSED_KEY });
    } catch (error) {
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/sync/lyrics-backfill/status
// Get the current pause status of the lyrics backfill cron.
// ---------------------------------------------------------------------------
adminSyncRouter.get(
  '/sync/lyrics-backfill/status',
  syncStatusLimiter,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const paused = await redis.get(LYRICS_BACKFILL_PAUSED_KEY);
      res.status(200).json({
        paused: paused === 'true',
        key: LYRICS_BACKFILL_PAUSED_KEY,
      });
    } catch (error) {
      next(error);
    }
  },
);
