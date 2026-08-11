import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { CorrectionStatus, TranslationStatus } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { ApiError } from '../middleware/errorHandler';
import {
  approveTranslation,
  getCorrectionHistory,
  listCorrections,
  listTranslations,
  rejectTranslation,
  reviewCorrection,
  submitCorrection,
  updateLyrics,
} from '../services/reviewService';
import type { AuthUser } from '../types/auth';

export const translationModerationRouter = Router();

const MODERATOR_ROLES = ['MODERATOR', 'ADMIN'] as const;

const correctionSubmitLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many correction submissions, please try again later.',
    code: 'RATE_LIMITED',
  },
});

// ---------------------------------------------------------------------------
// POST /api/translations/:id/correction-request
// Authenticated. Writes a TranslationCorrection (PENDING) for moderator review.
// Accepts the frontend `{ title, description }` contract or the raw
// `{ originalText, suggestedText, reason }` correction shape.
// ---------------------------------------------------------------------------
translationModerationRouter.post(
  '/translations/:id/correction-request',
  authenticate,
  correctionSubmitLimiter,
  [
    param('id').isString().notEmpty().withMessage('Translation id is required'),
    body('title').optional().isString(),
    body('description').optional().isString(),
    body('originalText').optional().isString(),
    body('suggestedText').optional().isString(),
    body('reason').optional().isString(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const suggestedText = (req.body.suggestedText ?? req.body.description) as string | undefined;
      const reason = (req.body.reason ?? req.body.title) as string | undefined;

      if (!suggestedText?.trim()) {
        return next(
          new ApiError('A correction suggestion (description or suggestedText) is required', 'VALIDATION_ERROR', 400),
        );
      }

      const result = await submitCorrection({
        translationId: req.params.id,
        userId: user.id,
        originalText: req.body.originalText,
        suggestedText,
        reason,
      });

      return res.status(201).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/translations/:id/correction
// Authenticated. Alias used by the legacy client (`translationsApi.submitCorrection`)
// for direct correction suggestions; same storage as correction-request.
// ---------------------------------------------------------------------------
translationModerationRouter.post(
  '/translations/:id/correction',
  authenticate,
  [
    param('id').isString().notEmpty().withMessage('Translation id is required'),
    body('originalText').optional().isString(),
    body('suggestedText').isString().notEmpty().withMessage('suggestedText is required'),
    body('reason').optional().isString(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const result = await submitCorrection({
        translationId: req.params.id,
        userId: user.id,
        originalText: req.body.originalText,
        suggestedText: req.body.suggestedText,
        reason: req.body.reason,
      });

      return res.status(201).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/translations/:id/correction-history
// Public. Most recent applied correction for a translation (or null).
// ---------------------------------------------------------------------------
translationModerationRouter.get(
  '/translations/:id/correction-history',
  [param('id').isString().notEmpty().withMessage('Translation id is required'), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const history = await getCorrectionHistory(req.params.id);
      return res.status(200).json(history);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/moderation/translations?status=&page=&limit=
// Moderator queue for translation review.
// ---------------------------------------------------------------------------
translationModerationRouter.get(
  '/admin/moderation/translations',
  authenticate,
  requireRole(...MODERATOR_ROLES),
  [
    query('status').optional().isIn(Object.values(TranslationStatus)).withMessage('Invalid status'),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await listTranslations(req.query as any);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /api/admin/moderation/translations/:id/approve
// Sets APPROVED + records approvedById/approvedAt (idempotent).
// ---------------------------------------------------------------------------
translationModerationRouter.patch(
  '/admin/moderation/translations/:id/approve',
  authenticate,
  requireRole(...MODERATOR_ROLES),
  [param('id').isString().notEmpty().withMessage('Translation id is required'), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const result = await approveTranslation(req.params.id, user.id);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/translations/:id/reject
// Sets REJECTED with an optional reason (idempotent).
// ---------------------------------------------------------------------------
translationModerationRouter.post(
  '/admin/translations/:id/reject',
  authenticate,
  requireRole(...MODERATOR_ROLES),
  [
    param('id').isString().notEmpty().withMessage('Translation id is required'),
    body('reason').optional().isString(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const result = await rejectTranslation(req.params.id, user.id, req.body.reason);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/moderation/corrections?status=&page=&limit=
// Moderator queue for correction review.
// ---------------------------------------------------------------------------
translationModerationRouter.get(
  '/admin/moderation/corrections',
  authenticate,
  requireRole(...MODERATOR_ROLES),
  [
    query('status').optional().isIn(Object.values(CorrectionStatus)).withMessage('Invalid status'),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await listCorrections(req.query as any);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /api/admin/translations/corrections/:id
// Body { status: 'APPROVED' | 'REJECTED' }. On approve, applies the suggestion
// back onto the translation and fires the correction-approved hook.
// ---------------------------------------------------------------------------
translationModerationRouter.patch(
  '/admin/translations/corrections/:id',
  authenticate,
  requireRole(...MODERATOR_ROLES),
  [
    param('id').isString().notEmpty().withMessage('Correction id is required'),
    body('status').isIn(Object.values(CorrectionStatus)).withMessage('status must be APPROVED or REJECTED'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const result = await reviewCorrection(req.params.id, req.body.status as CorrectionStatus, user.id);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /api/admin/lyrics/:songId
// Replaces the latest lyrics content for a song (correction resolution).
// ---------------------------------------------------------------------------
translationModerationRouter.patch(
  '/admin/lyrics/:songId',
  authenticate,
  requireRole(...MODERATOR_ROLES),
  [
    param('songId').isString().notEmpty().withMessage('Song id is required'),
    body('content').isString().notEmpty().withMessage('content is required'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await updateLyrics(req.params.songId, req.body.content);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);
