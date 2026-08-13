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

  const scheduled = await prisma.release.findMany({
    where: {
      status: 'SCHEDULED',
      releaseDate: { lte: now },
    },
    select: { id: true },
  });

  if (scheduled.length === 0) {
    return;
  }

  const releaseIds = scheduled.map((release) => release.id);

  await prisma.$transaction([
    prisma.release.updateMany({
      where: { id: { in: releaseIds } },
      data: {
        status: 'PUBLISHED',
      },
    }),
    prisma.song.updateMany({
      where: { releaseId: { in: releaseIds } },
      data: { released: true },
    }),
  ]);

  logger.info({ published: releaseIds.length }, 'Auto-published scheduled releases');
};
