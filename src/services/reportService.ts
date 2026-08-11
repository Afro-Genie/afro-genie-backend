import { Prisma, ReportStatus, ReportTargetType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { ApiError } from '../middleware/errorHandler';
import { REWARD_CONFIG } from '../config/rewards';
import { awardTokens } from './tokenService';
import { contributeTax } from './modPoolService';
import { evaluateGuardianBadge } from './badgeService';

// ---------------------------------------------------------------------------
// Content reports (Phase 2 governance).
//
// Users can flag translations, topics, comments, users, artists and songs.
// Moderators then resolve (action taken) or dismiss (no action needed) the
// report. Every resolved report feeds the moderator leaderboard.
// ---------------------------------------------------------------------------

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

const TARGET_EXISTS_CHECK: Record<
  ReportTargetType,
  (id: string) => Promise<boolean>
> = {
  TRANSLATION: (id) => prisma.translation.count({ where: { id } }).then((c) => c > 0),
  TOPIC: (id) => prisma.topic.count({ where: { id } }).then((c) => c > 0),
  COMMENT: (id) => prisma.topicComment.count({ where: { id } }).then((c) => c > 0),
  USER: (id) => prisma.user.count({ where: { id } }).then((c) => c > 0),
  ARTIST: (id) => prisma.artist.count({ where: { id } }).then((c) => c > 0),
  SONG: (id) => prisma.song.count({ where: { id } }).then((c) => c > 0),
};

export async function createReport(params: {
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  description?: string;
  reporterId: string;
}) {
  const { targetType, targetId, reason, description, reporterId } = params;

  if (!TARGET_EXISTS_CHECK[targetType]) {
    throw new ApiError('Invalid report target type', 'VALIDATION_ERROR', 400);
  }

  const exists = await TARGET_EXISTS_CHECK[targetType](targetId);
  if (!exists) {
    throw new ApiError('Reported target does not exist', 'NOT_FOUND', 404);
  }

  const report = await prisma.contentReport.create({
    data: {
      targetType,
      targetId,
      reason: reason.trim(),
      description: description?.trim() || null,
      reporterId,
    },
  });

  return {
    id: report.id,
    status: report.status,
    createdAt: report.createdAt,
  };
}

export async function listReports(params: ListParams = {}) {
  const { page, limit } = clampListParams(params);
  const where: Prisma.ContentReportWhereInput = params.status
    ? { status: params.status as ReportStatus }
    : {};

  const [rows, total] = await Promise.all([
    prisma.contentReport.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        reporter: { select: { id: true, displayName: true, email: true } },
        moderator: { select: { id: true, displayName: true } },
      },
    }),
    prisma.contentReport.count({ where }),
  ]);

  return {
    data: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

const setReportStatus = async (id: string, moderatorId: string, status: ReportStatus) => {
  const existing = await prisma.contentReport.findUnique({ where: { id } });
  if (!existing) {
    throw new ApiError('Report not found', 'NOT_FOUND', 404);
  }

  if (existing.status !== 'PENDING') {
    return { id: existing.id, status: existing.status, applied: false };
  }

  const updated = await prisma.contentReport.update({
    where: { id },
    data: {
      status,
      moderatorId,
      resolvedAt: new Date(),
    },
  });

  return { id: updated.id, status: updated.status, applied: true };
};

export async function resolveReport(id: string, moderatorId: string) {
  const result = await setReportStatus(id, moderatorId, 'RESOLVED');

  if (result.applied) {
    try {
      await awardTokens({
        userId: moderatorId,
        type: 'EARN',
        amount: REWARD_CONFIG.REPORT_RESOLVED_AMOUNT,
        reason: 'Report resolved',
        sourceType: 'REPORT_RESOLVED',
        sourceId: id,
        idempotencyKey: `report:${id}`,
      });

      await contributeTax({
        userId: moderatorId,
        rewardAmount: REWARD_CONFIG.REPORT_RESOLVED_AMOUNT,
        sourceId: id,
      });

      // Phase 4: GUARDIAN badge at the resolved-reports threshold.
      await evaluateGuardianBadge(moderatorId);
    } catch (err) {
      logger.error({ err, reportId: id }, 'report resolve reward failed');
    }
  }

  return { id: result.id, status: result.status };
}

export function dismissReport(id: string, moderatorId: string) {
  return setReportStatus(id, moderatorId, 'DISMISSED');
}

export async function getReportStats() {
  const [pending, resolved, dismissed, topModerators] = await Promise.all([
    prisma.contentReport.count({ where: { status: 'PENDING' } }),
    prisma.contentReport.count({ where: { status: 'RESOLVED' } }),
    prisma.contentReport.count({ where: { status: 'DISMISSED' } }),
    prisma.contentReport.groupBy({
      by: ['moderatorId'],
      where: { status: 'RESOLVED', moderatorId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { moderatorId: 'desc' } },
      take: 5,
    }),
  ]);

  const moderatorIds = topModerators
    .map((row) => row.moderatorId)
    .filter((id): id is string => id !== null);

  const users = moderatorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: moderatorIds } },
        select: { id: true, displayName: true },
      })
    : [];

  const displayNameById = new Map(users.map((u) => [u.id, u.displayName]));

  return {
    pending,
    resolved,
    dismissed,
    total: pending + resolved + dismissed,
    topModerators: topModerators.map((row) => ({
      moderatorId: row.moderatorId as string,
      displayName: displayNameById.get(row.moderatorId as string) ?? 'Unknown',
      resolvedCount: row._count._all,
    })),
  };
}
