import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { logger } from '../lib/logger';
import { getJobStallInfo } from '../lib/catalogImportDiagnostics';
import { youtubeCatalogImportQueue } from '../lib/queue';
import type { YouTubeCatalogImportJobData } from './youtubeCatalogImportJob';

const jobRetention = {
  removeOnComplete: { age: 14 * 24 * 60 * 60, count: 1000 },
  removeOnFail: { age: 30 * 24 * 60 * 60, count: 1000 },
};

const nonTerminalStates = new Set(['waiting', 'active', 'delayed', 'paused', 'prioritized', 'waiting-children']);

function isNonTerminal(state: string): boolean {
  return nonTerminalStates.has(state);
}

export interface RequeueResult {
  jobId: string;
  recoveredFrom: string;
  message: string;
}

export async function requeueCatalogImportJob(job: Job<YouTubeCatalogImportJobData>, reason: string): Promise<RequeueResult> {
  const data = job.data;
  if (!['preview', 'resume', 'apply'].includes(data.operation)) {
    throw new Error(`Cannot recover unsupported import operation: ${String(data.operation)}`);
  }

  const prefix = data.operation === 'apply'
    ? 'catalog_apply_recover'
    : data.operation === 'resume'
      ? 'catalog_resume_recover'
      : 'catalog_preview_recover';
  const jobId = `${prefix}_${randomUUID()}`;
  const nextData: YouTubeCatalogImportJobData = {
    ...data,
    cancelRequested: false,
    supersededBy: undefined,
    recoveredFrom: String(job.id),
    recoveryReason: reason,
    recoveredAt: new Date().toISOString(),
  };

  const created = await youtubeCatalogImportQueue.add(data.operation, nextData, {
    ...jobRetention,
    attempts: 1,
    jobId,
  });
  const state = await job.getState();
  if (state === 'active') {
    await job.updateData({
      ...data,
      cancelRequested: true,
      supersededBy: jobId,
      recoveryReason: reason,
    });
    await job.updateProgress({
      stage: 'cancelled',
      cancelRequested: true,
      cancelled: true,
      lastUpdatedAt: new Date().toISOString(),
      message: `This job was superseded by recovery job ${jobId}. Already-imported songs were preserved.`,
    });
  } else if (isNonTerminal(state)) {
    await job.remove();
  }

  logger.info(
    { recoveredFrom: job.id, jobId, operation: data.operation, reason },
    'Recovered stalled catalog import job',
  );
  return {
    jobId: String(created.id),
    recoveredFrom: String(job.id),
    message: `Queued a fresh ${data.operation} job. Already-imported songs are preserved by the apply idempotency checks.`,
  };
}

export async function recoverCatalogImportJobById(jobId: string, reason: string): Promise<RequeueResult> {
  const job = await youtubeCatalogImportQueue.getJob(jobId);
  if (!job) throw new Error('Catalog import job not found');
  const state = await job.getState();
  if (!isNonTerminal(state)) {
    throw new Error(`Only queued or running jobs can be recovered. This job is ${state}.`);
  }
  return requeueCatalogImportJob(job, reason);
}

export async function recoverStalledCatalogImportJobs(limit = 5): Promise<number> {
  const jobs = await youtubeCatalogImportQueue.getJobs(['waiting', 'active', 'delayed'], 0, 199, false);
  const candidates = await Promise.all(jobs.map(async (job) => {
    const state = await job.getState();
    const stall = getJobStallInfo(job);
    const data = job.data as YouTubeCatalogImportJobData;
    return {
      job,
      state,
      stall,
      stale: isNonTerminal(state)
        && ['preview', 'resume', 'apply'].includes(data.operation)
        && !data.cancelRequested
        && !data.supersededBy
        && stall.stalled,
      timestamp: job.timestamp,
    };
  }));

  let recovered = 0;
  for (const candidate of candidates.sort((a, b) => a.timestamp - b.timestamp)) {
    if (recovered >= limit) break;
    if (!candidate.stale) continue;
    try {
      await requeueCatalogImportJob(candidate.job, candidate.stall.reason);
      recovered++;
    } catch (error) {
      logger.error(
        { jobId: candidate.job.id, err: error },
        'Failed to recover stalled catalog import job',
      );
    }
  }
  return recovered;
}
