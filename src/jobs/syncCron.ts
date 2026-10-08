// ---------------------------------------------------------------------------
// Sync cron registration (Stage 2 / 2.6 self-heal).
//
// Extracted from `index.ts` so that both the boot path and the repeatable-job
// self-heal can re-register the same set. Previously the registration function
// was a closure inside `index.ts`, so the startup verifier could only detect a
// missing job — it could not repair one, and it did not re-check after boot.
//
// Phase 4: the Spotify catalog crons (popular tracks, new releases, sync-all,
// refresh-stale) were removed with the Spotify pipeline. Only the jobs that
// still have a provider remain.
// ---------------------------------------------------------------------------

import { syncQueue } from '../lib/queue';
import { LIBRARY_ENRICHMENT_JOB_NAME } from './libraryEnrichmentJob';
import { logger } from '../lib/logger';

export const scheduleSyncJobs = async (): Promise<void> => {
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

  logger.info('Sync cron jobs scheduled: daily 5am lyrics backfill, Tue/Thu 3am library enrichment');
};
