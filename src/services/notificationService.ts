import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { NotificationType } from '@prisma/client';

// ---------------------------------------------------------------------------
// Notification service (Phase 1).
//
// Persists Notification rows directly (works with or without Redis). The
// notificationQueue worker also routes through here for forward compatibility.
// ---------------------------------------------------------------------------

export interface CreateNotificationParams {
  userId: string;
  title: string;
  message: string;
  type?: NotificationType;
}

export async function createNotification(params: CreateNotificationParams): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        userId: params.userId,
        title: params.title,
        message: params.message,
        type: params.type ?? 'REWARD',
      },
    });
  } catch (err) {
    logger.error({ err, ...params }, 'createNotification failed');
  }
}

export async function listNotifications(userId: string, page = 1, limit = 20) {
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(50, Math.max(1, limit));

  const [data, total] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    }),
    prisma.notification.count({ where: { userId } }),
  ]);

  return {
    data,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    },
  };
}

export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, read: false } });
}

export async function markNotificationRead(userId: string, id: string) {
  const notification = await prisma.notification.findFirst({ where: { id, userId } });
  if (!notification) return { ok: false };

  await prisma.notification.update({ where: { id }, data: { read: true } });
  return { ok: true };
}
