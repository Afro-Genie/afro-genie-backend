import type { Job } from 'bullmq';
import { logger } from '../lib/logger';
import { createNotification } from '../services/notificationService';
import type { NotificationType } from '@prisma/client';

export interface NotificationJobData {
  userId: string;
  title: string;
  message: string;
  type?: NotificationType;
}

export async function processNotificationJob(job: Job<NotificationJobData>): Promise<void> {
  const { userId, title, message, type } = job.data;
  await createNotification({ userId, title, message, type });
  logger.info({ jobId: job.id, userId }, 'Notification persisted');
}
