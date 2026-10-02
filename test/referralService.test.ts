import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { getOrCreateReferralCode, applyReferral, getMyReferrals, hasMutualReferral } from '../src/services/referralService';
import { createUser, cleanupUser } from './helpers';

describe('referralService', () => {
  let referrer: Awaited<ReturnType<typeof createUser>>;
  let friend: Awaited<ReturnType<typeof createUser>>;
  let code: string;

  before(async () => {
    referrer = await createUser();
    friend = await createUser();
    code = await getOrCreateReferralCode(referrer.id);
  });

  after(async () => {
    await cleanupUser(friend.id);
    await cleanupUser(referrer.id);
  });

  test('getOrCreateReferralCode mints a stable unique code', async () => {
    assert.ok(code.length >= 6);
    assert.equal(await getOrCreateReferralCode(referrer.id), code);
  });

  test('self-referral is rejected', async () => {
    const result = await applyReferral(code, referrer.id);
    assert.equal(result.success, false);
    assert.match(result.message, /Cannot refer yourself/i);
  });

  test('unknown code is rejected', async () => {
    const result = await applyReferral('ZZZZZZZZ', friend.id);
    assert.equal(result.success, false);
    assert.match(result.message, /Invalid referral code/i);
  });

  test('valid code records the referral edge and links the user once', async () => {
    const first = await applyReferral(code, friend.id);
    assert.equal(first.success, true);

    const linked = await prisma.user.findUnique({
      where: { id: friend.id },
      select: { referredByUserId: true },
    });
    assert.equal(linked?.referredByUserId, referrer.id);

    const edges = await prisma.referral.findMany({
      where: { referredUserId: friend.id },
    });
    assert.equal(edges.length, 1);
    assert.equal(edges[0].referrerId, referrer.id);
    assert.equal(edges[0].code, code);

    // Repeat application is rejected once the user is already referred.
    const second = await applyReferral(code, friend.id);
    assert.equal(second.success, false);
    assert.match(second.message, /already been referred/i);
  });

  test('getMyReferrals lists the referred user against the referrer', async () => {
    const mine = await getMyReferrals(referrer.id);
    assert.equal(mine.totalReferrals, 1);
    assert.equal(mine.referralCode, code);
    assert.ok(mine.referrals.some((r: any) => r.id === friend.id));
  });

  test('hasMutualReferral is false for a one-way referral', async () => {
    const mutual = await hasMutualReferral(friend.id, referrer.id);
    assert.equal(mutual, false);
  });
});