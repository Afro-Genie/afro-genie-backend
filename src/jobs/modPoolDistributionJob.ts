import type { RepeatOptions } from 'bullmq';
import { modPoolDistributionQueue } from '../lib/queue';
import { distributeWeekly } from '../services/modPoolService';

const DISTRIBUTION_JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: 50,
  repeat: {
    // Monthly from process start (BullMQ handles exact cadence via its repeat
    // scheduler; the worker runs when Redis is available). The distribution
    // itself is idempotent per week, so a re-run never double-pays.
    every: 30 * 24 * 60 * 60 * 1000,
  } satisfies RepeatOptions,
};

export const scheduleModPoolDistribution = async () => {
  await modPoolDistributionQueue.add(
    'distributeModPool',
    {},
    { ...DISTRIBUTION_JOB_OPTIONS, jobId: 'distribute-mod-pool' },
  );
};

export const processModPoolDistributionJob = async (): Promise<void> => {
  await distributeWeekly();
};
