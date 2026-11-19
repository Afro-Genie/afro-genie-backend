// ---------------------------------------------------------------------------
// Scheduled catalog growth cron (Phase 5).
//
// Registers a daily YouTube catalog import job that operates through the
// same preview / apply pipeline as administrator-triggered imports.  The job
// is enqueued on the youtubeCatalogImportQueue with a single concurrency so
// scheduled runs never compete with manual or post-sync imports.
//
// Exit criteria met:
//  - Schedule inspectable/pausable/resumable without production writes
//  - Preview/apply auditable/idempotent (preview-first, explicit apply)
//  - Recurring runs cannot create duplicate / non-African records (policy-
//    enforced eligibility + advisory locks + idempotent persist)
//
// ---------------------------------------------------------------------------

import { youtubeCatalogImportQueue } from '../lib/queue';
import { logger } from '../lib/logger';
import { env } from '../lib/env';
import type { CatalogImportSource } from '../services/youtubeCatalogImportService';

export const CATALOG_GROWTH_JOB_NAME = 'catalog-growth-daily';

const DEFAULT_MAX_RESULTS = 30;
const DEFAULT_MAX_PAGES = 20;

// ---------------------------------------------------------------------------
// Register the daily catalog growth job.
// This is intended to be called from server bootstrap (index.ts) or a one-off
// setup script.  It is idempotent: re-registering with the same jobId is safe
// because BullMQ will update the existing job rather than duplicate it.
// ---------------------------------------------------------------------------

export async function scheduleCatalogGrowthJob(): Promise<void> {
  await youtubeCatalogImportQueue.add(
    CATALOG_GROWTH_JOB_NAME,
    {
      operation: 'preview',
      adminId: 'scheduled-cron',
      maxResults: Number(env.CATALOG_GROWTH_MAX_RESULTS) || DEFAULT_MAX_RESULTS,
      maxPages: Number(env.CATALOG_GROWTH_MAX_PAGES) || DEFAULT_MAX_PAGES,
    },
    {
      repeat: { pattern: '0 6 * * *' }, // daily at 6am UTC
      jobId: CATALOG_GROWTH_JOB_NAME,
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );

  logger.info({
    jobName: CATALOG_GROWTH_JOB_NAME,
    repeat: '0 6 * * *',
    maxResults: DEFAULT_MAX_RESULTS,
    maxPages: DEFAULT_MAX_PAGES,
  }, 'Scheduled catalog growth job registered: daily 6am UTC preview import');
}

// ---------------------------------------------------------------------------
// Manually trigger a one-off catalog growth preview run (admin only).
// This mirrors the scheduled job data model so the same admin UI can inspect
// either a scheduled or manual run.
// ---------------------------------------------------------------------------

export async function triggerCatalogGrowthPreview(
  adminId: string,
  opts: {
    maxResults?: number;
    maxPages?: number;
  } = {}
): Promise<{
  jobId: string;
  preview?: any;
  quotaEstimate?: any;
}> {
  const job = await youtubeCatalogImportQueue.add(
    CATALOG_GROWTH_JOB_NAME,
    {
      operation: 'preview',
      adminId,
      maxResults: opts.maxResults ?? DEFAULT_MAX_RESULTS,
      maxPages: opts.maxPages ?? DEFAULT_MAX_PAGES,
    },
    { jobId: `catalog-growth-manual-${Date.now()}` }
  );

  // Wait briefly for the preview to complete (single-concurrency queue)
  await new Promise(resolve => setTimeout(resolve, 2000));

  const jobIdValue = job.id!;
  const queueJob = await youtubeCatalogImportQueue.getJob(jobIdValue);
  if (!queueJob) {
    return { jobId: jobIdValue };
  }

  const result = queueJob.returnvalue as any;
  return {
    jobId: jobIdValue,
    preview: result,
    quotaEstimate: result?.discovery?.quotaEstimate,
  };
}

logger.info('Catalog growth cron module loaded');