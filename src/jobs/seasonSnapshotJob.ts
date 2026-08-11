import type { RepeatOptions } from 'bullmq';
import { seasonSnapshotQueue } from '../lib/queue';
import { freezeSeason } from '../services/seasonService';

const SNAPSHOT_JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: 50,
  repeat: {
    // Monthly from process start (BullMQ handles exact cadence via its repeat
    // scheduler; the worker runs when Redis is available). Freezing is
    // idempotent per period, so a re-run never double-pays.
    every: 30 * 24 * 60 * 60 * 1000,
  } satisfies RepeatOptions,
};

export const scheduleSeasonSnapshot = async () => {
  await seasonSnapshotQueue.add(
    'freezeSeason',
    {},
    { ...SNAPSHOT_JOB_OPTIONS, jobId: 'season-snapshot' },
  );
};

export const processSeasonSnapshotJob = async (): Promise<void> => {
  await freezeSeason();
};
