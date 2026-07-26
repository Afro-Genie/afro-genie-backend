import type { RepeatOptions } from 'bullmq';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { createQueue } from '../lib/queue';

export const analyticsRollupQueue = createQueue('analyticsRollupQueue');

const JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: 50,
  repeat: {
    every: 24 * 60 * 60 * 1000,
  } satisfies RepeatOptions,
  jobId: 'rollup-artist-analytics',
};

export const scheduleAnalyticsRollup = async () => {
  await analyticsRollupQueue.add('rollupAnalytics', {}, JOB_OPTIONS);
};

export const processAnalyticsRollupJob = async (): Promise<void> => {
  // Yesterday in UTC
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const dayStart = new Date(yesterday);
  const dayEnd = new Date(yesterday);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const artists = await prisma.artist.findMany({
    where: { softDeleted: false },
    select: { id: true, name: true },
  });

  let processed = 0;

  for (const artist of artists) {
    // Count TranslationRequest rows created yesterday for this artist's songs
    const translationRequestCount = await prisma.translationRequest.count({
      where: {
        createdAt: { gte: dayStart, lt: dayEnd },
        song: { artistId: artist.id },
      },
    });

    const existingRow = await prisma.artistAnalyticsDaily.findUnique({
      where: { artistId_date: { artistId: artist.id, date: dayStart } },
    });

    if (existingRow) {
      continue;
    }

    // Real play count for yesterday from SongPlay events
    const playCount = await prisma.songPlay.count({
      where: {
        song: { artistId: artist.id },
        playedAt: { gte: dayStart, lt: dayEnd },
      },
    });

    // Real unique listeners (distinct userId values, excluding null)
    const uniqueListenerRows = await prisma.songPlay.groupBy({
      by: ['userId'],
      where: {
        song: { artistId: artist.id },
        playedAt: { gte: dayStart, lt: dayEnd },
        userId: { not: null },
      },
    });
    const uniqueListeners = uniqueListenerRows.length;

    await prisma.artistAnalyticsDaily.upsert({
      where: { artistId_date: { artistId: artist.id, date: dayStart } },
      create: {
        artistId: artist.id,
        date: dayStart,
        plays: playCount,
        translationViews: translationRequestCount,
        uniqueListeners,
      },
      update: {
        plays: playCount,
        translationViews: translationRequestCount,
        uniqueListeners,
      },
    });

    processed++;
  }

  logger.info({ date: dayStart.toISOString().slice(0, 10), processed }, 'Analytics rollup complete');
};
