import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { getReferralCode, applyReferral, getMyReferrals } from '../src/services/referralService';
import { getBalance } from '../src/services/tokenService';
import { REWARD_CONFIG } from '../src/config/rewards';
import { ApiError } from '../src/middleware/errorHandler';
import { createUser, cleanupUser } from './helpers';

describe('referralService', () => {
  let referrer: Awaited<ReturnType<typeof createUser>>;
  let friend: Awaited<ReturnType<typeof createUser>>;
  let code: string;

  before(async () => {
    referrer = await createUser();
    friend = await createUser();
  });

  after(async () => {
    await cleanupUser(friend.id);
    await cleanupUser(referrer.id);
  });

  test('getReferralCode mints a stable unique code', async () => {
    code = await getReferralCode(referrer.id);
    assert.ok(code.length >= 6);
    assert.equal(await getReferralCode(referrer.id), code);
  });

  test('self-referral is rejected', async () => {
    await assert.rejects(
      applyReferral(code, referrer.id),
      (err: unknown) => err instanceof ApiError && err.code === 'SELF_REFERRAL',
    );
  });

  test('unknown code is rejected', async () => {
    await assert.rejects(
      applyReferral('ZZZZZZZZ', friend.id),
      (err: unknown) => err instanceof ApiError && err.code === 'INVALID_REFERRAL_CODE',
    );
  });

  test('valid code credits referrer exactly REFERRAL_REWARD once', async () => {
    const before = await getBalance(referrer.id);
    await applyReferral(code, friend.id);
    assert.equal(await getBalance(referrer.id), before + REWARD_CONFIG.REFERRAL_REWARD);

    const count = await prisma.referral.count({ where: { referrerId: referrer.id } });
    assert.equal(count, 1);

    const ledger = await prisma.tokenLedger.findMany({
      where: { userId: referrer.id, sourceType: 'REFERRAL' },
    });
    assert.equal(ledger.length, 1);
  });

  test('a second referral code cannot be applied by the same user', async () => {
    const other = await createUser();
    try {
      await assert.rejects(
        applyReferral(code, other.id).then(() => applyReferral(code, other.id)),
        (err: unknown) => err instanceof ApiError && err.code === 'ALREADY_REFERRED',
      );
    } finally {
      await cleanupUser(other.id);
    }
  });

  test('referred user counts against the referrer', async () => {
    const mine = await getMyReferrals(referrer.id);
    assert.ok(mine.totalReferrals >= 1);
    assert.ok(mine.referrals.some((r: any) => r.id === friend.id));
    assert.ok(mine.referralCode);
  });
});
