import { Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import type { NextFunction, Request, Response } from 'express';
import { TranslationStatus, VoteType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import { translationQueue } from '../lib/queue';
import { estimateCostUsd, CURRENT_PROMPT_VERSION } from '../services/providers/geminiProvider';
import { logger } from '../lib/logger';
import {
  checkDailyBudget,
  checkUserRateLimit,
  getActiveProvider,
  getTranslationsBySong,
  logAICall,
  requestTranslation,
} from '../services/translationService';

// ---------------------------------------------------------------------------
// Canonical language code → human-readable name mapping
// ---------------------------------------------------------------------------
const LANGUAGE_NAME_MAP: Record<string, string> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  sw: 'Swahili',
  yo: 'Yoruba',
  ig: 'Igbo',
  ha: 'Hausa',
  pcm: 'Nigerian Pidgin',
  pidgin: 'Nigerian Pidgin',
  ar: 'Arabic',
  zu: 'Zulu',
  am: 'Amharic',
  mixed: 'Mixed Languages',
};

function resolveLanguageName(code: string): string {
  const normalized = code?.toLowerCase()?.trim();
  return LANGUAGE_NAME_MAP[normalized] || normalized || 'Unknown';
}

// ---------------------------------------------------------------------------
// Heuristic language detection — offline fallback when AI provider is unreachable
// ---------------------------------------------------------------------------
const HEURISTIC_PATTERNS: Array<{ code: string; patterns: RegExp[]; weight: number }> = [
  {
    code: 'yo',
    weight: 3,
    patterns: [
      /\b(omo|omo|ojo|owo|ile|aaye|orun|igbo|oriki|abiku|ijapa|ese|ife|ori)\b/i,
      /\b(omi|omi|ogun|osa|shango|yemoja|obatala|sango|oshun|oya)\b/i,
    ],
  },
  {
    code: 'pcm',
    weight: 3,
    patterns: [
      /\bwetin\b/i, /\bwahala\b/i, /\bnaija\b/i, /\boya\b/i, /\bno\s+dey\b/i,
      /\bI\s+no\s+be\b/i, /\bmy\s+guy\b/i, /\be\s+don\b/i, /\bdey\b/i,
      /\bwey\b/i, /\babeg\b/i, /\bjapa\b/i, /\bobodo\b/i, /\bsabi\b/i,
      /\bI\s+dey\b/i, /\bno\s+wahala\b/i, /\bfit\b/i, /\bsha\b/i,
    ],
  },
  {
    code: 'ig',
    weight: 3,
    patterns: [
      /\b(ala|nna|nne|ada|ndi|di|be|ka|na|si|ye|ga|chi|oha)\b/i,
      /\b(ife|ife|ogini|ola|eze|ugo|nka|mmiri|ani|ala)\b/i,
    ],
  },
  {
    code: 'ha',
    weight: 3,
    patterns: [
      /\b(kai|yauwa|gaisuwa|sannu|lahan|daga|kuma|wani|wata|har|in)\b/i,
      /\b(duba|ruwa|aska|faskara|mai|gida|uya|karanta|rubuta)\b/i,
    ],
  },
  {
    code: 'fr',
    weight: 2,
    patterns: [
      /\b(le|la|les|de|du|des|un|une|et|est|je|tu|nous|vous|ils|elles)\b/i,
      /\b(c'est|qu'est|mon|ton|son|mais|pour|avec|dans|sur|pas|très)\b/i,
    ],
  },
  {
    code: 'sw',
    weight: 2,
    patterns: [
      /\b(na|ni|ya|wa|kwa|ku|wa|za|la|ma)\b/i,
      /\b(sawa|pole|asante|habari|jambo|ndio|hapana|nzuri|mbaya)\b/i,
    ],
  },
];

function heuristicDetectLanguage(lyrics: string): {
  languageCode: string;
  confidence: 'high' | 'medium' | 'low';
} {
  const text = lyrics.toLowerCase();
  const scores: Record<string, number> = {};

  for (const { code, patterns, weight } of HEURISTIC_PATTERNS) {
    let hits = 0;
    for (const pat of patterns) {
      const matches = text.match(new RegExp(pat.source, 'gi'));
      if (matches) hits += matches.length;
    }
    scores[code] = (scores[code] || 0) + hits * weight;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const totalHits = sorted.reduce((sum, [, v]) => sum + v, 0);

  if (sorted.length === 0 || sorted[0][1] === 0) {
    return { languageCode: 'en', confidence: 'low' };
  }

  const [topCode, topScore] = sorted[0];
  const ratio = totalHits > 0 ? topScore / totalHits : 1;
  const confidence = ratio > 0.7 ? 'high' : ratio > 0.4 ? 'medium' : 'low';

  // Check for heavy code-switching
  const significantCodes = sorted.filter(([, v]) => v > 0 && v >= topScore * 0.3);
  if (significantCodes.length >= 2) {
    return { languageCode: 'mixed', confidence: 'low' };
  }

  return { languageCode: topCode, confidence };
}

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
// Authenticated. Returns existing approved translation, enqueues a new job,
// or processes inline if workers appear unavailable.
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

      // Check for any existing translation (not just APPROVED — also reuse PENDING)
      const existingApproved = await prisma.translation.findFirst({
        where: { songId, sourceLang, targetLang, status: 'APPROVED' },
      });
      if (existingApproved) {
        return res.status(200).json({ status: 'existing', translation: existingApproved });
      }

      // Check for a recent PENDING translation (user already requested, still processing)
      const recentPending = await prisma.translation.findFirst({
        where: { songId, sourceLang, targetLang, status: 'PENDING' },
        orderBy: { updatedAt: 'desc' },
      });
      if (recentPending) {
        // If it has translatedLyrics, it's done — just needs approval
        if (recentPending.translatedLyrics) {
          const approved = await prisma.translation.update({
            where: { id: recentPending.id },
            data: { status: 'APPROVED' },
          });
          return res.status(200).json({ status: 'existing', translation: approved });
        }
        // Still processing — return the pending ID so frontend can poll
        return res.status(202).json({
          status: 'queued',
          jobId: `pending:${recentPending.id}`,
          rateLimit: { remaining: rateLimit.remaining, resetAt: rateLimit.resetAt },
        });
      }

      // INLINE PROCESSING: Queue is unreliable (Redis ENOTFOUND), always process directly
      logger.info({ songId, userId, targetLang }, 'Processing translation inline');

      try {
        const { processTranslationJob } = await import('../jobs/translationJob.js');
        const song = await prisma.song.findUnique({
          where: { id: songId },
          include: {
            artist: { select: { name: true } },
            lyrics: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
        });

        if (!song || !song.lyrics[0]?.content) {
          return next(new ApiError('Song not found or has no lyrics', 'NOT_FOUND', 404));
        }

        const inlineJob = {
          id: `inline-${Date.now()}`,
          data: { songId, userId, sourceLang, targetLang, promptVersion: CURRENT_PROMPT_VERSION },
          attemptsMade: 0,
          updateProgress: async () => {},
        };

        await processTranslationJob(inlineJob as any);

        // Fetch the saved translation
        const translation = await prisma.translation.findFirst({
          where: { songId, userId, sourceLang, targetLang },
          orderBy: { updatedAt: 'desc' },
        });

        if (translation) {
          // Auto-approve inline translations
          const approved = await prisma.translation.update({
            where: { id: translation.id },
            data: { status: 'APPROVED' },
          });
          return res.status(200).json({ status: 'completed', translation: approved });
        }
      } catch (inlineErr: any) {
        logger.error({ err: inlineErr, songId }, 'Inline translation failed');
        return next(
          new ApiError(
            `Translation failed: ${inlineErr.message || 'Unknown error'}. Please try again.`,
            'TRANSLATION_FAILED',
            500,
          ),
        );
      }

      // Should not reach here, but just in case
      return next(new ApiError('Translation completed but no result found', 'TRANSLATION_FAILED', 500));
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
        ...(job.timestamp && { queuedAt: new Date(job.timestamp) }),
        attemptsMade: job.attemptsMade,
      });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/translations/health
// Public. Checks if Gemini API is reachable and workers are responsive.
// MUST be before /translations/:songId to avoid "health" being matched as songId.
// ---------------------------------------------------------------------------
translationsRouter.get(
  '/translations/health',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const startTime = Date.now();
      const results: Record<string, any> = {};

      // 1. Test Gemini API connectivity
      try {
        const provider = getActiveProvider();
        const testResult = await provider.detectLanguage('Hello world');
        results.gemini = {
          status: 'ok',
          model: testResult.model,
          latencyMs: Date.now() - startTime,
          tokensUsed: testResult.tokensInput + testResult.tokensOutput,
        };
      } catch (err: any) {
        results.gemini = {
          status: 'error',
          error: err.message?.substring(0, 200),
          latencyMs: Date.now() - startTime,
        };
      }

      // 2. Check queue health
      try {
        const counts = await translationQueue.getJobCounts(
          'waiting', 'active', 'completed', 'failed',
        );
        results.queue = {
          status: 'ok',
          waiting: counts.waiting,
          active: counts.active,
          completed: counts.completed,
          failed: counts.failed,
        };
      } catch (err: any) {
        results.queue = {
          status: 'error',
          error: err.message?.substring(0, 200),
        };
      }

      // 3. Check recent translations
      try {
        const recentCount = await prisma.translation.count({
          where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        });
        const pendingCount = await prisma.translation.count({
          where: { status: 'PENDING' },
        });
        results.translations = {
          status: 'ok',
          last24h: recentCount,
          pending: pendingCount,
        };
      } catch (err: any) {
        results.translations = { status: 'error', error: err.message?.substring(0, 200) };
      }

      const allHealthy = Object.values(results).every((r: any) => r.status === 'ok');

      return res.status(allHealthy ? 200 : 207).json({
        healthy: allHealthy,
        results,
        totalLatencyMs: Date.now() - startTime,
      });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/translations/test
// Authenticated. Quick test: translates a short sample and returns result.
// MUST be before /translations/:songId to avoid "test" being matched as songId.
// ---------------------------------------------------------------------------
translationsRouter.post(
  '/translations/test',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    try {
      const provider = getActiveProvider();

      // Quick language detection test
      const detectResult = await provider.detectLanguage(
        'Wahala no dey finish my guy e don tire',
      );

      const detectLatency = Date.now() - startTime;

      // Quick translation test (short text)
      const translateStart = Date.now();
      // Direct provider call for quick test
      const translateResult = await provider.translate({
        artist: 'Test',
        title: 'SDK Test',
        lyrics: 'Wahala no dey finish\nMy guy e don tire\nE say e wan japa',
        sourceLang: 'pcm',
        targetLang: 'en',
        promptVersion: CURRENT_PROMPT_VERSION,
      });

      const translateLatency = Date.now() - translateStart;

      return res.status(200).json({
        success: true,
        latencyMs: Date.now() - startTime,
        detection: {
          language: detectResult.languageCode,
          confidence: detectResult.confidence,
          latencyMs: detectLatency,
          model: detectResult.model,
        },
        translation: {
          text: translateResult.translatedLyrics,
          culturalContext: translateResult.culturalContext,
          latencyMs: translateLatency,
          tokensUsed: translateResult.tokensUsed,
          model: translateResult.model,
        },
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message?.substring(0, 300),
        provider: getActiveProvider().name,
        hint: err.message?.includes('quota')
          ? 'Gemini quota/billing issue. Check credits at aistudio.google.com'
          : err.message?.includes('404')
            ? 'Gemini model not found. Check API key at aistudio.google.com/apikey'
            : err.message?.includes('503')
              ? 'Gemini temporarily unavailable. Try again in a moment.'
              : undefined,
        latencyMs: Date.now() - startTime,
      });
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

      // Try AI detection first
      try {
        const provider = getActiveProvider();
        const result = await provider.detectLanguage(lyrics);

        const confidence: 'high' | 'medium' | 'low' =
          result.confidence >= 0.7 ? 'high' : result.confidence >= 0.4 ? 'medium' : 'low';

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
          languageName: resolveLanguageName(result.languageCode),
          confidence,
        });
      } catch (aiError: any) {
        // AI failed — fall back to heuristic detection
        const heuristic = heuristicDetectLanguage(lyrics);
        return res.status(200).json({
          languageCode: heuristic.languageCode,
          languageName: resolveLanguageName(heuristic.languageCode),
          confidence: heuristic.confidence,
          fallback: true,
        });
      }
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/translations/direct
// Authenticated. Creates or upserts a translation record directly without
// queuing an AI job. Used for admin manual uploads, artist lyrics, and API
// imports where the translated text is already available.
// ---------------------------------------------------------------------------
translationsRouter.post(
  '/translations/direct',
  authenticate,
  [
    body('songId').isString().notEmpty().withMessage('songId is required'),
    body('originalLyrics').isString().notEmpty().withMessage('originalLyrics is required'),
    body('translatedLyrics').isString().notEmpty().withMessage('translatedLyrics is required'),
    body('sourceLang').isString().notEmpty().withMessage('sourceLang is required'),
    body('targetLang').isString().notEmpty().withMessage('targetLang is required'),
    body('culturalContext').optional({ nullable: true }).isString(),
    body('status').optional({ nullable: true }).isIn(['PENDING', 'APPROVED', 'REJECTED', 'PUBLISHED']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const {
        songId,
        originalLyrics,
        translatedLyrics,
        sourceLang,
        targetLang,
        culturalContext,
        status,
      } = req.body as {
        songId: string;
        originalLyrics: string;
        translatedLyrics: string;
        sourceLang: string;
        targetLang: string;
        culturalContext?: string;
        status?: string;
      };

      // Verify song exists
      const song = await prisma.song.findUnique({ where: { id: songId }, select: { id: true } });
      if (!song) {
        return next(new ApiError('Song not found', 'NOT_FOUND', 404));
      }

      // Upsert: match on the unique constraint [songId, userId, sourceLang, targetLang]
      const translationStatus = (status as TranslationStatus) || TranslationStatus.APPROVED;

      const translation = await prisma.translation.upsert({
        where: {
          songId_userId_sourceLang_targetLang: {
            songId,
            userId,
            sourceLang,
            targetLang,
          },
        },
        update: {
          originalLyrics,
          translatedLyrics,
          culturalContext: culturalContext || null,
          status: translationStatus,
        },
        create: {
          songId,
          userId,
          originalLyrics,
          translatedLyrics,
          culturalContext: culturalContext || null,
          sourceLang,
          targetLang,
          status: translationStatus,
        },
      });

      return res.status(201).json({ translation });
    } catch (err) {
      return next(err);
    }
  },
);
