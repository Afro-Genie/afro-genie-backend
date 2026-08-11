import IORedis from 'ioredis';
import { Worker } from 'bullmq';
import { logger } from '../lib/logger';
import { env } from '../lib/env';
import { sharedConnection } from '../lib/queue';
import { processLanguageCategorizationJob } from './languageCategorizationJob';
import { processLyricsEnrichmentJob } from './lyricsEnrichmentJob';
import { processNotificationJob } from './notificationJob';
import { processSearchIndexJob } from './searchIndexJob';
import { processTranslationJob } from './translationJob';
import { processViewCountFlushJob, scheduleViewCountFlush } from './viewCountFlushJob';
import { processSyncJob } from './syncWorker';
import { processPopularTracksSyncJob } from './popularTracksSyncJob';
import { processAnalyticsRollupJob, scheduleAnalyticsRollup } from './rollupArtistAnalytics';
import { processReleasePublishJob, scheduleReleasePublish } from './publishScheduledReleases';
import { processRewardJob } from './rewardJob';
import {
  processModPoolDistributionJob,
  scheduleModPoolDistribution,
} from './modPoolDistributionJob';
import {
  processSeasonSnapshotJob,
  scheduleSeasonSnapshot,
} from './seasonSnapshotJob';
import {
  processReconciliationJob,
  scheduleReconciliation,
} from './reconciliationJob';
import {
  processOverturnRateAlertJob,
  scheduleOverturnRateAlert,
} from './overturnRateAlertJob';
import type { TranslationJobData } from '../types/translation';
import type { RewardJobData } from './rewardJob';
import type { SyncJobData } from './syncWorker';

// Reuse the single shared connection from queue.ts (1 Redis connection for all workers)
// Cast needed because project ioredis and BullMQ's bundled ioredis have divergent types,
// but they are identical at runtime (same Redis protocol).
const connection = sharedConnection as any;

// Translation worker has its own Redis connection with a longer commandTimeout (15s)
// so long-running Gemini AI calls don't trigger heartbeat timeouts on other workers.
const translationConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true,
  enableOfflineQueue: true,
  connectTimeout: 10000,
  commandTimeout: 15000,
  retryStrategy(times: number) {
    if (times > 15) return null;
    return Math.min(times * 300, 10000);
  },
}) as any;

async function startWorkers(): Promise<void> {
  // Wait for Redis to be ready before creating workers
  // Queues already trigger connect() at import time, so just wait for ready state.
  if (sharedConnection) {
    const st = sharedConnection.status;
    if (st === 'ready') {
      logger.info('Redis shared connection already ready');
    } else if (st === 'connecting' || st === 'connect') {
      logger.info({ status: st }, 'Redis shared connection in progress, waiting for ready');
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          sharedConnection!.removeListener('ready', onReady);
          sharedConnection!.removeListener('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          sharedConnection!.removeListener('ready', onReady);
          sharedConnection!.removeListener('error', onError);
          reject(err);
        };
        sharedConnection!.on('ready', onReady);
        sharedConnection!.on('error', onError);
      });
    } else {
      // 'wait', 'close', 'end' — not connected yet
      try {
        await sharedConnection.connect();
        logger.info('Redis shared connection ready for workers');
      } catch (err) {
        logger.error({ err }, 'Failed to connect Redis for workers — retrying in 5s');
        await new Promise((r) => setTimeout(r, 5000));
        await sharedConnection.connect();
      }
    }
  }

  // Connect the dedicated translation worker connection (lazyConnect: true)
  if (translationConnection.status !== 'ready') {
    await translationConnection.connect();
    logger.info('Translation worker Redis connection ready');
  }

  const translationWorker = new Worker<TranslationJobData>(
    'translationQueue',
    async (job) => {
      logger.info({ jobId: job.id, songId: job.data.songId, targetLang: job.data.targetLang }, 'Translation worker picked up job');
      await processTranslationJob(job);
    },
    { connection: translationConnection, concurrency: 2 }
  );

  translationWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'Translation job failed in worker');
  });

  translationWorker.on('error', (err) => {
    logger.error({ err }, 'Translation worker error');
  });

  const notificationWorker = new Worker(
    'notificationQueue',
    async (job) => {
      logger.info({ jobId: job.id, name: job.name }, 'Processing notification job');
    },
    { connection }
  );

  const searchIndexWorker = new Worker(
    'searchIndexQueue',
    async (job) => {
      logger.info({ jobId: job.id, name: job.name }, 'Processing search index job');
      await processSearchIndexJob(job);
    },
    { connection, concurrency: 3 }
  );

  const languageCategorizationWorker = new Worker(
    'languageCategorizationQueue',
    async (job) => {
      logger.info({ jobId: job.id, songId: job.data.songId }, 'Processing language categorization job');
      await processLanguageCategorizationJob(job);
    },
    { connection, concurrency: 2 }
  );

  const lyricsEnrichmentWorker = new Worker(
    'lyricsEnrichmentQueue',
    async (job) => {
      logger.info({ jobId: job.id, songId: job.data.songId }, 'Processing lyrics enrichment job');
      await processLyricsEnrichmentJob(job);
    },
    { connection, concurrency: 2 }
  );

  const viewCountFlushWorker = new Worker(
    'viewCountFlushQueue',
    async () => {
      await processViewCountFlushJob();
    },
    { connection, concurrency: 1 }
  );

  const syncWorker = new Worker<SyncJobData>(
    'syncQueue',
    async (job) => {
      logger.info({ jobId: job.id, type: job.data.type }, 'Processing sync job');
      await processSyncJob(job);
    },
    { connection, concurrency: 1 }
  );

  const popularTracksSyncWorker = new Worker(
    'syncPopularTracksQueue',
    async (job) => {
      logger.info({ jobId: job.id }, 'Processing popular tracks sync job');
      await processPopularTracksSyncJob(job);
    },
    { connection, concurrency: 1 }
  );

  const analyticsRollupWorker = new Worker(
    'analyticsRollupQueue',
    async () => {
      logger.info('Processing analytics rollup job');
      await processAnalyticsRollupJob();
    },
    { connection, concurrency: 1 }
  );

  analyticsRollupWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Analytics rollup job failed');
  });

  const releasePublishWorker = new Worker(
    'releasePublishQueue',
    async () => {
      logger.info('Processing scheduled release publish job');
      await processReleasePublishJob();
    },
    { connection, concurrency: 1 }
  );

  releasePublishWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Release publish job failed');
  });

  const rewardWorker = new Worker<RewardJobData>(
    'rewardQueue',
    async (job) => {
      logger.info({ jobId: job.id, userId: job.data.userId, reason: job.data.reason }, 'Processing reward job');
      await processRewardJob(job);
    },
    { connection, concurrency: 3 }
  );

  rewardWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Reward job failed');
  });

  rewardWorker.on('error', (err) => {
    logger.error({ err }, 'Reward worker error');
  });

  const modPoolDistributionWorker = new Worker(
    'modPoolDistributionQueue',
    async () => {
      logger.info('Processing mod pool distribution job');
      await processModPoolDistributionJob();
    },
    { connection, concurrency: 1 }
  );

  const seasonSnapshotWorker = new Worker(
    'seasonSnapshotQueue',
    async () => {
      logger.info('Processing season snapshot job');
      await processSeasonSnapshotJob();
    },
    { connection, concurrency: 1 }
  );

  const reconciliationWorker = new Worker(
    'reconciliationQueue',
    async () => {
      logger.info('Processing wallet/ledger reconciliation job');
      await processReconciliationJob();
    },
    { connection, concurrency: 1 }
  );

  const overturnRateAlertWorker = new Worker(
    'overturnRateAlertQueue',
    async () => {
      logger.info('Processing overturn-rate alert job');
      await processOverturnRateAlertJob();
    },
    { connection, concurrency: 1 }
  );

  logger.info('All 15 workers started successfully');

  await scheduleViewCountFlush();
  await scheduleAnalyticsRollup();
  await scheduleReleasePublish();
  await scheduleModPoolDistribution();
  await scheduleSeasonSnapshot();
  await scheduleReconciliation();
  await scheduleOverturnRateAlert();
}

startWorkers().catch((err) => {
  logger.error({ err }, 'Worker startup failed — jobs will not be processed');
});
