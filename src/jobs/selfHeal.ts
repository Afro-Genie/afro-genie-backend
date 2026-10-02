// ---------------------------------------------------------------------------
// Repeatable-job self-heal (Stage 2 / 2.6).
//
// Every BullMQ repeatable job lives in Redis as a hash of `repeat:<pattern>`
// keys. A Redis flush, a failover, or a deploy onto an empty/evicted instance
// silently removes them: no worker is subscribed, no error is raised, and the
// job simply never runs again. That is the failure mode behind "the weekly
// challenge rotation never ran" — the listener existed, the processor existed,
// but the repeat registration the processor was waiting on had evaporated.
//
// This module treats missing repeat registrations the way the app already
// treats an empty catalog: verify, log loudly, re-register. It is deliberately
// periodic rather than boot-only. The pre-existing check in `index.ts` ran once
// at startup and covered only four sync jobs, so any job that disappeared later
// (i.e. all of them, since the failure is a runtime event) stayed gone until the
// next deploy.
//
// Every repair is an idempotent re-registration of a repeatable job keyed by a
// stable `jobId`; re-running it never duplicates work.
// ---------------------------------------------------------------------------

import type { Queue } from 'bullmq';
import {
  abuseDetectionQueue,
  challengeRotationQueue,
  reconciliationQueue,
  passRevocationQueue,
  modPoolDistributionQueue,
  seasonSnapshotQueue,
  overturnRateAlertQueue,
  viewCountFlushQueue,
  syncQueue,
  syncPopularTracksQueue,
} from '../lib/queue';
import { scheduleAbuseDetection } from './abuseDetectionJob';
import { scheduleChallengeRotation } from './challengeRotationJob';
import { scheduleReconciliation } from './reconciliationJob';
import { schedulePassRevocation } from './passRevocationJob';
import { scheduleModPoolDistribution } from './modPoolDistributionJob';
import { scheduleSeasonSnapshot } from './seasonSnapshotJob';
import { scheduleOverturnRateAlert } from './overturnRateAlertJob';
import { scheduleViewCountFlush } from './viewCountFlushJob';
import { scheduleSyncJobs } from './syncCron';
import { logger } from '../lib/logger';

const HOUR_MS = 60 * 60 * 1000;

/** How often to re-verify. Hourly: cheap (a handful of GETs) and well inside
 *  the shortest repeat interval. */
export const SELF_HEAL_INTERVAL_MS = HOUR_MS;

interface RepeatJobSpec {
  /** Human label used in logs. */
  label: string;
  queue: Queue;
  jobId: string;
  /** Idempotent re-registration. */
  schedule: () => Promise<unknown>;
}

/**
 * Every repeatable job the app depends on.
 *
 * A job absent from this list gets no self-heal, so adding a new repeatable job
 * without registering it here is a silent gap — that trade is deliberate because
 * a wrong entry would re-register jobs on a schedule the operator did not choose.
 */
const REPEAT_JOBS: readonly RepeatJobSpec[] = [
  { label: 'challenge-rotation', queue: challengeRotationQueue, jobId: 'challenge-rotation-weekly', schedule: scheduleChallengeRotation },
  { label: 'abuse-detection', queue: abuseDetectionQueue, jobId: 'abuse-detection-hourly', schedule: scheduleAbuseDetection },
  { label: 'reconciliation', queue: reconciliationQueue, jobId: 'reconcile-wallets', schedule: scheduleReconciliation },
  { label: 'pass-revocation', queue: passRevocationQueue, jobId: 'revoke-expired-passes', schedule: schedulePassRevocation },
  { label: 'mod-pool-distribution', queue: modPoolDistributionQueue, jobId: 'distribute-mod-pool', schedule: scheduleModPoolDistribution },
  { label: 'season-snapshot', queue: seasonSnapshotQueue, jobId: 'season-snapshot', schedule: scheduleSeasonSnapshot },
  { label: 'overturn-rate-alert', queue: overturnRateAlertQueue, jobId: 'overturn-rate-alert', schedule: scheduleOverturnRateAlert },
  { label: 'view-count-flush', queue: viewCountFlushQueue, jobId: 'flush-song-views', schedule: scheduleViewCountFlush },
  // The sync crons are registered as one group; re-registering the group is
  // idempotent (stable jobIds), so a single repair covers all of them.
  { label: 'sync-crons', queue: syncQueue, jobId: 'sync-new-releases-biweekly', schedule: scheduleSyncJobs },
  { label: 'sync-popular-tracks', queue: syncPopularTracksQueue, jobId: 'sync-popular-tracks-monday', schedule: scheduleSyncJobs },
];

export interface SelfHealResult {
  checked: number;
  missing: string[];
  repaired: string[];
  failed: string[];
}

/**
 * Check every repeat registration and re-register the missing ones.
 *
 * Never throws: a failed repair is reported, not propagated, because a
 * self-heal routine that can crash the process is worse than one that logs.
 */
export async function verifyAndRepairRepeatJobs(): Promise<SelfHealResult> {
  const result: SelfHealResult = { checked: REPEAT_JOBS.length, missing: [], repaired: [], failed: [] };

  for (const spec of REPEAT_JOBS) {
    let present = false;
    try {
      // Repeatable jobs live alongside the template job under this exact id.
      present = Boolean(await spec.queue.getJob(spec.jobId));
    } catch (err) {
      logger.warn({ err, job: spec.label }, 'Self-heal could not read repeat registration');
      result.failed.push(spec.label);
      continue;
    }

    if (present) continue;

    result.missing.push(spec.label);
    try {
      await spec.schedule();
      result.repaired.push(spec.label);
      logger.warn(
        { job: spec.label, jobId: spec.jobId },
        'Repeatable job was missing from Redis — re-registered',
      );
    } catch (err) {
      result.failed.push(spec.label);
      logger.error({ err, job: spec.label }, 'Self-heal failed to re-register repeatable job');
    }
  }

  if (result.missing.length > 0) {
    logger.warn(
      { missing: result.missing, repaired: result.repaired, failed: result.failed },
      'Self-heal repaired missing repeatable jobs',
    );
  }

  return result;
}

let selfHealTimer: NodeJS.Timeout | null = null;

/** Verify immediately, then on an interval. Safe to call more than once. */
export function startSelfHeal(): void {
  if (selfHealTimer) return;

  void verifyAndRepairRepeatJobs().catch((err) =>
    logger.warn({ err }, 'Initial self-heal check failed — will retry on interval'),
  );

  selfHealTimer = setInterval(() => {
    void verifyAndRepairRepeatJobs().catch((err) =>
      logger.warn({ err }, 'Self-heal check failed — will retry on interval'),
    );
  }, SELF_HEAL_INTERVAL_MS);
  selfHealTimer.unref?.();

  logger.info({ intervalHours: SELF_HEAL_INTERVAL_MS / HOUR_MS }, 'Repeatable-job self-heal started');
}

/** Stop the interval and run one final verification. */
export async function stopSelfHeal(): Promise<void> {
  if (selfHealTimer) {
    clearInterval(selfHealTimer);
    selfHealTimer = null;
  }
}
