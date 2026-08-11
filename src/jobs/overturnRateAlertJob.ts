import type { RepeatOptions } from 'bullmq';
import { overturnRateAlertQueue } from '../lib/queue';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { ModerationAction } from '@prisma/client';

// Auto-flag: a moderator whose approvals are overturned more than this many
// times in the window is flagged for review (plan §13 risk table).
export const OVERTURN_ALERT_THRESHOLD = 2;
export const OVERTURN_ALERT_WINDOW_DAYS = 30;

export interface OverturnAlertResult {
  periodDays: number;
  flagged: Array<{ moderatorId: string; overturns: number }>;
}

/**
 * Per-approver overturn-rate alert (Phase 4 / R2.4 observability).
 *
 * Attributes APPROVAL_OVERTURNED logs to the moderator whose approval was
 * overturned (recorded in `metadata.previouslyApprovedById`) and flags anyone
 * over the threshold with a logger warning.
 */
export const runOverturnRateAlert = async (
  days = OVERTURN_ALERT_WINDOW_DAYS,
): Promise<OverturnAlertResult> => {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const logs = await prisma.moderationLog.findMany({
    where: {
      action: ModerationAction.APPROVAL_OVERTURNED,
      createdAt: { gte: since },
    },
    select: { metadata: true },
  });

  const counts = new Map<string, number>();
  for (const log of logs) {
    const approver = (log.metadata as { previouslyApprovedById?: string } | null)
      ?.previouslyApprovedById;
    if (approver) counts.set(approver, (counts.get(approver) ?? 0) + 1);
  }

  const flagged = [...counts.entries()]
    .filter(([, count]) => count > OVERTURN_ALERT_THRESHOLD)
    .map(([moderatorId, overturns]) => ({ moderatorId, overturns }));

  for (const f of flagged) {
    logger.warn(
      { moderatorId: f.moderatorId, overturns: f.overturns, days },
      'Approval overturn-rate auto-flag — moderator exceeded the overturn threshold',
    );
  }

  return { periodDays: days, flagged };
};

const OVERTURN_ALERT_JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: 50,
  repeat: {
    // Daily from process start. Read-only and idempotent.
    every: 24 * 60 * 60 * 1000,
  } satisfies RepeatOptions,
};

export const scheduleOverturnRateAlert = async () => {
  await overturnRateAlertQueue.add(
    'overturnRateAlert',
    {},
    { ...OVERTURN_ALERT_JOB_OPTIONS, jobId: 'overturn-rate-alert' },
  );
};

export const processOverturnRateAlertJob = async (): Promise<void> => {
  await runOverturnRateAlert();
};
