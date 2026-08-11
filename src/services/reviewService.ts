import type { CorrectionStatus, Prisma, TranslationStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ApiError } from '../middleware/errorHandler';
import {
  onCorrectionApproved,
  onCorrectionRejected,
  onTranslationApproved,
  onTranslationRejected,
} from './rewardHooks';

// ---------------------------------------------------------------------------
// Review & corrections service (Phase 0).
//
// Moderators approve/reject translations and corrections; any authenticated
// user can submit a correction request against a translation. Reward hooks are
// stubbed (Phase 1 wires token awards + tier recomputation).
//
// Idempotency: approval/rejection/review operations are guarded on the current
// status so replayed requests return the already-applied state instead of
// double-applying or erroring.
// ---------------------------------------------------------------------------

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface ListParams {
  status?: string;
  page?: number;
  limit?: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const clampListParams = (params: ListParams) => {
  const page = Math.max(DEFAULT_PAGE, params.page ?? DEFAULT_PAGE);
  const limit = Math.min(MAX_LIMIT, Math.max(1, params.limit ?? DEFAULT_LIMIT));
  return { page, limit };
};

const buildPagination = <T>(rows: T[], total: number, page: number, limit: number): PaginatedResult<T> => ({
  data: rows,
  pagination: {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  },
});

// ---------------------------------------------------------------------------
// Translations moderation queue
// ---------------------------------------------------------------------------
export async function listTranslations(params: ListParams = {}): Promise<PaginatedResult<unknown>> {
  const { page, limit } = clampListParams(params);
  const where: Prisma.TranslationWhereInput = params.status
    ? { status: params.status as TranslationStatus }
    : {};

  const [rows, total] = await Promise.all([
    prisma.translation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: { select: { id: true, displayName: true, email: true } },
        song: { select: { id: true, title: true, artist: { select: { name: true } } } },
      },
    }),
    prisma.translation.count({ where }),
  ]);

  return buildPagination(rows, total, page, limit);
}

export async function approveTranslation(
  translationId: string,
  reviewerId: string,
): Promise<{ id: string; status: string }> {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.translation.findUnique({
      where: { id: translationId },
      select: { id: true, status: true, userId: true },
    });

    if (!existing) {
      throw new ApiError('Translation not found', 'NOT_FOUND', 404);
    }

    if (existing.status === 'APPROVED') {
      return { id: existing.id, status: existing.status, applied: false };
    }

    await tx.translation.update({
      where: { id: translationId },
      data: {
        status: 'APPROVED',
        approvedById: reviewerId,
        approvedAt: new Date(),
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        rejectionReason: null,
      },
    });

    return { id: existing.id, status: 'APPROVED', applied: true, userId: existing.userId };
  });

  if (result.applied) {
    await onTranslationApproved({
      translationId,
      userId: (result as { userId: string }).userId,
      reviewerId,
    });
  }

  return { id: result.id, status: result.status };
}

export async function rejectTranslation(
  translationId: string,
  reviewerId: string,
  reason?: string,
): Promise<{ id: string; status: string }> {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.translation.findUnique({
      where: { id: translationId },
      select: { id: true, status: true, userId: true },
    });

    if (!existing) {
      throw new ApiError('Translation not found', 'NOT_FOUND', 404);
    }

    if (existing.status === 'REJECTED') {
      return { id: existing.id, status: existing.status, applied: false };
    }

    await tx.translation.update({
      where: { id: translationId },
      data: {
        status: 'REJECTED',
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        rejectionReason: reason ?? null,
      },
    });

    return { id: existing.id, status: 'REJECTED', applied: true, userId: existing.userId };
  });

  if (result.applied) {
    await onTranslationRejected({
      translationId,
      userId: (result as { userId: string }).userId,
      reviewerId,
      reason,
    });
  }

  return { id: result.id, status: result.status };
}

// ---------------------------------------------------------------------------
// Corrections moderation queue
// ---------------------------------------------------------------------------
export async function listCorrections(params: ListParams = {}): Promise<PaginatedResult<unknown>> {
  const { page, limit } = clampListParams(params);
  const where: Prisma.TranslationCorrectionWhereInput = params.status
    ? { status: params.status as CorrectionStatus }
    : {};

  const [rows, total] = await Promise.all([
    prisma.translationCorrection.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: { select: { id: true, displayName: true, email: true } },
        translation: {
          select: {
            id: true,
            originalLyrics: true,
            translatedLyrics: true,
            sourceLang: true,
            targetLang: true,
            song: { select: { id: true, title: true } },
          },
        },
      },
    }),
    prisma.translationCorrection.count({ where }),
  ]);

  return buildPagination(rows, total, page, limit);
}

const applyCorrectionMarker = (suggestedText: string): string => {
  const trimmed = suggestedText.trim();
  const marker = '[Corrected]';
  if (trimmed.endsWith(marker)) return trimmed;
  return `${trimmed}\n\n${marker}`;
};

export async function reviewCorrection(
  correctionId: string,
  status: CorrectionStatus,
  reviewerId: string,
): Promise<{ id: string; status: string }> {
  const result = await prisma.$transaction(async (tx) => {
    const correction = await tx.translationCorrection.findUnique({
      where: { id: correctionId },
      include: {
        translation: { select: { id: true, translatedLyrics: true, status: true, userId: true } },
      },
    });

    if (!correction) {
      throw new ApiError('Correction not found', 'NOT_FOUND', 404);
    }

    if (correction.status === status) {
      return { id: correction.id, status: correction.status, applied: false, event: null };
    }

    const now = new Date();

    if (status === 'APPROVED') {
      const appliedText = applyCorrectionMarker(correction.suggestedText);

      // Apply the correction back onto the translation and send it through
      // review again so the change is not silently published.
      await tx.translation.update({
        where: { id: correction.translationId },
        data: {
          translatedLyrics: appliedText,
          status: 'PENDING',
          approvedById: null,
          approvedAt: null,
          rejectionReason: null,
        },
      });

      await tx.translationCorrection.update({
        where: { id: correctionId },
        data: { status: 'APPROVED', reviewedById: reviewerId, reviewedAt: now },
      });

      return {
        id: correction.id,
        status: 'APPROVED',
        applied: true,
        event: {
          correctionId: correction.id,
          translationId: correction.translationId,
          userId: correction.userId,
          reviewerId,
        },
      };
    }

    await tx.translationCorrection.update({
      where: { id: correctionId },
      data: { status: 'REJECTED', reviewedById: reviewerId, reviewedAt: now },
    });

    return {
      id: correction.id,
      status: 'REJECTED',
      applied: true,
      event: {
        correctionId: correction.id,
        translationId: correction.translationId,
        userId: correction.userId,
        reviewerId,
      },
    };
  });

  if (result.applied && result.event) {
    if (status === 'APPROVED') {
      await onCorrectionApproved(result.event);
    } else {
      await onCorrectionRejected(result.event);
    }
  }

  return { id: result.id, status: result.status };
}

// ---------------------------------------------------------------------------
// Correction submission + history
// ---------------------------------------------------------------------------
const MIN_CORRECTION_LENGTH = 10;

const normalizeForComparison = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();

export async function submitCorrection(params: {
  translationId: string;
  userId: string;
  originalText?: string;
  suggestedText: string;
  reason?: string;
}): Promise<unknown> {
  const { translationId, userId, suggestedText, reason } = params;

  if (suggestedText.trim().length < MIN_CORRECTION_LENGTH) {
    throw new ApiError(
      `Correction must be at least ${MIN_CORRECTION_LENGTH} characters long`,
      'VALIDATION_ERROR',
      400,
    );
  }

  const translation = await prisma.translation.findUnique({
    where: { id: translationId },
    include: {
      user: { select: { id: true, displayName: true, email: true } },
      song: { select: { id: true, title: true } },
    },
  });

  if (!translation) {
    throw new ApiError('Translation not found', 'NOT_FOUND', 404);
  }

  const originalText = params.originalText ?? translation.translatedLyrics;

  if (normalizeForComparison(suggestedText) === normalizeForComparison(originalText)) {
    throw new ApiError(
      'Correction must be materially different from the current translation',
      'VALIDATION_ERROR',
      400,
    );
  }

  const correction = await prisma.translationCorrection.create({
    data: {
      translationId,
      userId,
      originalText,
      suggestedText: suggestedText.trim(),
      reason: reason ?? null,
      status: 'PENDING',
    },
  });

  // Shape that satisfies the frontend CorrectionRequestItem contract so the
  // moderator UI and correction-history endpoints can render it consistently.
  return {
    id: correction.id,
    title: reason ?? '',
    description: suggestedText.trim(),
    status: correction.status,
    createdAt: correction.createdAt,
    resolvedAt: null,
    moderatorNote: null,
    user: translation.user,
    resolvedBy: null,
    song: translation.song,
    translation: {
      id: translation.id,
      sourceLang: translation.sourceLang,
      targetLang: translation.targetLang,
    },
  };
}

export async function getCorrectionHistory(
  translationId: string,
): Promise<{
  correctedBy: { id: string; displayName: string | null };
  correctedAt: Date;
  requestedBy: { id: string; displayName: string | null } | null;
  title: string | null;
} | null> {
  const latest = await prisma.translationCorrection.findFirst({
    where: { translationId, status: 'APPROVED', reviewedById: { not: null } },
    orderBy: { reviewedAt: 'desc' },
    include: {
      reviewedBy: { select: { id: true, displayName: true } },
      user: { select: { id: true, displayName: true } },
    },
  });

  if (!latest || !latest.reviewedBy || !latest.reviewedAt) {
    return null;
  }

  return {
    correctedBy: latest.reviewedBy,
    correctedAt: latest.reviewedAt,
    requestedBy: latest.user,
    title: latest.reason,
  };
}

// ---------------------------------------------------------------------------
// Lyrics content replacement (for correction resolution)
// ---------------------------------------------------------------------------
export async function updateLyrics(
  songId: string,
  content: string,
): Promise<{ id: string; content: string }> {
  const song = await prisma.song.findUnique({ where: { id: songId }, select: { id: true } });
  if (!song) {
    throw new ApiError('Song not found', 'NOT_FOUND', 404);
  }

  const existing = await prisma.lyric.findFirst({
    where: { songId },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) {
    const updated = await prisma.lyric.update({
      where: { id: existing.id },
      data: { content },
    });
    return { id: updated.id, content: updated.content ?? '' };
  }

  const created = await prisma.lyric.create({
    data: {
      songId,
      content,
      sourceProvider: 'MANUAL',
      licenseStatus: 'UNKNOWN',
    },
  });

  return { id: created.id, content: created.content ?? '' };
}
