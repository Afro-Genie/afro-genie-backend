import { createHash, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body, param, query } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { ApiError } from '../../middleware/errorHandler';
import { createRedisRateLimitStore } from '../../lib/rateLimitStore';
import { youtubeCatalogImportQueue } from '../../lib/queue';
import { logger } from '../../lib/logger';
import { env } from '../../lib/env';
import { prisma } from '../../lib/prisma';
import { getCatalogImportQuota } from '../../lib/catalogImportQuota';
import { getCatalogImportWorkerStatus, getJobStallInfo } from '../../lib/catalogImportDiagnostics';
import { recoverCatalogImportJobById } from '../../jobs/catalogImportRecovery';
import type { YouTubeCatalogImportJobData } from '../../jobs/youtubeCatalogImportJob';
import { getAvailableYouTubeCatalogSources } from '../../services/youtubeCatalogPolicy';
import {
  estimateYouTubeCatalogQuota,
  resolveYouTubeCatalogImportSource,
  validateYouTubeCatalogPreview,
  type CatalogPlaylistCheckpoint,
  type CatalogImportSource,
  type CatalogPreview,
} from '../../services/youtubeCatalogImportService';

export const adminYouTubeCatalogImportsRouter = Router();

adminYouTubeCatalogImportsRouter.use(authenticate, requireRole('ADMIN'));

const enqueueLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisRateLimitStore('admin-youtube-catalog-import'),
  message: { error: 'Too many catalog import requests. Please wait.', code: 'RATE_LIMITED' },
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
});

const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisRateLimitStore('admin-youtube-catalog-import-status'),
  message: { error: 'Too many catalog import status requests. Please wait.', code: 'RATE_LIMITED' },
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
});

const jobRetention = {
  removeOnComplete: { age: 14 * 24 * 60 * 60, count: 1000 },
  removeOnFail: { age: 30 * 24 * 60 * 60, count: 1000 },
};

function requireQueueSupport(): void {
  if (
    typeof youtubeCatalogImportQueue.getJob !== 'function' ||
    typeof youtubeCatalogImportQueue.add !== 'function'
  ) {
    throw new ApiError('Catalog import queue is unavailable', 'SERVICE_UNAVAILABLE', 503);
  }
}

function adminIdFromRequest(req: Request): string {
  const adminId = req.user?.id;
  if (!adminId) throw new ApiError('Authenticated admin identity is unavailable', 'UNAUTHORIZED', 401);
  return adminId;
}

function publicJobId(jobId: string | undefined): string {
  if (!jobId) throw new ApiError('Catalog import queue did not return a job ID', 'SERVICE_UNAVAILABLE', 503);
  return jobId;
}

const activeStates = new Set(['waiting', 'active', 'delayed', 'paused', 'prioritized', 'waiting-children']);

type JobProgress = Record<string, unknown>;

async function requireImportWorkers(): Promise<void> {
  const status = await getCatalogImportWorkerStatus();
  if (!status.available) throw new ApiError(status.message, 'WORKER_UNAVAILABLE', 503);
}

function getProgress(job: { progress: unknown; processedOn?: number; timestamp: number }, state: string): {
  progress: JobProgress;
  stalled: boolean;
  stallReason: string;
} {
  const raw: JobProgress = typeof job.progress === 'object' && job.progress !== null
    ? { ...(job.progress as JobProgress) }
    : {};
  const terminal = !activeStates.has(state);
  const stall = terminal
    ? { stalled: false, reason: '', ageSeconds: 0, lastProgressAt: new Date().toISOString() }
    : getJobStallInfo(job as never);
  raw.stalled = stall.stalled;
  raw.stallReason = stall.stalled ? stall.reason : '';
  raw.stallAgeSeconds = stall.ageSeconds;
  raw.lastProgressAt = stall.lastProgressAt;

  if (typeof raw.percent !== 'number') {
    const current = Number(raw.current ?? raw.completed ?? raw.pagesRead ?? 0);
    const total = Number(raw.total ?? ((raw.pagesRead && raw.maxPages) || 0));
    if (total > 0 && Number.isFinite(current)) {
      raw.percent = Math.min(100, Math.round((current / total) * 100));
    }
  }
  return { progress: raw, stalled: stall.stalled, stallReason: raw.stallReason as string };
}

function displayStatus(state: string, progress: JobProgress, returnValue: unknown): string {
  const cancelled = progress.cancelled === true
    || Boolean((returnValue as { cancelled?: boolean } | null)?.cancelled);
  if (cancelled || returnValue === null && progress.cancelRequested === true) return 'cancelled';
  if (activeStates.has(state) && progress.cancelRequested === true) return 'cancelling';
  return state;
}

function statusActions(
  jobData: YouTubeCatalogImportJobData,
  state: string,
  progress: JobProgress,
  returnValue: unknown,
): string[] {
  const actions: string[] = [];
  if (activeStates.has(state)) {
    if (!progress.cancelRequested) actions.push('cancel');
    if (progress.stalled || progress.cancelRequested) actions.push('recover');
  }
  const missingResult = state === 'completed' && returnValue == null;
  const applyFailures = jobData.operation === 'apply'
    && state === 'completed'
    && Number((returnValue as { failed?: number } | null)?.failed) > 0;
  if (state === 'failed' || missingResult || applyFailures) actions.push('retry');
  const preview = returnValue as CatalogPreview | null;
  if (
    jobData.operation === 'preview'
    && state === 'completed'
    && preview && !preview.complete && preview.nextPageToken
  ) {
    actions.push('resume');
  }
  return actions;
}

function statusMessage(
  state: string,
  status: string,
  progress: JobProgress,
  failedReason: string | null | undefined,
  workerAvailable: boolean,
): string {
  if (typeof progress.message === 'string' && progress.message.trim()) return progress.message;
  if (status === 'cancelled') return 'Import cancelled. Already-imported songs were preserved.';
  if (status === 'cancelling') return 'Cancellation requested. Waiting for the worker to stop before the next song.';
  if (progress.stalled) {
    return `${progress.stallReason || 'The job appears stalled.'} Use Recover to queue a fresh job, or Cancel to stop it.`;
  }
  if (progress.stage === 'quota-paused' || typeof progress.quotaMessage === 'string') {
    return String(progress.quotaMessage || 'YouTube quota exhausted. Wait for the reset or use a different API key.');
  }
  if (state === 'failed') return failedReason || 'The import failed. Review the error and retry when ready.';
  if (state === 'completed') return 'Import finished.';
  if (state === 'active') return 'Import is running.';
  if (!workerAvailable) return 'Import workers are offline. Restart the backend with workers enabled before retrying.';
  return 'Job queued. Progress will appear within a few seconds.';
}

async function enqueuePreview(
  adminId: string,
  source: CatalogImportSource,
  retryOf?: string,
  requestId?: string,
  resumeCheckpoint?: CatalogPlaylistCheckpoint,
) {
  requireQueueSupport();
  const requestKey = retryOf
    ? `retry:${retryOf}`
    : requestId
      ? `request:${adminId}:${requestId}`
      : randomUUID();
  const jobId = `catalog_preview_${createHash('sha256').update(requestKey).digest('hex')}`;
  const data: YouTubeCatalogImportJobData = {
    operation: 'preview',
    adminId,
    source,
    ...(retryOf && { retryOf }),
    ...(resumeCheckpoint && { resumeCheckpoint }),
  };
  const existing = await youtubeCatalogImportQueue.getJob(jobId);
  if (existing) {
    if (
      existing.data.adminId !== adminId ||
      JSON.stringify(existing.data.source) !== JSON.stringify(source)
    ) {
      throw new ApiError('This request ID was already used for a different import source', 'IDEMPOTENCY_CONFLICT', 409);
    }
    return {
      jobId: String(existing.id),
      operation: 'preview',
      status: await existing.getState(),
      quotaEstimate: estimateYouTubeCatalogQuota(source),
      quota: await getCatalogImportQuota(),
      message: 'Using the existing preview job for this request.',
    };
  }
  await requireImportWorkers();
  const job = await youtubeCatalogImportQueue.add('preview', data, {
    ...jobRetention,
    attempts: 1,
    jobId,
  });
  if (
    job.data.adminId !== adminId ||
    JSON.stringify(job.data.source) !== JSON.stringify(source)
  ) {
    throw new ApiError('This request ID was already used for a different import source', 'IDEMPOTENCY_CONFLICT', 409);
  }
  const id = publicJobId(job.id);
  logger.info(
    { adminId, jobId: id, operation: 'preview', sourceType: source.type, sourceValue: source.value, retryOf },
    'Admin queued YouTube catalog preview',
  );
  return {
    jobId: id,
    operation: 'preview',
    status: 'queued',
    quotaEstimate: estimateYouTubeCatalogQuota(source),
    quota: await getCatalogImportQuota(),
    message: 'Preview queued. Progress will appear within a few seconds.',
  };
}

async function enqueueResume(
  adminId: string,
  sourcePreviewJobId: string,
  maxPages: number,
  retryOf?: string,
  resumeCheckpoint?: CatalogPlaylistCheckpoint,
) {
  requireQueueSupport();
  const sourceJob = await ownedJob(sourcePreviewJobId, adminId);
  if (!['preview', 'resume'].includes(sourceJob.data.operation) || await sourceJob.getState() !== 'completed') {
    throw new ApiError('A completed preview is required to resume playlist discovery', 'PREVIEW_NOT_READY', 409);
  }
  const preview = sourceJob.returnvalue as CatalogPreview | null;
  if (!preview || !preview.source || preview.source.type !== 'playlist' || preview.complete || !preview.nextPageToken) {
    throw new ApiError('This preview has no remaining playlist pages to resume', 'JOB_NOT_RESUMABLE', 409);
  }
  try {
    validateYouTubeCatalogPreview(preview, preview.previewHash, true);
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : 'Preview is no longer valid',
      'STALE_PREVIEW',
      409,
    );
  }

  const resumeKey = retryOf
    ? `retry:${sourcePreviewJobId}:${retryOf}`
    : `resume:${sourcePreviewJobId}`;
  const jobId = `catalog_resume_${createHash('sha256').update(resumeKey).digest('hex')}`;
  const data: YouTubeCatalogImportJobData = {
    operation: 'resume',
    adminId,
    sourcePreviewJobId,
    maxPages,
    ...(retryOf && { retryOf }),
    ...(resumeCheckpoint && { resumeCheckpoint }),
  };
  const existing = await youtubeCatalogImportQueue.getJob(jobId);
  if (existing) {
    if (
      existing.data.adminId !== adminId ||
      existing.data.operation !== 'resume' ||
      existing.data.sourcePreviewJobId !== sourcePreviewJobId ||
      existing.data.maxPages !== maxPages
    ) {
      throw new ApiError('This playlist preview already has a resume job with different settings', 'IDEMPOTENCY_CONFLICT', 409);
    }
    return {
      jobId: String(existing.id),
      operation: 'resume',
      status: await existing.getState(),
      quotaEstimate: estimateYouTubeCatalogQuota({ type: 'playlist', value: preview.source.value, maxPages }),
      quota: await getCatalogImportQuota(),
      message: 'Using the existing resume job for this playlist.',
    };
  }
  await requireImportWorkers();
  const job = await youtubeCatalogImportQueue.add('resume', data, {
    ...jobRetention,
    attempts: 1,
    jobId,
  });
  if (
    job.data.adminId !== adminId ||
    job.data.operation !== 'resume' ||
    job.data.sourcePreviewJobId !== sourcePreviewJobId ||
    job.data.maxPages !== maxPages
  ) {
    throw new ApiError('This playlist preview already has a resume job with different settings', 'IDEMPOTENCY_CONFLICT', 409);
  }
  const id = publicJobId(job.id);
  logger.info(
    { adminId, jobId: id, operation: 'resume', sourcePreviewJobId, retryOf },
    'Admin queued YouTube catalog preview resume',
  );
  return {
    jobId: id,
    operation: 'resume',
    status: 'queued',
    quotaEstimate: estimateYouTubeCatalogQuota({ type: 'playlist', value: preview.source.value, maxPages }),
    quota: await getCatalogImportQuota(),
    message: 'Resume queued. Progress will appear within a few seconds.',
  };
}

async function ownedJob(jobId: string, adminId: string) {
  requireQueueSupport();
  const job = await youtubeCatalogImportQueue.getJob(jobId);
  if (!job || job.data.adminId !== adminId) {
    throw new ApiError('Catalog import job not found', 'NOT_FOUND', 404);
  }
  return job;
}

async function getCompletedPreview(previewJobId: string, adminId: string, expectedHash: string) {
  const previewJob = await ownedJob(previewJobId, adminId);
  if (!['preview', 'resume'].includes(previewJob.data.operation) || await previewJob.getState() !== 'completed') {
    throw new ApiError('A completed preview is required before applying catalog changes', 'PREVIEW_NOT_READY', 409);
  }
  const preview = previewJob.returnvalue as CatalogPreview | null;
  if (!preview) {
    throw new ApiError(
      'The preview completed, but its result was not saved. Retry discovery to rebuild it before applying.',
      'PREVIEW_RESULT_MISSING',
      409,
    );
  }
  try {
    validateYouTubeCatalogPreview(preview, expectedHash);
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : 'Preview is no longer valid',
      'STALE_PREVIEW',
      409,
    );
  }
  return preview;
}

async function enqueueApply(
  adminId: string,
  previewJobId: string,
  previewHash: string,
  retryOf?: string,
  selectedVideoIds?: string[],
) {
  requireQueueSupport();
  const previewSuffix = previewJobId.replace(/^catalog_preview_/, '');
  const jobId = retryOf
    ? `catalog_apply_retry_${createHash('sha256').update(`${retryOf}:${previewHash}`).digest('hex')}`
    : `catalog_apply_${previewSuffix}`;
  const existing = await youtubeCatalogImportQueue.getJob(jobId);
  if (existing) {
    if (
      existing.data.adminId !== adminId ||
      existing.data.operation !== 'apply' ||
      existing.data.previewJobId !== previewJobId ||
      existing.data.expectedPreviewHash !== previewHash ||
      JSON.stringify(existing.data.selectedVideoIds || []) !== JSON.stringify(selectedVideoIds || [])
    ) {
      throw new ApiError('This preview already has an apply job with different settings', 'IDEMPOTENCY_CONFLICT', 409);
    }
    return {
      jobId: String(existing.id),
      operation: 'apply',
      status: await existing.getState(),
      quota: await getCatalogImportQuota(),
      message: 'Using the existing apply job for this confirmed preview.',
    };
  }
  await requireImportWorkers();
  const data: YouTubeCatalogImportJobData = {
    operation: 'apply',
    adminId,
    previewJobId,
    expectedPreviewHash: previewHash,
    ...(selectedVideoIds ? { selectedVideoIds } : {}),
    ...(retryOf && { retryOf }),
  };
  const job = await youtubeCatalogImportQueue.add('apply', data, {
    ...jobRetention,
    attempts: 1,
    jobId,
  });
  if (
    job.data.adminId !== adminId ||
    job.data.operation !== 'apply' ||
    job.data.previewJobId !== previewJobId ||
    job.data.expectedPreviewHash !== previewHash
  ) {
    throw new ApiError('This preview already has an apply job with different settings', 'IDEMPOTENCY_CONFLICT', 409);
  }
  const id = publicJobId(job.id);
  logger.info(
    { adminId, jobId: id, operation: 'apply', previewJobId, retryOf },
    'Admin queued YouTube catalog apply',
  );
  return {
    jobId: id,
    operation: 'apply',
    status: 'queued',
    quota: await getCatalogImportQuota(),
    message: 'Apply queued. Progress will appear within a few seconds.',
  };
}

adminYouTubeCatalogImportsRouter.post(
  '/youtube-catalog/imports/preview',
  enqueueLimiter,
  [
    body('playlistUrl').optional().isString().trim().notEmpty().isLength({ max: 500 }),
    body('sourceType').optional().isIn(['artist', 'genre', 'song']),
    body('query').optional().isString().trim().isLength({ min: 2, max: 100 }),
    body('requestId').optional().isUUID(),
    body('maxPages').optional().isInt({ min: 1, max: 80 }),
    body('maxResults').optional().isInt({ min: 1, max: 50 }),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!env.YOUTUBE_API_KEY) {
        throw new ApiError('YouTube Data API is not configured', 'SERVICE_UNAVAILABLE', 503);
      }
      const hasPlaylist = typeof req.body.playlistUrl === 'string';
      const hasSearch = typeof req.body.sourceType === 'string' || typeof req.body.query === 'string';
      if (hasPlaylist === hasSearch) {
        throw new ApiError(
          'Provide either playlistUrl or a sourceType and query for artist, genre, or song search.',
          'BAD_REQUEST',
          400,
        );
      }

      let source: CatalogImportSource;
      try {
        if (hasPlaylist) {
          if (req.body.sourceType !== undefined || req.body.query !== undefined) {
            throw new Error('Playlist and search inputs cannot be combined.');
          }
          if (req.body.maxResults !== undefined) {
            throw new Error('maxResults is only valid for search imports.');
          }
          source = resolveYouTubeCatalogImportSource(
            'playlist',
            req.body.playlistUrl,
            req.body.maxPages ? Number(req.body.maxPages) : 80,
          );
        } else {
          if (typeof req.body.sourceType !== 'string' || typeof req.body.query !== 'string') {
            throw new Error('Both sourceType and query are required for search imports.');
          }
          source = resolveYouTubeCatalogImportSource(
            req.body.sourceType,
            req.body.query,
            80,
            req.body.maxResults ? Number(req.body.maxResults) : 50,
          );
          if (req.body.maxPages !== undefined) {
            throw new Error('maxPages is only valid for playlist imports.');
          }
        }
      } catch (error) {
        throw new ApiError(error instanceof Error ? error.message : 'Invalid import source', 'BAD_REQUEST', 400);
      }
      const result = await enqueuePreview(adminIdFromRequest(req), source, undefined, req.body.requestId);
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminYouTubeCatalogImportsRouter.post(
  '/youtube-catalog/imports/:previewJobId/apply',
  enqueueLimiter,
  [
    param('previewJobId').isString().notEmpty(),
    body('confirm').custom((value) => value === true).withMessage('confirm must be true to apply catalog changes'),
    body('previewHash').isString().matches(/^[a-f0-9]{64}$/i),
    body('selectedVideoIds').optional().isArray({ min: 1, max: 100 }),
    body('selectedVideoIds.*').optional().isString().matches(/^[A-Za-z0-9_-]{11}$/),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = adminIdFromRequest(req);
      const preview = await getCompletedPreview(req.params.previewJobId, adminId, req.body.previewHash);
      if (Array.isArray(req.body.selectedVideoIds)) {
        const available = new Set(
          preview.items
            .filter((item) => item.action !== 'skip')
            .map((item) => item.candidate.video.videoId),
        );
        if (req.body.selectedVideoIds.some((videoId: string) => !available.has(videoId))) {
          throw new ApiError('A selected candidate is not available in this preview', 'BAD_REQUEST', 400);
        }
      }
      const result = await enqueueApply(
        adminId,
        req.params.previewJobId,
        req.body.previewHash,
        undefined,
        Array.isArray(req.body.selectedVideoIds) ? req.body.selectedVideoIds : undefined,
      );
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminYouTubeCatalogImportsRouter.post(
  '/youtube-catalog/imports/:jobId/retry',
  enqueueLimiter,
  [
    param('jobId').isString().notEmpty(),
    body('confirm').optional().isBoolean(),
    body('previewHash').optional().isString().matches(/^[a-f0-9]{64}$/i),
    body('selectedVideoIds').optional().isArray({ min: 1, max: 100 }),
    body('selectedVideoIds.*').optional().isString().matches(/^[A-Za-z0-9_-]{11}$/),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = adminIdFromRequest(req);
      const failedJob = await ownedJob(req.params.jobId, adminId);
      const state = await failedJob.getState();
      const originalData = failedJob.data as YouTubeCatalogImportJobData;
      const completedJobMissingResult = state === 'completed'
        && ['preview', 'resume', 'apply'].includes(originalData.operation)
        && failedJob.returnvalue == null;
      const completedApplyHasFailures = originalData.operation === 'apply'
        && state === 'completed'
        && Number((failedJob.returnvalue as { failed?: number } | null)?.failed) > 0;
      if (state !== 'failed' && !completedApplyHasFailures && !completedJobMissingResult) {
        throw new ApiError(
          'Only failed jobs, completed jobs missing their result, or completed apply jobs with candidate failures can be retried',
          'JOB_NOT_RETRYABLE',
          409,
        );
      }

      if (originalData.operation === 'preview') {
        if (!env.YOUTUBE_API_KEY) {
          throw new ApiError('YouTube Data API is not configured', 'SERVICE_UNAVAILABLE', 503);
        }
        let source = originalData.source;
        if (!source && originalData.playlistId) {
          source = resolveYouTubeCatalogImportSource(
            'playlist',
            originalData.playlistId,
            originalData.maxPages || 80,
          );
        } else if (!source && originalData.sourceType && originalData.query) {
          source = resolveYouTubeCatalogImportSource(
            originalData.sourceType,
            originalData.query,
            80,
            originalData.maxResults || 50,
          );
        }
        if (!source) {
          throw new ApiError('The failed preview cannot be retried with its original settings', 'JOB_NOT_RETRYABLE', 409);
        }
        const result = await enqueuePreview(
          adminId,
          source,
          req.params.jobId,
          undefined,
          originalData.resumeCheckpoint,
        );
        return res.status(202).json(result);
      }

      if (originalData.operation === 'resume') {
        if (!originalData.sourcePreviewJobId || !originalData.maxPages) {
          throw new ApiError('The failed resume cannot be retried with its original settings', 'JOB_NOT_RETRYABLE', 409);
        }
        const result = await enqueueResume(
          adminId,
          originalData.sourcePreviewJobId,
          originalData.maxPages,
          req.params.jobId,
          originalData.resumeCheckpoint,
        );
        return res.status(202).json(result);
      }

      const previewHash = req.body.previewHash || originalData.expectedPreviewHash;
      if (req.body.confirm !== true || typeof previewHash !== 'string') {
        throw new ApiError('Retrying an apply job requires confirm: true and its previewHash', 'CONFIRMATION_REQUIRED', 400);
      }
      const previewJobId = originalData.previewJobId;
      if (!previewJobId) throw new ApiError('The failed apply job has no associated preview', 'JOB_NOT_RETRYABLE', 409);
      await getCompletedPreview(previewJobId, adminId, previewHash);
      const result = await enqueueApply(
        adminId,
        previewJobId,
        previewHash,
        req.params.jobId,
        Array.isArray(req.body.selectedVideoIds)
          ? req.body.selectedVideoIds
          : originalData.selectedVideoIds,
      );
      return res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminYouTubeCatalogImportsRouter.post(
  '/youtube-catalog/imports/:jobId/resume',
  enqueueLimiter,
  [
    param('jobId').isString().notEmpty(),
    body('maxPages').optional().isInt({ min: 1, max: 80 }),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!env.YOUTUBE_API_KEY) {
        throw new ApiError('YouTube Data API is not configured', 'SERVICE_UNAVAILABLE', 503);
      }
      const result = await enqueueResume(
        adminIdFromRequest(req),
        req.params.jobId,
        req.body.maxPages ? Number(req.body.maxPages) : 80,
      );
      res.status(202).json(result);
    } catch (error) {
      next(error);
    }
  },
);

adminYouTubeCatalogImportsRouter.post(
  '/youtube-catalog/imports/:jobId/cancel',
  enqueueLimiter,
  [param('jobId').isString().notEmpty(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = adminIdFromRequest(req);
      const job = await ownedJob(req.params.jobId, adminId);
      const state = await job.getState();
      if (!activeStates.has(state)) {
        res.status(200).json({
          jobId: String(job.id),
          status: state,
          cancelled: false,
          preserved: true,
          message: `This job had already finished with status ${state}; nothing was changed.`,
        });
        return;
      }
      const progress = getProgress(job, state).progress;
      await job.updateData({ ...job.data, cancelRequested: true });
      if (state === 'active') {
        await job.updateProgress({
          ...progress,
          stage: 'cancelling',
          cancelRequested: true,
          lastUpdatedAt: new Date().toISOString(),
          message: 'Cancellation requested. The worker will stop before the next song; imported songs are kept.',
        });
      } else {
        await job.remove();
      }
      logger.info({ adminId, jobId: job.id, state }, 'Admin cancelled YouTube catalog import');
      res.status(200).json({
        jobId: String(job.id),
        status: state === 'active' ? 'cancelling' : 'cancelled',
        cancelled: true,
        preserved: true,
        message: state === 'active'
          ? 'Cancellation requested. Already-imported songs are kept; the remaining songs will be skipped.'
          : 'Queued job cancelled. Nothing was applied.',
      });
    } catch (error) {
      next(error);
    }
  },
);

adminYouTubeCatalogImportsRouter.post(
  '/youtube-catalog/imports/:jobId/recover',
  enqueueLimiter,
  [param('jobId').isString().notEmpty(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = adminIdFromRequest(req);
      await ownedJob(req.params.jobId, adminId);
      const result = await recoverCatalogImportJobById(
        req.params.jobId,
        'Recovered manually from the import monitor',
      );
      logger.info({ adminId, jobId: req.params.jobId, recoveredTo: result.jobId }, 'Admin recovered catalog import');
      res.status(202).json({
        jobId: result.jobId,
        status: 'queued',
        recoveredFrom: result.recoveredFrom,
        message: result.message,
      });
    } catch (error) {
      if (error instanceof Error && /not found|Only queued or running/i.test(error.message)) {
        next(new ApiError(error.message, 'JOB_NOT_RECOVERABLE', 409));
        return;
      }
      next(error);
    }
  },
);

adminYouTubeCatalogImportsRouter.get(
  '/youtube-catalog/imports/sources',
  statusLimiter,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const configured = getAvailableYouTubeCatalogSources();
      const approved = await prisma.africanMusicChannel.findMany({
        where: { approved: true },
        orderBy: { artistName: 'asc' },
        select: { channelId: true, artistName: true, countryCode: true, genres: true },
      });
      const artists = new Map(configured.artists.map((artist) => [artist.name.toLowerCase(), artist]));
      for (const channel of approved) {
        const key = channel.artistName.toLowerCase();
        const existing = artists.get(key);
        artists.set(key, {
          name: existing?.name || channel.artistName,
          genres: [...new Set([...(existing?.genres || []), ...channel.genres])].sort(),
        });
      }
      res.status(200).json({
        artists: [...artists.values()],
        genres: [...new Set([...configured.genres, ...approved.flatMap((channel) => channel.genres)])].sort(),
      });
    } catch (error) {
      next(error);
    }
  },
);

adminYouTubeCatalogImportsRouter.post(
  '/youtube-catalog/imports/channels/approve',
  enqueueLimiter,
  [
    body('channelId').isString().matches(/^UC[A-Za-z0-9_-]{22}$/),
    body('artistName').isString().trim().isLength({ min: 2, max: 120 }),
    body('countryCode').isString().trim().isLength({ min: 2, max: 2 }).isUppercase(),
    body('genres').isArray({ min: 1, max: 10 }),
    body('genres.*').isString().trim().isLength({ min: 2, max: 60 }),
    body('evidenceUrl').optional().isURL({ protocols: ['https'], require_protocol: true }),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const channel = await prisma.africanMusicChannel.upsert({
        where: { channelId: req.body.channelId },
        update: {
          artistName: req.body.artistName,
          countryCode: req.body.countryCode,
          genres: [...new Set(req.body.genres as string[])],
          evidenceUrl: req.body.evidenceUrl || null,
          approved: true,
          reviewedAt: new Date(),
        },
        create: {
          channelId: req.body.channelId,
          artistName: req.body.artistName,
          countryCode: req.body.countryCode,
          genres: [...new Set(req.body.genres as string[])],
          evidenceUrl: req.body.evidenceUrl || null,
          approved: true,
        },
      });
      logger.info(
        { adminId: adminIdFromRequest(req), channelId: channel.channelId, artistName: channel.artistName },
        'Approved African music YouTube channel',
      );
      res.status(200).json(channel);
    } catch (error) {
      next(error);
    }
  },
);

adminYouTubeCatalogImportsRouter.get(
  '/youtube-catalog/imports/history',
  statusLimiter,
  [
    query('limit').optional().isInt({ min: 1, max: 50 }),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireQueueSupport();
      if (typeof youtubeCatalogImportQueue.getJobs !== 'function') {
        throw new ApiError('Catalog import history is unavailable', 'SERVICE_UNAVAILABLE', 503);
      }

      const adminId = adminIdFromRequest(req);
      const limit = Number(req.query.limit || 20);
      const jobs = await youtubeCatalogImportQueue.getJobs(
        ['waiting', 'active', 'delayed', 'completed', 'failed'],
        0,
        Math.min(limit * 10, 500) - 1,
        false,
      );
      const ownedJobs = jobs.filter((job) => job.data.adminId === adminId).slice(0, limit);
      const history = await Promise.all(ownedJobs.map(async (job) => {
        const state = await job.getState();
        const { progress } = getProgress(job, state);
        return {
          jobId: String(job.id),
          operation: job.data.operation,
          status: displayStatus(state, progress, job.returnvalue),
          progressStage: typeof progress.stage === 'string' ? progress.stage : null,
          percent: typeof progress.percent === 'number' ? progress.percent : null,
          stalled: progress.stalled === true,
          cancelRequested: progress.cancelRequested === true || job.data.cancelRequested === true,
          message: typeof progress.message === 'string' ? progress.message : '',
          source: job.data.source || null,
          previewJobId: job.data.operation === 'apply'
            ? job.data.previewJobId || null
            : String(job.id),
          createdAt: new Date(job.timestamp).toISOString(),
          finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        };
      }));

      res.status(200).json({ jobs: history });
    } catch (error) {
      next(error);
    }
  },
);

adminYouTubeCatalogImportsRouter.get(
  '/youtube-catalog/imports/:jobId',
  statusLimiter,
  [
    param('jobId').isString().notEmpty(),
    query('page').optional().isInt({ min: 1 }),
    query('pageSize').optional().isInt({ min: 1, max: 100 }),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminId = adminIdFromRequest(req);
      const job = await ownedJob(req.params.jobId, adminId);
      const state = await job.getState();
      const workerStatus = await getCatalogImportWorkerStatus();
      const { progress } = getProgress(job, state);
      const missingResult = state === 'completed'
        && ['preview', 'resume', 'apply'].includes(job.data.operation)
        && job.returnvalue == null;
      const cancelledReturn = Boolean((job.returnvalue as { cancelled?: boolean } | null)?.cancelled);
      const status = cancelledReturn ? 'cancelled' : missingResult ? 'failed' : displayStatus(state, progress, job.returnvalue);
      const recoveryMessage = job.data.operation === 'apply'
        ? 'The apply finished, but its result was not saved. Retry the confirmed apply safely to recover the result.'
        : 'The preview finished, but its result was not saved. Retry discovery to rebuild the preview.';
      if (missingResult) {
        progress.stage = job.data.operation === 'apply' ? 'apply-result-missing' : 'preview-result-missing';
      }
      const quota = (progress.quota as Awaited<ReturnType<typeof getCatalogImportQuota>> | undefined)
        || await getCatalogImportQuota();
      const failedReason = missingResult ? recoveryMessage : state === 'failed' ? job.failedReason : null;
      const result = {
        jobId: String(job.id),
        operation: job.data.operation,
        status,
        ...(job.data.operation === 'apply' && {
          previewJobId: job.data.previewJobId || null,
          previewHash: job.data.expectedPreviewHash || null,
          selectedVideoIds: job.data.selectedVideoIds || [],
        }),
        progress,
        quota,
        stalled: progress.stalled === true,
        actions: statusActions(job.data, state, progress, job.returnvalue),
        message: statusMessage(state, status, progress, failedReason, workerStatus.available),
        attemptsMade: job.attemptsMade,
        createdAt: new Date(job.timestamp).toISOString(),
        finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        failedReason,
        ...(missingResult ? { recovery: 'missing-result' as const } : {}),
      };

      if (state !== 'completed' || cancelledReturn) {
        res.status(200).json(result);
        return;
      }

      if (job.data.operation === 'preview' || job.data.operation === 'resume') {
        const preview = job.returnvalue as CatalogPreview | null;
        if (!preview) {
          res.status(200).json({
            ...result,
            status: 'failed',
            progress: { stage: 'preview-result-missing' },
            failedReason: recoveryMessage,
            recovery: 'missing-result',
          });
          return;
        }
        const page = Number(req.query.page || 1);
        const pageSize = Number(req.query.pageSize || 50);
        const offset = (page - 1) * pageSize;
        res.status(200).json({
          ...result,
          preview: {
            previewHash: preview.previewHash,
            policyFingerprint: preview.policyFingerprint,
            source: preview.source,
            createdAt: preview.createdAt,
            complete: preview.complete,
            hasMore: !preview.complete,
            discovery: preview.discovery,
            summary: preview.summary,
            page,
            pageSize,
            totalItems: preview.items.length,
            items: preview.items.slice(offset, offset + pageSize).map((item) => ({
              videoId: item.candidate.video.videoId,
              title: item.normalizedTitle,
              sourceTitle: item.candidate.video.title,
              artistName: item.candidate.channel.artistName,
              channelId: item.candidate.channel.channelId,
              genres: item.candidate.genres,
              imageUrl: item.candidate.imageUrl,
              durationSeconds: item.candidate.video.durationSeconds,
              publishedAt: item.candidate.video.publishedAt,
              action: item.action,
              reason: item.reason,
              selected: item.selected,
            })),
          },
        });
        return;
      }

      if (missingResult) {
        res.status(200).json({
          ...result,
          progress: { stage: 'apply-result-missing' },
          recovery: 'missing-result',
        });
        return;
      }

      res.status(200).json({ ...result, result: job.returnvalue });
    } catch (error) {
      next(error);
    }
  },
);
