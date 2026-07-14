import { app } from './app';
import { env } from './lib/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { syncQueue, syncPopularTracksQueue } from './lib/queue';
import { catalogService } from './services/catalogService';

export let dbPopulationStatus: 'healthy' | 'degraded' | 'empty' = 'healthy';

if (env.ENABLE_WORKERS) {
  void import('./jobs/workers.js');
  logger.info('Background workers enabled');
} else {
  logger.info('Background workers disabled for this process');
}

const scheduleSyncJobs = async () => {
  await syncQueue.add(
    'sync-all',
    { type: 'sync-all' },
    {
      repeat: { pattern: '0 3 * * *' },
      jobId: 'sync-all-daily',
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );

  await syncQueue.add(
    'refresh-stale',
    { type: 'refresh-stale' },
    {
      repeat: { pattern: '0 6 * * *' },
      jobId: 'refresh-stale-daily',
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );

  await syncPopularTracksQueue.add(
    'sync-popular-tracks',
    {},
    {
      repeat: { pattern: '0 2 * * 0' },
      jobId: 'sync-popular-tracks-weekly',
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );

  logger.info('Sync cron jobs scheduled: daily sync-all at 3am, refresh-stale at 6am, popular tracks weekly Sunday 2am');
};

const invalidateStaleCaches = async () => {
  try {
    const patterns = ['catalog:homepage:v*', 'spotify:search:*'];
    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
        logger.info({ pattern, count: keys.length }, 'Cleared stale cache keys on deploy');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Cache invalidation failed on deploy — non-fatal');
  }
};

async function checkDatabasePopulation(): Promise<void> {
  try {
    const [artistCount, songCount, genreCount, languageCount] = await Promise.all([
      prisma.artist.count(),
      prisma.song.count(),
      prisma.genre.count(),
      prisma.language.count(),
    ]);

    const hasArtists = artistCount > 0;
    const hasSongs = songCount > 0;
    const hasGenres = genreCount > 0;

    if (!hasArtists && !hasSongs && !hasGenres) {
      dbPopulationStatus = 'empty';
      logger.error(
        'DATABASE IS EMPTY — catalog data will be missing. ' +
        'Run `npx tsx prisma/seed.ts` immediately to restore data. ' +
        'The /api/health endpoint now reports degraded status.'
      );
    } else if (!hasArtists || !hasSongs || !hasGenres) {
      dbPopulationStatus = 'degraded';
      logger.warn(
        { artistCount, songCount, genreCount, languageCount },
        'Database partially empty — some catalog data is missing'
      );
    } else {
      dbPopulationStatus = 'healthy';
      logger.info(
        { artistCount, songCount, genreCount, languageCount },
        'Database population check passed'
      );
    }
  } catch (err) {
    dbPopulationStatus = 'empty';
    logger.error({ err }, 'Database population check failed — Neon may be cold-starting');
  }
}

const server = app.listen(env.PORT, async () => {
  logger.info({ port: env.PORT }, 'Server started');
  await invalidateStaleCaches();
  await checkDatabasePopulation();

  if (env.ENABLE_WORKERS) {
    await scheduleSyncJobs();
  }

  // Pre-warm homepage cache in background so first user request hits Redis
  catalogService.getHomepageData().then(() => {
    logger.info('Homepage cache warmed');
  }).catch((err) => {
    logger.warn({ err }, 'Homepage cache warmup failed — non-fatal');
  });
});

const gracefulShutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received');

  server.close(async () => {
    try {
      await prisma.$disconnect();
      await redis.quit();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Shutdown failure');
      process.exit(1);
    }
  });
};

process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
