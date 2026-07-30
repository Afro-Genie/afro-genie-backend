import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export interface ModActionInput {
  moderatorId: string;
  actionType: string;
  targetId: string;
  targetType: string;
  details?: string;
}

export async function logModAction(input: ModActionInput): Promise<void> {
  try {
    await prisma.modActionLog.create({
      data: {
        moderatorId: input.moderatorId,
        actionType: input.actionType,
        targetId: input.targetId,
        targetType: input.targetType,
        details: input.details ?? null,
      },
    });
  } catch (error) {
    logger.warn({ err: error, input }, 'Failed to log moderation action');
  }
}

export async function getModActionLogs(
  moderatorId: string,
  page = 1,
  limit = 20,
) {
  const skip = (page - 1) * limit;

  const [logs, total] = await Promise.all([
    prisma.modActionLog.findMany({
      where: { moderatorId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.modActionLog.count({ where: { moderatorId } }),
  ]);

  return {
    data: logs,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
