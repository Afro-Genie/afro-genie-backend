import { Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import type { NextFunction, Request, Response } from 'express';
import { TranslationStatus, VoteType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import { translationQueue } from '../lib/queue';
import { estimateCostUsd } from '../services/providers/geminiProvider';
import {
  checkDailyBudget,
  checkUserRateLimit,
  getActiveProvider,
  getTranslationsBySong,
  logAICall,
  requestTranslation,
} from '../services/translationService';

export const translationsRouter = Router();

const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new ApiError(errors.array()[0].msg as string, 'VALIDATION_ERROR', 400));
  }
  return next();
};

// ---------------------------------------------------------------------------
// POST /api/translations/request
// Authenticated. Returns existing approved translation or enqueues a new job.
// ---------------------------------------------------------------------------
translationsRouter.post(
  '/translations/request',
  authenticate,
  [
    body('songId').isString().notEmpty().withMessage('songId is required'),
    body('sourceLang').isString().notEmpty().withMessage('sourceLang is required'),
    body('targetLang').isString().notEmpty().withMessage('targetLang is required'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { songId, sourceLang, targetLang } = req.body as {
        songId: string;
        sourceLang: string;
        targetLang: string;
      };
      const userId = req.user!.id;

      // Per-user daily rate limit
      const rateLimit = await checkUserRateLimit(userId);
      if (!rateLimit.allowed) {
        return next(
          new ApiError(
            `Daily translation limit reached. Try again after ${rateLimit.resetAt.toISOString()}.`,
            'RATE_LIMITED',
            429,
          ),
        );
      }

      // Daily budget guard
      const budget = await checkDailyBudget();
      if (!budget.withinBudget) {
        return next(
          new ApiError(
            'Translation service is temporarily at capacity. Please try again later.',
            'BUDGET_EXCEEDED',
            503,
          ),
        );
      }

      const outcome = await requestTranslation({ songId, userId, sourceLang, targetLang });

      if (outcome.status === 'existing') {
        return res.status(200).json({ status: 'existing', translation: outcome.translation });
      }

      return res.status(202).json({
        status: 'queued',
        jobId: outcome.jobId,
        rateLimit: { remaining: rateLimit.remaining, resetAt: rateLimit.resetAt },
      });
    } catch (err) {
      const e = err as Error & { code?: string; httpStatus?: number };
      if (e.code === 'NOT_FOUND') {
        return next(new ApiError(e.message, 'NOT_FOUND', 404));
      }
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/translations/status/:jobId
// Returns BullMQ job state for a queued translation.
// NOTE: This route must be declared before /translations/:songId to avoid
// "status" being matched as a songId.
// ---------------------------------------------------------------------------
translationsRouter.get(
  '/translations/status/:jobId',
  authenticate,
  [param('jobId').isString().notEmpty().withMessage('jobId is required')],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.params;
      const job = await translationQueue.getJob(jobId);

      if (!job) {
        return next(new ApiError('Job not found', 'NOT_FOUND', 404));
      }

      const state = await job.getState();

      return res.status(200).json({
        jobId,
        state,
        progress: job.progress,
        data: job.data,
        ...(state === 'failed' && {
          userMessage: 'Translation failed after multiple attempts. Please try again.',
        }),
        ...(job.failedReason && { failedReason: job.failedReason }),
        ...(job.finishedOn && { finishedOn: new Date(job.finishedOn) }),
      });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/translations/:songId
// Returns all translations for a song grouped by targetLang.
// ---------------------------------------------------------------------------
translationsRouter.get(
  '/translations/:songId',
  [param('songId').isString().notEmpty().withMessage('songId is required')],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { songId } = req.params;
      const grouped = await getTranslationsBySong(songId);
      return res.status(200).json({ songId, translations: grouped });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/translations/:id/vote
// Authenticated. Toggle/update vote and sync aggregate counters.
// ---------------------------------------------------------------------------
translationsRouter.post(
  '/translations/:id/vote',
  authenticate,
  [
    param('id').isString().notEmpty().withMessage('id is required'),
    body('voteType').isIn([VoteType.UPVOTE, VoteType.DOWNVOTE]).withMessage('voteType must be UPVOTE or DOWNVOTE'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const translationId = req.params.id;
      const userId = req.user!.id;
      const voteType = req.body.voteType as VoteType;

      const result = await prisma.$transaction(async (tx) => {
        const translation = await tx.translation.findUnique({
          where: { id: translationId },
          select: { id: true },
        });

        if (!translation) {
          throw new ApiError('Translation not found', 'NOT_FOUND', 404);
        }

        const existingVote = await tx.translationVote.findUnique({
          where: {
            translationId_userId: {
              translationId,
              userId,
            },
          },
        });

        let userVote: VoteType | null = null;

        if (existingVote) {
          if (existingVote.voteType === voteType) {
            await tx.translationVote.delete({ where: { id: existingVote.id } });
            userVote = null;
          } else {
            await tx.translationVote.update({
              where: { id: existingVote.id },
              data: { voteType },
            });
            userVote = voteType;
          }
        } else {
          await tx.translationVote.create({
            data: {
              translationId,
              userId,
              voteType,
            },
          });
          userVote = voteType;
        }

        const [upvotes, downvotes] = await Promise.all([
          tx.translationVote.count({ where: { translationId, voteType: VoteType.UPVOTE } }),
          tx.translationVote.count({ where: { translationId, voteType: VoteType.DOWNVOTE } }),
        ]);

        await tx.translation.update({
          where: { id: translationId },
          data: { upvotes, downvotes },
        });

        return { upvotes, downvotes, userVote };
      });

      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/translations/:id/publish
// Admin-only. Transitions APPROVED -> PUBLISHED.
// ---------------------------------------------------------------------------
translationsRouter.post(
  '/translations/:id/publish',
  authenticate,
  requireRole('ADMIN'),
  [param('id').isString().notEmpty().withMessage('id is required')],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const translationId = req.params.id;

      const translation = await prisma.translation.findUnique({
        where: { id: translationId },
        select: { id: true, status: true },
      });

      if (!translation) {
        return next(new ApiError('Translation not found', 'NOT_FOUND', 404));
      }

      if (translation.status !== TranslationStatus.APPROVED) {
        return next(
          new ApiError(
            `Cannot publish translation with status "${translation.status}". Must be APPROVED.`,
            'INVALID_STATUS',
            422,
          ),
        );
      }

      const updated = await prisma.translation.update({
        where: { id: translationId },
        data: { status: TranslationStatus.PUBLISHED },
      });

      return res.status(200).json({ status: 'published', translation: updated });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /api/translations/:id
// Authenticated. Updates translation content (e.g. reset to empty).
// ---------------------------------------------------------------------------
translationsRouter.put(
  '/translations/:id',
  authenticate,
  [param('id').isString().notEmpty(), body('translatedLyrics').isString()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { translatedLyrics } = req.body as { translatedLyrics: string };

      const translation = await prisma.translation.findUnique({
        where: { id },
        select: { id: true, userId: true },
      });

      if (!translation) {
        return next(new ApiError('Translation not found', 'NOT_FOUND', 404));
      }

      if (translation.userId !== req.user!.id && req.user!.role !== 'ADMIN') {
        return next(new ApiError('Forbidden', 'FORBIDDEN', 403));
      }

      const updated = await prisma.translation.update({
        where: { id },
        data: { translatedLyrics },
      });

      return res.status(200).json(updated);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/translations/:id/correction
// Authenticated. Creates a correction record with PENDING status.
// ---------------------------------------------------------------------------
translationsRouter.post(
  '/translations/:id/correction',
  authenticate,
  [
    param('id').isString().notEmpty().withMessage('id is required'),
    body('originalText').isString().notEmpty().withMessage('originalText is required'),
    body('suggestedText').isString().notEmpty().withMessage('suggestedText is required'),
    body('reason').optional({ nullable: true }).isString(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const translationId = req.params.id;
      const userId = req.user!.id;
      const { originalText, suggestedText, reason } = req.body as {
        originalText: string;
        suggestedText: string;
        reason?: string;
      };

      const translation = await prisma.translation.findUnique({
        where: { id: translationId },
        select: { id: true },
      });

      if (!translation) {
        return next(new ApiError('Translation not found', 'NOT_FOUND', 404));
      }

      const correction = await prisma.translationCorrection.create({
        data: {
          translationId,
          userId,
          originalText,
          suggestedText,
          reason: reason ?? null,
        },
      });

      return res.status(201).json(correction);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/translations/detect-language
// Public endpoint. {lyrics} -> {languageCode, languageName, confidence}
// ---------------------------------------------------------------------------
translationsRouter.post(
  '/translations/detect-language',
  [body('lyrics').isString().notEmpty().withMessage('lyrics is required')],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { lyrics } = req.body as { lyrics: string };

      const provider = getActiveProvider();
      const result = await provider.detectLanguage(lyrics);

      const confidence: 'high' | 'medium' | 'low' =
        result.confidence >= 0.7 ? 'high' : result.confidence >= 0.4 ? 'medium' : 'low';

      // Log AI call — every API call is recorded
      await logAICall({
        provider: provider.name,
        model: result.model,
        promptVersion: 'lang-detect-v1',
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
        estimatedCostUsd: estimateCostUsd(result.tokensInput, result.tokensOutput),
        songId: null,
        userId: null,
      });

      return res.status(200).json({
        languageCode: result.languageCode,
        languageName: result.languageCode,
        confidence,
      });
    } catch (err) {
      return next(err);
    }
  },
);
