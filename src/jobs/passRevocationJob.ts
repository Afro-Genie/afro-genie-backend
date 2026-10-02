import type { RepeatOptions } from 'bullmq';
import { passRevocationQueue } from '../lib/queue';
import { revokeExpiredPasses } from '../services/passService';

// ---------------------------------------------------------------------------
// Hourly expiry sweep for premium passes (Phase 2). Read/modify is idempotent:
// flipping already-inactive rows is a no-op.
// ---------------------------------------------------------------------------

const PASS_REVOCATION_JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: 50,
  repeat: {
    every: 60 * 60 * 1000,
  } satisfies RepeatOptions,
};

export const schedulePassRevocation = async () => {
  await passRevocationQueue.add(
    'revoke-expired-passes',
    {},
    { ...PASS_REVOCATION_JOB_OPTIONS, jobId: 'revoke-expired-passes' },
  );
};

export const processPassRevocationJob = async (): Promise<void> => {
  await revokeExpiredPasses();
};
