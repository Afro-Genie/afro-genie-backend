import { app } from './app';
import { env } from './lib/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis, scanKeys } from './lib/redis';
import { syncQueue, syncPopularTracksQueue } from './lib/queue';
import { catalogService } from './services/catalogService';
import { bulkIndex } from './services/searchService';
import { LIBRARY_ENRICHMENT_JOB_NAME } from './jobs/libraryEnrichmentJob';

export let dbPopulationStatus: 'healthy' | 'degraded' | 'empty' = 'healthy';

if (env.ENABLE_WORKERS) {
  void import('./jobs/workers.js');
  logger.info('Background workers enabled');
} else {
  logger.info('Background workers disabled for this process');
}

const scheduleSyncJobs = async () => {
  // Monday 2am — popular tracks (heavy weekly discovery)
  await syncPopularTracksQueue.add(
    'sync-popular-tracks',
    {},
    {
      repeat: { pattern: '0 2 * * 1' },
      jobId: 'sync-popular-tracks-monday',
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );

  // 1st & 15th 3am — new releases (bi-weekly, light check for fresh drops)
  await syncQueue.add(
    'sync-new-releases',
    { type: 'sync-new-releases' },
    {
      repeat: { pattern: '0 3 1,15 * *' },
      jobId: 'sync-new-releases-biweekly',
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );

  // Monthly 1st 2am — full artist sync (heavy; daily caps protect the budget)
  await syncQueue.add(
    'sync-all',
    { type: 'sync-all' },
    {
      repeat: { pattern: '0 2 1 * *' },
      jobId: 'sync-all-monthly',
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );

  // Genre discovery has no scheduled cron anymore (was Friday 2am). Reliance on
  // artist sync + new releases keeps coverage; the worker and the admin manual
  // trigger (/api/admin/sync) remain available when a targeted run is wanted.

  // Daily 4am — incremental metadata refresh (quick stale-artist scan)
  await syncQueue.add(
    'refresh-stale',
    { type: 'refresh-stale' },
    {
      repeat: { pattern: '0 4 * * *' },
      jobId: 'refresh-stale-daily',
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );

  // Daily 5am — lyrics backfill sweep for songs that were missed
  await syncQueue.add(
    'backfill-lyrics',
    { type: 'backfill-lyrics' },
    {
      repeat: { pattern: '0 5 * * *' },
      jobId: 'backfill-lyrics-daily',
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );

  // Tuesday/Thursday 3am — YouTube library enrichment (max 500 unmatched songs/day)
  await syncQueue.add(
    LIBRARY_ENRICHMENT_JOB_NAME,
    { type: LIBRARY_ENRICHMENT_JOB_NAME },
    {
      repeat: { pattern: '0 3 * * 2,4' },
      jobId: 'library-enrichment-tue-thu',
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );

  logger.info('Sync cron jobs scheduled: Mon 2am popular, 1st&15th 3am new releases, monthly 1st 2am full sync, daily 4am refresh stale, daily 5am lyrics backfill, Tue/Thu 3am library enrichment');
};

// ---------------------------------------------------------------------------
// Self-healing repeat job verification — re-registers if Redis lost the jobs
// ---------------------------------------------------------------------------
const verifyRepeatJobs = async () => {
  const coreJobs = await Promise.all([
    syncQueue.getJob('refresh-stale-daily'),
    syncPopularTracksQueue.getJob('sync-popular-tracks-monday'),
    syncQueue.getJob('backfill-lyrics-daily'),
    syncQueue.getJob('library-enrichment-tue-thu'),
  ]);

  const missing = coreJobs.some((j) => !j);
  if (missing) {
    logger.warn('Core repeat jobs missing from Redis — re-registering all sync jobs');
    await scheduleSyncJobs();
  } else {
    logger.info('Core repeat jobs confirmed present in Redis');
  }
};

const FALLBACK_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

const startFallbackSyncTimer = () => {
  setInterval(async () => {
    try {
      const lastSync = await redis.get('sync:lastSync:popularTracks');
      const daysSinceLastSync = lastSync
        ? (Date.now() - new Date(lastSync).getTime()) / (1000 * 60 * 60 * 24)
        : 99;

      if (daysSinceLastSync >= 3) {
        logger.info({ daysSinceLastSync }, 'Fallback timer: 3+ days since last popular tracks sync, triggering now');
        await syncPopularTracksQueue.add('sync-popular-tracks', {}, {
          jobId: `sync-popular-tracks-fallback-${Date.now()}`,
          removeOnComplete: 100,
          removeOnFail: 50,
        });
      }
    } catch (err) {
      logger.warn({ err }, 'Fallback sync check failed');
    }
  }, FALLBACK_SYNC_INTERVAL_MS);

  logger.info({ intervalHours: FALLBACK_SYNC_INTERVAL_MS / 3_600_000 }, 'Fallback sync timer started');
};

const invalidateStaleCaches = async () => {
  try {
    const patterns = ['catalog:homepage:v*', 'spotify:search:*'];
    for (const pattern of patterns) {
      const keys = await scanKeys(pattern);
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

  try {
    await invalidateStaleCaches();
  } catch (err) {
    logger.warn({ err }, 'Cache invalidation failed on startup — non-fatal');
  }

  try {
    await checkDatabasePopulation();
  } catch (err) {
    logger.error({ err }, 'Database population check failed on startup');
  }

  if (env.ENABLE_WORKERS) {
    try {
      await scheduleSyncJobs();
      await verifyRepeatJobs();
    } catch (err) {
      logger.error({ err }, 'Failed to schedule sync jobs');
    }

    startFallbackSyncTimer();
  }

  // Pre-warm homepage cache in background so first user request hits Redis
  catalogService.getHomepageData().then(() => {
    logger.info('Homepage cache warmed');
  }).catch((err) => {
    logger.warn({ err }, 'Homepage cache warmup failed — non-fatal');
  });

  // Ensure Typesense search index is in sync with database on startup
  bulkIndex().then(() => {
    logger.info('Typesense bulk index completed on startup');
  }).catch((err) => {
    logger.warn({ err }, 'Typesense bulk index failed on startup — search may be incomplete');
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

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason }, 'Unhandled Promise Rejection');
});

process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'Uncaught Exception');
  process.exit(1);
});
