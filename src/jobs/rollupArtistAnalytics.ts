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
    const translationRequestCount = await prisma.translationRequest.count({ where: { createdAt: { gte: dayStart, lt: dayEnd }, song: { artistId: artist.id } } });
    const translationRequestsFulfilled = await prisma.translationRequest.count({ where: { createdAt: { gte: dayStart, lt: dayEnd }, status: 'FULFILLED' as any, song: { artistId: artist.id } } });
    const translationViewEvents = await prisma.translationViewEvent.findMany({ where: { artistId: artist.id, viewedAt: { gte: dayStart, lt: dayEnd } }, select: { userId: true, sessionId: true } });
    const readerKeys = new Set(translationViewEvents.map((e) => e.userId ? `u:${e.userId}` : e.sessionId ? `s:${e.sessionId}` : '').filter(Boolean));
    const prior = await prisma.translationViewEvent.findMany({ where: { artistId: artist.id, viewedAt: { lt: dayStart } }, select: { userId: true, sessionId: true } });
    const priorSet = new Set(prior.map((e) => e.userId ? `u:${e.userId}` : e.sessionId ? `s:${e.sessionId}` : '').filter(Boolean));
    const returningReaders = Array.from(readerKeys).filter((k) => priorSet.has(k)).length;
    const playCount = await prisma.songPlay.count({ where: { song: { artistId: artist.id }, playedAt: { gte: dayStart, lt: dayEnd } } });
    const uniqueListenerRows = await prisma.songPlay.groupBy({ by: ['userId'], where: { song: { artistId: artist.id }, playedAt: { gte: dayStart, lt: dayEnd }, userId: { not: null } } });
    const uniqueListeners = uniqueListenerRows.length;
    await prisma.artistAnalyticsDaily.upsert({
      where: { artistId_date: { artistId: artist.id, date: dayStart } },
      create: { artistId: artist.id, date: dayStart, plays: playCount, translationViews: translationViewEvents.length, uniqueListeners, translationReaders: readerKeys.size, returningReaders, translationRequests: translationRequestCount, translationRequestsFulfilled, lyricsViews: 0 },
      update: { plays: playCount, translationViews: translationViewEvents.length, uniqueListeners, translationReaders: readerKeys.size, returningReaders, translationRequests: translationRequestCount, translationRequestsFulfilled, lyricsViews: 0 },
    });
    processed++;
  }

  logger.info({ date: dayStart.toISOString().slice(0, 10), processed }, 'Analytics rollup complete');
};
