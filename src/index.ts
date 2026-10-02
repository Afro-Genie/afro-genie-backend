import { app } from './app';
import { env, missingPaymentKeys } from './lib/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis, scanKeys } from './lib/redis';
import { syncPopularTracksQueue } from './lib/queue';
import { catalogService } from './services/catalogService';
import { bulkIndex } from './services/searchService';
import { shutdownBandwidthMonitor } from './lib/bandwidthMonitor';
import { scheduleSyncJobs } from './jobs/syncCron';
import { startSelfHeal } from './jobs/selfHeal';

export let dbPopulationStatus: 'healthy' | 'degraded' | 'empty' = 'healthy';

if (env.ENABLE_WORKERS) {
  void import('./jobs/workers.js');
  logger.info('Background workers enabled');
} else {
  logger.info('Background workers disabled for this process');
}

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

/**
 * Payment readiness self-check (task 1.9).
 *
 * Runs before the listener opens so the warning is in the deploy log even if a
 * later startup step hangs. Skipped under NODE_ENV=test, where keys are
 * deliberately absent and the 503 path is what we are testing.
 *
 * In production this cannot warn: env.ts already threw for missing keys. So a
 * warning here means an instance booted with a partial/blank-but-present config.
 */
function checkPaymentConfiguration(): void {
  if (env.NODE_ENV === 'test') return;

  const missing = missingPaymentKeys();
  if (missing.length === 0) {
    logger.info(
      { webhookPath: '/api/payments/webhook' },
      'GT payments configured — Paystack enabled',
    );
    return;
  }

  logger.warn(
    { missing, nodeEnv: env.NODE_ENV },
    'GT PAYMENTS ARE DISABLED: ' +
      `${missing.join(', ')} not set. ` +
      'GET /api/payments/bundles still works, but POST /api/payments/initialize ' +
      'and GET /api/payments/verify/:reference will return 503 ' +
      'PAYMENTS_NOT_CONFIGURED, and the webhook will reject events with 503. ' +
      'Users cannot buy GT on this instance.',
  );
}

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

checkPaymentConfiguration();

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
    } catch (err) {
      logger.error({ err }, 'Failed to schedule sync jobs');
    }

    // Periodic verification that every repeat registration is still present in
    // Redis, re-registering any that vanished (2.6). Replaces a boot-only check
    // that covered 4 of 14 repeatable jobs and could not repair them.
    startSelfHeal();

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
      // Drain buffered bandwidth counters BEFORE closing Redis, otherwise up to
      // one flush interval of egress accounting is lost on every deploy/restart
      // (2.10).
      await shutdownBandwidthMonitor();
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
