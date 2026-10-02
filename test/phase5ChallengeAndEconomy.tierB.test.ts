import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { claimChallengeReward, getChallengeProgress, getCurrentChallenges } from '../src/services/challengeService';
import { getWeekWindow, runChallengeRotation, CHALLENGE_TEMPLATES } from '../src/jobs/challengeRotationJob';
import { getRewardConfig, REWARD_CONFIG, REWARD_CONFIG_CACHE_KEY, TUNABLE_REWARD_TYPES } from '../src/config/rewards';
import {
  createPhase5User,
  createPhase5Song,
  createChallenge,
  createPhase5Translation,
  createPhase5LedgerEntry,
  newRegistry,
  registerPhase5Teardown,
  startPhase5Harness,
  tokenFor,
  ledgerSummaryKey,
  type Phase5Harness,
} from './phase5Fixtures';

// ---------------------------------------------------------------------------
// REMEDIATION-PLAN.md 7.5 — Phase 5 Tier B.
//
// These are the three groups the audit's §12.7 withheld from Tier A because
// they genuinely mutate state. They are safe to run now, and only now, because
// of 7.1/7.2: the process is pointed at the disposable PostgreSQL from
// `npm run test:db:up`, and `scripts/load-test-env.cjs` refuses to start it
// otherwise. On a production connection every assertion below would be a
// production write — which is precisely why they were not written before.
//
// SAFETY CONTRACT
//   * One registry per file; every fixture is sentinel-tagged and id-captured.
//   * The two groups the audit named:
//       4. the challenge claim flow end-to-end
//       5. admin economy PATCH and POST /economy/adjust
//     plus, from the same list:
//       6. runChallengeRotation() — which is simultaneously the §12.1 fix.
//   * `runChallengeRotation` upserts on (type, startsAt) and so writes rows that
//     carry the template titles, not the sentinel. The rotation group asserts
//     the week window is empty before it runs and fails rather than deleting
//     anything it did not create.
// ---------------------------------------------------------------------------

const registry = newRegistry();
registerPhase5Teardown(registry);

const HOUR = 60 * 60 * 1000;

// ===========================================================================
// 4. The challenge claim flow, end to end.
// ===========================================================================

describe('B4. challenge claim flow', () => {
  let userId: string;
  let userToken: string;

  before(async () => {
    const user = await createPhase5User(registry, 'USER');
    userId = user.id;
    userToken = tokenFor(user, 'USER');
    registry.redisKeys.push(ledgerSummaryKey(userId));
  });

  /** Give the user enough distinct translations to clear a TRANSLATE_N_SONGS target. */
  async function seedTranslations(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const song = await createPhase5Song(registry);
      await createPhase5Translation({ userId, songId: song.id, status: 'PENDING' });
    }
  }

  test('an incomplete challenge is refused with CHALLENGE_INCOMPLETE (400)', async () => {
    const challenge = await createChallenge(registry, { type: 'TRANSLATE_N_SONGS', targetValue: 3, gtReward: 30 });

    await assert.rejects(
      () => claimChallengeReward(userId, challenge.id),
      (err: any) => {
        assert.equal(err.code, 'CHALLENGE_INCOMPLETE');
        assert.equal(err.statusCode ?? err.status, 400);
        return true;
      },
    );
  });

  test('a completed challenge awards the GT, writes the ledger row and notifies', async () => {
    const challenge = await createChallenge(registry, { type: 'TRANSLATE_N_SONGS', targetValue: 2, gtReward: 30 });
    await seedTranslations(2);

    const before = await prisma.userWallet.findUnique({ where: { userId }, select: { balance: true } });

    const result = await claimChallengeReward(userId, challenge.id);

    assert.equal(result.claimed, true);
    assert.equal(result.challengeId, challenge.id);
    assert.equal(result.gtReward, 30);

    // 1. the wallet moved by exactly the reward
    const after = await prisma.userWallet.findUnique({ where: { userId }, select: { balance: true } });
    assert.equal(after?.balance, (before?.balance ?? 0) + 30, 'wallet must increase by exactly gtReward');

    // 2. the ledger row exists and is attributed to the challenge
    const ledger = await prisma.tokenLedger.findFirst({
      where: { userId, idempotencyKey: `challenge:${challenge.id}:${userId}` },
    });
    assert.ok(ledger, 'an idempotent ledger row must exist for the claim');
    assert.equal(ledger!.amount, 30);
    assert.equal(ledger!.type, 'EARN');
    assert.equal(ledger!.sourceType, 'CHALLENGE');
    assert.equal(ledger!.sourceId, challenge.id);

    // 3. the entitlement blocks a second claim even under a race
    const entitlement = await prisma.userEntitlement.findUnique({
      where: { userId_type: { userId, type: `CHALLENGE:${challenge.id}` } },
    });
    assert.ok(entitlement, 'a UserEntitlement must be written');

    // 4. the user was told
    const notification = await prisma.notification.findFirst({
      where: { userId, type: 'REWARD' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(notification, 'a REWARD notification must be created');
    assert.match(notification!.message, /30 GT/);

    // 5. progress now reports claimed
    const progress = await getChallengeProgress(userId, challenge.id);
    assert.equal(progress.claimed, true);
    assert.equal(progress.completed, true);
  });

  test('a second claim is refused with ALREADY_CLAIMED (409) and pays nothing extra', async () => {
    const challenge = await createChallenge(registry, { type: 'TRANSLATE_N_SONGS', targetValue: 2, gtReward: 30 });
    await seedTranslations(2);

    await claimChallengeReward(userId, challenge.id);
    const balanceAfterFirst = (await prisma.userWallet.findUnique({ where: { userId }, select: { balance: true } }))!
      .balance;

    await assert.rejects(
      () => claimChallengeReward(userId, challenge.id),
      (err: any) => {
        assert.equal(err.code, 'ALREADY_CLAIMED');
        assert.equal(err.statusCode ?? err.status, 409);
        return true;
      },
    );

    const balanceAfterSecond = (await prisma.userWallet.findUnique({ where: { userId }, select: { balance: true } }))!
      .balance;
    assert.equal(balanceAfterSecond, balanceAfterFirst, 'a rejected double claim must not move the balance');

    const ledgerCount = await prisma.tokenLedger.count({
      where: { userId, idempotencyKey: `challenge:${challenge.id}:${userId}` },
    });
    assert.equal(ledgerCount, 1, 'the idempotencyKey must keep exactly one ledger row');
  });

  test('concurrent claims of the same challenge pay out exactly once', async () => {
    // The entitlement is the race barrier, and the ledger's idempotencyKey is
    // the second one. Both must hold, or a user who double-taps the claim
    // button gets 2x the reward.
    //
    // Note the intended behaviour on a lost race: the service catches the P2002
    // and still reports success (challengeService.ts:249), because the winner
    // already paid the user. So the invariant to assert is the MONEY, not the
    // return value -- one ledger row, one entitlement, balance moved once.
    const racer = await createPhase5User(registry);
    const raceSong = await createPhase5Song(registry);
    await createPhase5Translation({ userId: racer.id, songId: raceSong.id, status: 'PENDING' });
    const challenge = await createChallenge(registry, { type: 'TRANSLATE_N_SONGS', targetValue: 1, gtReward: 30 });

    const results = await Promise.allSettled([
      claimChallengeReward(racer.id, challenge.id),
      claimChallengeReward(racer.id, challenge.id),
      claimChallengeReward(racer.id, challenge.id),
    ]);

    // No request may fail: a loser of the race is told "claimed", not an error.
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(rejected.length, 0, `no concurrent claim may error, got ${JSON.stringify(rejected.map((r) => (r as PromiseRejectedResult).reason?.code))}`);
    assert.equal(results.length, 3);

    const ledgerRows = await prisma.tokenLedger.findMany({
      where: { userId: racer.id, idempotencyKey: `challenge:${challenge.id}:${racer.id}` },
    });
    assert.equal(ledgerRows.length, 1, 'three concurrent claims must still write exactly one ledger row');

    const entitlements = await prisma.userEntitlement.count({
      where: { userId: racer.id, type: `CHALLENGE:${challenge.id}` },
    });
    assert.equal(entitlements, 1, 'the entitlement that lost the race must not be duplicated');

    const fresh = await createPhase5User(registry);
    const freshWallet = await prisma.userWallet.findUnique({ where: { userId: fresh.id }, select: { balance: true } });
    assert.equal(freshWallet?.balance ?? 0, 0, 'sanity: an unrelated user still starts at 0');
    const racerWallet = await prisma.userWallet.findUniqueOrThrow({ where: { userId: racer.id }, select: { balance: true } });
    assert.equal(racerWallet.balance, 30, 'the balance must move by the reward exactly once');
  });

  test('a not-yet-started challenge is CHALLENGE_NOT_STARTED (400)', async () => {
    const now = Date.now();
    const challenge = await createChallenge(registry, {
      type: 'EARN_N_GT',
      targetValue: 1,
      gtReward: 50,
      startsAt: new Date(now + 2 * HOUR),
      expiresAt: new Date(now + 7 * 24 * HOUR),
    });

    await assert.rejects(
      () => claimChallengeReward(userId, challenge.id),
      (err: any) => {
        assert.equal(err.code, 'CHALLENGE_NOT_STARTED');
        assert.equal(err.statusCode ?? err.status, 400);
        return true;
      },
    );
  });

  test('an expired challenge is CHALLENGE_EXPIRED (400)', async () => {
    const now = Date.now();
    const challenge = await createChallenge(registry, {
      type: 'EARN_N_GT',
      targetValue: 1,
      gtReward: 50,
      startsAt: new Date(now - 48 * HOUR),
      expiresAt: new Date(now - HOUR),
    });

    await assert.rejects(
      () => claimChallengeReward(userId, challenge.id),
      (err: any) => {
        assert.equal(err.code, 'CHALLENGE_EXPIRED');
        assert.equal(err.statusCode ?? err.status, 400);
        return true;
      },
    );
  });

  test('an inactive challenge is 404 NOT_FOUND', async () => {
    const challenge = await createChallenge(registry, {
      type: 'STREAK_7_DAYS',
      targetValue: 7,
      gtReward: 25,
      active: false,
    });

    await assert.rejects(
      () => claimChallengeReward(userId, challenge.id),
      (err: any) => {
        assert.equal(err.code, 'NOT_FOUND');
        assert.equal(err.statusCode ?? err.status, 404);
        return true;
      },
    );
  });

  test('the claim is reachable over HTTP and returns the same result', async () => {
    // End-to-end through the router, so the 200/409 contract the frontend
    // depends on is covered, not just the service.
    const harness: Phase5Harness = await startPhase5Harness();
    try {
      const challenge = await createChallenge(registry, {
        type: 'TRANSLATE_N_SONGS',
        targetValue: 1,
        gtReward: 15,
      });
      await seedTranslations(1);

      const first = await harness.request('POST', `/api/challenges/${challenge.id}/claim`, {
        token: userToken,
      });
      assert.equal(first.status, 200);
      assert.equal(first.body.claimed, true);
      assert.equal(first.body.gtReward, 15);

      const second = await harness.request('POST', `/api/challenges/${challenge.id}/claim`, {
        token: userToken,
      });
      assert.equal(second.status, 409, 'the double-claim must be a 409 over HTTP too');
      assert.equal(second.body.code, 'ALREADY_CLAIMED');
    } finally {
      await harness.close();
    }
  });

  test('EARN_N_GT progress counts only EARN rows inside the window', async () => {
    // A dedicated user: earlier tests in this file award a challenge to
    // `userId`, and that award is itself an in-window EARN row, which would
    // silently inflate this assertion.
    const earner = await createPhase5User(registry);
    const now = Date.now();
    const challenge = await createChallenge(registry, {
      type: 'EARN_N_GT',
      targetValue: 100,
      gtReward: 50,
      startsAt: new Date(now - HOUR),
      expiresAt: new Date(now + 7 * 24 * HOUR),
    });

    await createPhase5LedgerEntry({ userId: earner.id, type: 'EARN', amount: 60, reason: 'in-window earn' });
    // A SPEND must not count towards "earn 100 GT".
    await createPhase5LedgerEntry({ userId: earner.id, type: 'SPEND', amount: -500, reason: 'spend' });
    // An EARN from before the window must not count either.
    await createPhase5LedgerEntry({
      userId: earner.id,
      type: 'EARN',
      amount: 999,
      reason: 'stale earn',
      createdAt: new Date(now - 30 * 24 * HOUR),
    });

    const progress = await getChallengeProgress(earner.id, challenge.id);
    assert.equal(progress.progress, 60, 'only in-window EARN rows count towards EARN_N_GT');
    assert.equal(progress.completed, false);
  });

  test('ACHIEVE_N_APPROVALS counts approved translations inside the window', async () => {
    const approver = await createPhase5User(registry);
    const now = Date.now();
    const challenge = await createChallenge(registry, {
      type: 'ACHIEVE_N_APPROVALS',
      targetValue: 2,
      gtReward: 30,
      startsAt: new Date(now - HOUR),
      expiresAt: new Date(now + 7 * 24 * HOUR),
    });

    for (let i = 0; i < 2; i += 1) {
      const song = await createPhase5Song(registry);
      await createPhase5Translation({
        userId: approver.id,
        songId: song.id,
        status: 'APPROVED',
        approvedAt: new Date(now - 30 * 60 * 1000),
      });
    }
    // A PENDING one must not count.
    const pendingSong = await createPhase5Song(registry);
    await createPhase5Translation({ userId: approver.id, songId: pendingSong.id, status: 'PENDING' });

    const progress = await getChallengeProgress(approver.id, challenge.id);
    assert.equal(progress.progress, 2, 'only APPROVED translations count');
    assert.equal(progress.completed, true);
  });

  test('TRANSLATE_N_SONGS counts DISTINCT songs, not rows', async () => {
    const translator = await createPhase5User(registry);
    const now = Date.now();
    const challenge = await createChallenge(registry, {
      type: 'TRANSLATE_N_SONGS',
      targetValue: 2,
      gtReward: 30,
      startsAt: new Date(now - HOUR),
      expiresAt: new Date(now + 7 * 24 * HOUR),
    });

    const song = await createPhase5Song(registry);
    for (const targetLang of ['fr', 'es', 'pt']) {
      await prisma.translation.create({
        data: {
          userId: translator.id,
          songId: song.id,
          sourceLang: 'en',
          targetLang,
          originalLyrics: 'o',
          translatedLyrics: 't',
          status: 'PENDING',
        },
        select: { id: true },
      });
    }

    const progress = await getChallengeProgress(translator.id, challenge.id);
    assert.equal(progress.progress, 1, 'three languages for one song is progress 1, not 3');
    assert.equal(progress.completed, false);
  });

  test('progress is clamped to targetValue so the UI cannot show 9000%', async () => {
    const now = Date.now();
    const challenge = await createChallenge(registry, {
      type: 'TRANSLATE_N_SONGS',
      targetValue: 1,
      gtReward: 30,
      startsAt: new Date(now - HOUR),
      expiresAt: new Date(now + 7 * 24 * HOUR),
    });
    await seedTranslations(3);

    const progress = await getChallengeProgress(userId, challenge.id);
    assert.equal(progress.progress, 1, 'progress must clamp at the target');
    assert.equal(progress.completed, true);
  });
});

// ===========================================================================
// 5. Admin economy: PATCH /rewards, PATCH /store/:id, POST /adjust.
// ===========================================================================

describe('B5. admin economy', () => {
  let harness: Phase5Harness;
  let adminToken: string;
  let targetUserId: string;

  before(async () => {
    harness = await startPhase5Harness();
    const admin = await createPhase5User(registry, 'ADMIN');
    adminToken = tokenFor(admin, 'ADMIN');
    const target = await createPhase5User(registry, 'USER');
    targetUserId = target.id;
    registry.redisKeys.push(ledgerSummaryKey(targetUserId), REWARD_CONFIG_CACHE_KEY);
  });

  after(async () => {
    await harness.close();
  });

  test('GET /economy/config returns every tunable reward with its config values', async () => {
    const res = await harness.request('GET', '/api/admin/economy/config', { token: adminToken });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.rewards));

    // Set equality against the tunables table rather than a hardcoded count:
    // adding a reward should not fail this test, but the route silently
    // dropping or duplicating one must.
    const returned = res.body.rewards.map((r: { type: string }) => r.type);
    assert.equal(new Set(returned).size, returned.length, 'the route must not list a reward type twice');
    const expectedTypes = TUNABLE_REWARD_TYPES.map((r) => r.type).sort();
    assert.deepEqual(
      [...returned].sort(),
      expectedTypes,
      'the route must list exactly the tunable reward types, with none missing',
    );

    for (const reward of res.body.rewards) {
      assert.ok(typeof reward.type === 'string' && reward.type.length > 0);
      assert.ok(typeof reward.label === 'string' && reward.label.length > 0);
      assert.ok(typeof reward.active === 'boolean', `${reward.type} must report an active flag`);
    }
  });

  test('PATCH /economy/rewards updates the value, flushes the cache and audit-logs', async () => {
    registry.economyConfigKeys.push('AI_TRANSLATION_AMOUNT');

    const before = await getRewardConfig();
    const original = before.AI_TRANSLATION_AMOUNT;

    const res = await harness.request('PATCH', '/api/admin/economy/rewards', {
      token: adminToken,
      body: { rewardType: 'AI_TRANSLATION', newAmount: 7 },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.updated, true);
    assert.equal(res.body.newValue.amount, 7);
    assert.equal(res.body.previousValue.amount, original);

    const stored = await prisma.economyConfig.findUnique({ where: { key: 'AI_TRANSLATION_AMOUNT' } });
    assert.equal(stored?.value, 7, 'the override must be persisted');

    // The 5-minute cache must be gone, or an admin's change is invisible for
    // up to five minutes — the bug the flush exists to prevent.
    assert.equal(await redis.get(REWARD_CONFIG_CACHE_KEY), null, 'the reward-config cache must be flushed');

    const after = await getRewardConfig();
    assert.equal(after.AI_TRANSLATION_AMOUNT, 7, 'a fresh read must observe the new value');

    const audit = await prisma.modActionLog.findFirst({
      where: { moderatorId: (await prisma.user.findFirst({ where: { displayName: { startsWith: 'P5TEST' }, role: 'ADMIN' } }))!.id, actionType: 'ECONOMY_REWARD_UPDATE' },
    });
    assert.ok(audit, 'a reward change must be audit-logged');

    // Restore, and record that we own the key for cleanup.
    await harness.request('PATCH', '/api/admin/economy/rewards', {
      token: adminToken,
      body: { rewardType: 'AI_TRANSLATION', newAmount: original },
    });
  });

  test('PATCH /economy/rewards rejects an unknown rewardType with 400', async () => {
    const res = await harness.request('PATCH', '/api/admin/economy/rewards', {
      token: adminToken,
      body: { rewardType: 'NOT_A_REAL_REWARD', newAmount: 5 },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
    assert.match(res.body.error ?? '', /Valid types/, 'the 400 must list the valid types so the admin can self-correct');
  });

  test('PATCH /economy/rewards requires at least one field to change', async () => {
    const res = await harness.request('PATCH', '/api/admin/economy/rewards', {
      token: adminToken,
      body: { rewardType: 'AI_TRANSLATION' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
  });

  test('PATCH /economy/rewards rejects a negative amount at the validation layer', async () => {
    const res = await harness.request('PATCH', '/api/admin/economy/rewards', {
      token: adminToken,
      body: { rewardType: 'AI_TRANSLATION', newAmount: -1 },
    });
    assert.equal(res.status, 400, 'a negative reward must be rejected before it is persisted');
  });

  test('PATCH /economy/rewards toggling active writes an ACTIVE: key', async () => {
    const key = 'ACTIVE:AI_TRANSLATION';
    registry.economyConfigKeys.push(key);

    const res = await harness.request('PATCH', '/api/admin/economy/rewards', {
      token: adminToken,
      body: { rewardType: 'AI_TRANSLATION', active: false },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.newValue.active, false);

    const stored = await prisma.economyConfig.findUnique({ where: { key } });
    assert.equal(stored?.value, false);

    const config = await harness.request('GET', '/api/admin/economy/config', { token: adminToken });
    const row = config.body.rewards.find((r: any) => r.type === 'AI_TRANSLATION');
    assert.equal(row.active, false, 'the toggle must be reflected in GET /economy/config');

    await harness.request('PATCH', '/api/admin/economy/rewards', {
      token: adminToken,
      body: { rewardType: 'AI_TRANSLATION', active: true },
    });
  });

  test('POST /economy/adjust credits the wallet, notifies and audit-logs', async () => {
    const before = (await prisma.userWallet.findUnique({ where: { userId: targetUserId }, select: { balance: true } }))?.balance ?? 0;

    const res = await harness.request('POST', '/api/admin/economy/adjust', {
      token: adminToken,
      body: { userId: targetUserId, amount: 250, reason: 'goodwill', type: 'CREDIT' },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.amount, 250);
    assert.equal(res.body.balanceAfter, before + 250);

    const wallet = await prisma.userWallet.findUnique({ where: { userId: targetUserId }, select: { balance: true } });
    assert.equal(wallet?.balance, before + 250);

    const ledger = await prisma.tokenLedger.findFirst({
      where: { userId: targetUserId, sourceType: 'ADMIN_ECONOMY_ADJUST' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(ledger, 'an adjust must write a ledger row');
    assert.equal(ledger!.amount, 250);
    assert.match(ledger!.reason, /goodwill/);

    const notification = await prisma.notification.findFirst({
      where: { userId: targetUserId },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(notification, 'the user must be told their balance changed');
    assert.match(notification!.message, /250 GT/);
  });

  test('POST /economy/adjust DEBIT moves the balance down', async () => {
    const before = (await prisma.userWallet.findUnique({ where: { userId: targetUserId }, select: { balance: true } }))!.balance;

    const res = await harness.request('POST', '/api/admin/economy/adjust', {
      token: adminToken,
      body: { userId: targetUserId, amount: 100, reason: 'fraud reversal', type: 'DEBIT' },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.amount, -100, 'a DEBIT must report a negative signed amount');
    assert.equal(res.body.balanceAfter, before - 100);
  });

  test('POST /economy/adjust is 404 for an unknown user', async () => {
    const res = await harness.request('POST', '/api/admin/economy/adjust', {
      token: adminToken,
      body: { userId: '00000000-0000-4000-8000-000000000000', amount: 1, reason: 'r', type: 'CREDIT' },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'NOT_FOUND');
  });

  test('POST /economy/adjust rejects amount 0, a negative amount and a bad type', async () => {
    const bad: unknown[] = [
      { userId: targetUserId, amount: 0, reason: 'r', type: 'CREDIT' },
      { userId: targetUserId, amount: -5, reason: 'r', type: 'CREDIT' },
      { userId: targetUserId, amount: 1, reason: 'r', type: 'TRANSFER' },
      { userId: '', amount: 1, reason: 'r', type: 'CREDIT' },
      { userId: targetUserId, amount: 1, reason: '', type: 'CREDIT' },
    ];
    for (const body of bad) {
      const res = await harness.request('POST', '/api/admin/economy/adjust', { token: adminToken, body });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
    }
  });

  test('POST /economy/adjust rejects an amount above the 100000 ceiling', async () => {
    const res = await harness.request('POST', '/api/admin/economy/adjust', {
      token: adminToken,
      body: { userId: targetUserId, amount: 100_001, reason: 'too big', type: 'CREDIT' },
    });
    assert.equal(res.status, 400, 'the mint cap must hold, or one admin typo can inflate the economy');
  });

  test('PATCH /economy/store/:id is 404 for an unknown item', async () => {
    const res = await harness.request('PATCH', '/api/admin/economy/store/00000000-0000-4000-8000-000000000000', {
      token: adminToken,
      body: { tokenCost: 10 },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'NOT_FOUND');
  });

  test('PATCH /economy/store/:id applies a discount and forces limitedTime on', async () => {
    const item = await prisma.storeItem.create({
      data: { name: `P5TEST-store-${Date.now()}`, description: 'p5', tokenCost: 1000, category: 'BUNDLE' },
      select: { id: true, tokenCost: true },
    });
    registry.redisKeys.push('store:items', 'catalog:homepage:default');

    const res = await harness.request('PATCH', `/api/admin/economy/store/${item.id}`, {
      token: adminToken,
      body: { discountPercent: 25 },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.discountPercent, 25);
    assert.equal(res.body.discountedPrice, 750);
    assert.equal(res.body.limitedTime, true, 'a discount must imply a time limit');
    assert.equal(res.body.originalPrice, 1000, 'the pre-discount price must be preserved');

    await prisma.storeItem.delete({ where: { id: item.id } });
  });

  test('PATCH /economy/store/:id rejects a discount outside 1-99', async () => {
    const item = await prisma.storeItem.create({
      data: { name: `P5TEST-store-${Date.now()}`, description: 'p5', tokenCost: 100, category: 'BUNDLE' },
      select: { id: true },
    });
    registry.redisKeys.push('store:items', 'catalog:homepage:default');

    for (const discountPercent of [0, 100, -10]) {
      const res = await harness.request('PATCH', `/api/admin/economy/store/${item.id}`, {
        token: adminToken,
        body: { discountPercent },
      });
      assert.equal(res.status, 400, `discountPercent ${discountPercent} must be rejected`);
    }

    await prisma.storeItem.delete({ where: { id: item.id } });
  });

  test('GET /economy/circulation aggregates ledger and wallet totals', async () => {
    const res = await harness.request('GET', '/api/admin/economy/circulation', { token: adminToken });

    assert.equal(res.status, 200);
    for (const key of ['totalEarned', 'totalSpent', 'totalInCirculation', 'activeHolders']) {
      assert.equal(typeof res.body[key], 'number', `${key} must be a number`);
    }
    assert.ok(Array.isArray(res.body.daily));
    for (const day of res.body.daily) {
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(day.day), `daily entries must be ISO dates, got ${day.day}`);
      assert.ok(day.earned >= 0 && day.spent >= 0, 'spend must be reported as a positive magnitude');
    }
  });

  test('GET /economy/abuse returns the dashboard with its 3-sigma block', async () => {
    const res = await harness.request('GET', '/api/admin/economy/abuse', { token: adminToken });

    assert.equal(res.status, 200);
    assert.equal(res.body.threshold.rule, 'EARN_RATE_3_SIGMA');
    assert.ok(typeof res.body.threshold.cutoff === 'number');
    assert.ok(Array.isArray(res.body.lowQualityTranslations));
  });

  test('PATCH /economy/abuse/:flagId is 404 for an unknown flag', async () => {
    const res = await harness.request('PATCH', '/api/admin/economy/abuse/00000000-0000-4000-8000-000000000000', {
      token: adminToken,
      body: { reviewed: true },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'NOT_FOUND');
  });

  test('PATCH /economy/abuse/:flagId reviews a real flag', async () => {
    const user = await createPhase5User(registry, 'USER');
    const flag = await prisma.abuseFlag.create({
      data: { userId: user.id, rule: 'SELF_REFERRAL', severity: 'LOW', reviewed: false },
      select: { id: true },
    });

    const res = await harness.request('PATCH', `/api/admin/economy/abuse/${flag.id}`, {
      token: adminToken,
      body: { reviewed: true, pausedRewards: true },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.reviewed, true);
    assert.equal(res.body.pausedRewards, true);

    const stored = await prisma.abuseFlag.findUnique({ where: { id: flag.id } });
    assert.equal(stored?.reviewed, true);
    assert.equal(stored?.pausedRewards, true);
    // `reviewedById` is only written when the review actually happens, so
    // pausedRewards alone must not invent a reviewer.
    const admin = await prisma.user.findFirst({ where: { displayName: { startsWith: 'P5TEST' }, role: 'ADMIN' } });
    assert.equal(stored?.reviewedById, admin?.id, 'the reviewing admin must be recorded');
    assert.ok(stored?.reviewedAt, 'reviewedAt must be stamped');
  });

});

// ===========================================================================
// 6. runChallengeRotation() — the §12.1 fix itself.
// ===========================================================================

describe('B6. weekly challenge rotation', () => {
  test('rotation creates exactly one challenge per template for the current week', async () => {
    const { startsAt, expiresAt } = getWeekWindow();

    // Scoped-cleanup precondition. `runChallengeRotation` upserts on
    // (type, startsAt) and its rows carry template titles, not the sentinel, so
    // the teardown deletes them by week window. If anything is already there we
    // must fail rather than remove a row we did not create.
    const preExisting = await prisma.challenge.count({ where: { startsAt } });
    assert.equal(preExisting, 0, 'the current week window must be empty before rotation runs');
    registry.weekWindows.push(startsAt.toISOString());

    const result = await runChallengeRotation();

    assert.equal(result.upserted, CHALLENGE_TEMPLATES.length);
    assert.equal(result.upserted, 5, 'the lineup is 5 templates (see challengeRotationJob.ts)');

    const created = await prisma.challenge.findMany({ where: { startsAt } });
    assert.equal(created.length, 5, 'one row per template, no duplicates');
    for (const challenge of created) {
      assert.equal(challenge.active, true);
      assert.equal(challenge.expiresAt.getTime(), expiresAt.getTime());
      assert.ok(CHALLENGE_TEMPLATES.some((t) => t.type === challenge.type), `unexpected type ${challenge.type}`);
    }
  });

  test('rotation is idempotent: a second run updates rather than duplicates', async () => {
    const { startsAt } = getWeekWindow();
    const before = await prisma.challenge.count({ where: { startsAt } });

    const result = await runChallengeRotation();

    assert.equal(result.upserted, CHALLENGE_TEMPLATES.length);
    const after = await prisma.challenge.count({ where: { startsAt } });
    assert.equal(after, before, 're-running rotation must not add rows — the weekly cron will overlap');
  });

  test('rotation makes this week challenges actually visible to users', async () => {
    // The §12.1 symptom in one assertion: challenges existed in the table but
    // `GET /api/challenges` returned nothing, because nothing had ever run the
    // rotation. That is the "challenges dead in production" report.
    const { startsAt } = getWeekWindow();
    registry.weekWindows.push(startsAt.toISOString());
    await runChallengeRotation();

    const user = await createPhase5User(registry, 'USER');
    const offered = await getCurrentChallenges(user.id);

    // Assert containment, not equality: earlier tests in this file leave their
    // own active challenges in place for the whole file, and those are
    // correctly offered too. What must not happen is a rotated template type
    // going missing -- that was the §12.1 bug.
    const offeredTypes = new Set(offered.map((c: { type: string }) => c.type));
    for (const template of CHALLENGE_TEMPLATES) {
      assert.ok(offeredTypes.has(template.type), `the rotated ${template.type} challenge must be visible to users`);
    }
    for (const challenge of offered) {
      assert.equal(challenge.progress, 0, 'a brand new user has made no progress on anything');
      assert.equal(challenge.claimed, false);
    }
  });

  test('rotation deactivates challenges whose window has closed', async () => {
    const stale = await prisma.challenge.create({
      data: {
        type: 'STREAK_7_DAYS',
        title: 'P5TEST-stale',
        description: 'expired but still active',
        targetValue: 7,
        gtReward: 25,
        startsAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 23 * 24 * 60 * 60 * 1000),
        active: true,
      },
      select: { id: true },
    });
    registry.challengeIds.push(stale.id);

    const result = await runChallengeRotation();
    assert.ok(result.deactivated >= 1, 'a challenge whose expiresAt has passed must be deactivated');

    const after = await prisma.challenge.findUnique({ where: { id: stale.id }, select: { active: true } });
    assert.equal(after?.active, false, 'the stale challenge must no longer be active');
  });

  test('the week window used by rotation is the one getWeekWindow returns', async () => {
    const { startsAt, expiresAt } = getWeekWindow();
    registry.weekWindows.push(startsAt.toISOString());
    await runChallengeRotation();

    const created = await prisma.challenge.findMany({ where: { startsAt }, select: { expiresAt: true } });
    assert.ok(created.length > 0, 'rotation must have produced rows for this window');
    for (const challenge of created) {
      assert.equal(challenge.expiresAt.getTime(), expiresAt.getTime());
    }
    assert.equal((expiresAt.getTime() - startsAt.getTime()) / (7 * 24 * 60 * 60 * 1000), 1);
  });
});

// ===========================================================================
// 7. Group 7 of §12.7 — the aggregates the audit put in "Tier C, block until
//    an isolated database exists". Stage 7 unblocks it, so it is worth one
//    assertion: a green run against production proved only that the run was
//    non-destructive. Against a disposable database the numbers are evidence.
// ===========================================================================

describe('B7. aggregate economy figures (unblocked by 7.1)', () => {
  test('the challenge reward config is a strict subset of REWARD_CONFIG', async () => {
    const config = await getRewardConfig();
    for (const template of CHALLENGE_TEMPLATES) {
      assert.ok(template.gtReward > 0, `${template.type} must pay something`);
      assert.ok(
        Number.isFinite(config.CORRECTION_APPROVED_AMOUNT as number),
        'the reward config must be readable, not NaN',
      );
    }
  });

  test('a capped reward type pairs its amount key with its own cap key', () => {
    // A mis-paired cap is silent: the admin tunes AI_TRANSLATION_AMOUNT and the
    // cap that gets applied is, say, the correction one. Comparing prefixes
    // catches that copy-paste bug without hardcoding today's table.
    const capped = TUNABLE_REWARD_TYPES.filter((r) => r.dailyCapKey);
    assert.ok(capped.length > 0, 'at least some rewards are capped, or the check is vacuous');
    for (const reward of capped) {
      assert.ok(reward.amountKey, `${reward.type} declares a cap but no amount to cap`);
      assert.ok(
        reward.dailyCapKey!.startsWith(reward.type),
        `${reward.type} is capped by ${reward.dailyCapKey}, which belongs to a different reward`,
      );
    }
  });

  test('challenge rewards are outside the capped earn set', () => {
    // Challenge awards go through the CHALLENGE sourceType and are not subject
    // to the per-day earn caps, which is why a 30 GT challenge pays in full
    // despite CORRECTION_DAILY_CAP being 10. Lock that intent down so a future
    // "let's cap challenges too" change is a deliberate edit, not a silent one.
    const challengeTypes = new Set<string>(CHALLENGE_TEMPLATES.map((t) => t.type));
    for (const reward of TUNABLE_REWARD_TYPES) {
      assert.ok(!challengeTypes.has(reward.type), `${reward.type} is a challenge type and must not be a capped earn type`);
    }
  });
});
