// ---------------------------------------------------------------------------
// Sync cron registration (Stage 2 / 2.6 self-heal).
//
// Extracted from `index.ts` so that both the boot path and the repeatable-job
// self-heal can re-register the same set. Previously the registration function
// was a closure inside `index.ts`, so the startup verifier could only detect a
// missing job — it could not repair one, and it did not re-check after boot.
// ---------------------------------------------------------------------------

import { syncQueue, syncPopularTracksQueue } from '../lib/queue';
import { LIBRARY_ENRICHMENT_JOB_NAME } from './libraryEnrichmentJob';
import { logger } from '../lib/logger';

export const scheduleSyncJobs = async (): Promise<void> => {
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

  // Tuesday/Thursday 3am — YouTube library enrichment (DAILY_CAP=99 unmatched
  // songs/day, sized to the YouTube free-tier quota — see libraryEnrichmentJob)
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
