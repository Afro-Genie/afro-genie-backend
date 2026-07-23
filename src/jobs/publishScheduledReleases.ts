import type { RepeatOptions } from 'bullmq';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { createQueue } from '../lib/queue';

export const releasePublishQueue = createQueue('releasePublishQueue');

const JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: 50,
  repeat: {
    every: 60 * 60 * 1000,
  } satisfies RepeatOptions,
  jobId: 'publish-scheduled-releases',
};

export const scheduleReleasePublish = async () => {
  await releasePublishQueue.add('publishReleases', {}, JOB_OPTIONS);
};

export const processReleasePublishJob = async (): Promise<void> => {
  const now = new Date();

  const result = await prisma.release.updateMany({
    where: {
      status: 'SCHEDULED',
      releaseDate: { lte: now },
    },
    data: {
      status: 'PUBLISHED',
    },
  });

  if (result.count > 0) {
    logger.info({ published: result.count }, 'Auto-published scheduled releases');
  }
};
