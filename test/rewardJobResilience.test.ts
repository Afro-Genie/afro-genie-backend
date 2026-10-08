import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { processRewardJob } from '../src/jobs/rewardJob';
import { queueReward } from '../src/services/rewardService';
import { rewardQueue } from '../src/lib/queue';
import { createUser, cleanupUser, uid } from './helpers';

// P1.4 — the 44 failed reward jobs.
//
// Diagnosis of the live failed set: 42 of them died on
// `Foreign key constraint violated on the constraint: UserWallet_userId_fkey`
// because the user was deleted between enqueue and processing (`User` has no
// soft-delete), and 2 died to "job stalled more than allowable limit" when a
// deploy restarted the worker mid-job.
//
// Both are single transient events, and BullMQ defaults to ONE attempt — so
// every one of those jobs was destroyed outright and the tokens were never
// credited. In one case a moderator who still exists lost 2 GT for work they
// actually did.
//
// These tests pin the two fixes:
//
//   1. rewards are enqueued with retries, and
//   2. a reward for a deleted user completes as a no-op instead of being parked
//      in the failed set forever.
//
// Retrying is only safe because every credit path goes through
// dedupeCreditTokens, which no-ops on an already-seen idempotencyKey — so a
// replay cannot double-credit. Test 3 pins that property directly, because it
// is the only thing standing between "add retries" and "double-credit users".

describe('rewardJob — retry and deleted-user handling', () => {
  test('queueReward asks BullMQ for retries instead of a single attempt', async () => {
    // Capture what queueReward hands BullMQ. Stubbing the method on the real
    // queue object avoids needing experimental module mocking, and no job is
    // actually written.
    const addCalls: Array<{ name: string; data: unknown; opts: unknown }> = [];
    const realAdd = rewardQueue.add.bind(rewardQueue);
    rewardQueue.add = (async (name: string, data: unknown, opts: unknown) => {
      addCalls.push({ name, data, opts });
      return { id: 'captured' };
    }) as typeof rewardQueue.add;

    try {
      await queueReward('user-no-such', 10, 'Welcome bonus via referral', 'REFERRAL_BONUS', `k:${uid()}`);
    } finally {
      rewardQueue.add = realAdd;
    }

    assert.equal(addCalls.length, 1, 'reward should have been enqueued once');
    const opts = addCalls[0].opts as { attempts?: number; backoff?: { type: string; delay: number } };

    assert.ok(
      (opts.attempts ?? 0) >= 3,
      `rewards need >= 3 attempts so a restart cannot eat a payout, got ${opts.attempts}`,
    );
    assert.equal(opts.backoff?.type, 'exponential', 'retries must back off, not hot-loop');
    assert.ok((opts.backoff?.delay ?? 0) > 0, 'backoff needs a non-zero delay');
  });

  test('a reward for a deleted user completes instead of throwing', async () => {
    // Create the user, then delete them before the job runs — the exact race
    // that produced 42 of the 44 historical failures.
    const user = await createUser();
    const jobData = {
      userId: user.id,
      amount: 10,
      reason: 'Welcome bonus via referral',
      event: 'REFERRAL_BONUS',
      idempotencyKey: `deleted-user:${uid()}`,
    };

    await cleanupUser(user.id);
    assert.equal(
      await prisma.user.count({ where: { id: user.id } }),
      0,
      'user must be gone for this test to be meaningful',
    );

    const job = {
      id: 'test-job',
      data: jobData,
      attemptsMade: 0,
    } as never;

    // Before the fix this rejected with a Prisma P2003 and the job was recorded
    // as failed. It must now resolve so the queue does not accumulate ghosts.
    await processRewardJob(job);

    // And nothing was created for the departed user.
    assert.equal(await prisma.userWallet.count({ where: { userId: user.id } }), 0);
    assert.equal(
      await prisma.tokenLedger.count({ where: { idempotencyKey: jobData.idempotencyKey } }),
      0,
    );
  });

  test('replaying a reward cannot double-credit (why retries are safe)', async () => {
    const user = await createUser();
    const idempotencyKey = `replay:${uid()}`;
    const data = {
      userId: user.id,
      amount: 25,
      reason: 'Community moderation action',
      event: 'MODERATOR_ACTION',
      idempotencyKey,
    };

    const balanceBefore = await prisma.userWallet
      .findUnique({ where: { userId: user.id }, select: { balance: true } })
      .then((w) => w?.balance ?? 0);

    // Three deliveries of the same reward, as a retry storm would produce.
    for (let i = 0; i < 3; i += 1) {
      await processRewardJob({ id: `replay-${i}`, data, attemptsMade: i } as never);
    }

    const balanceAfter = await prisma.userWallet
      .findUnique({ where: { userId: user.id }, select: { balance: true } })
      .then((w) => w?.balance ?? 0);

    assert.equal(
      balanceAfter - balanceBefore,
      25,
      'three deliveries of one idempotent reward must credit exactly once',
    );

    const ledgerRows = await prisma.tokenLedger.count({ where: { idempotencyKey } });
    assert.equal(ledgerRows, 1, 'exactly one ledger row per idempotency key');

    await cleanupUser(user.id);
  });
});