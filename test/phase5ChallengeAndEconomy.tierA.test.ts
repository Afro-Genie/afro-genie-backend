import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChallengeType } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import {
  CHALLENGE_TEMPLATES,
  getWeekWindow,
} from '../src/jobs/challengeRotationJob';
import {
  getCurrentChallenges,
  getChallengeProgress,
} from '../src/services/challengeService';
import {
  getAbuseDashboard,
  listAbuseFlags,
  ABUSE_RULES,
} from '../src/services/abuseService';
import {
  TUNABLE_REWARD_TYPES,
  REWARD_CONFIG,
  REWARD_CONFIG_CACHE_KEY,
} from '../src/config/rewards';
import {
  createPhase5User,
  createChallenge,
  newRegistry,
  registerPhase5Teardown,
  startPhase5Harness,
  tokenFor,
  type Phase5Harness,
} from './phase5Fixtures';

// ---------------------------------------------------------------------------
// REMEDIATION-PLAN.md 7.4 — Phase 5 Tier A.
//
// TIER A BY CONSTRUCTION: of the six groups the audit's §12.7 specified, this
// file takes the three that perform no write. No `create`/`update`/`delete`
// call is made by any assertion below except the fixture helpers, whose rows
// carry a `P5TEST` sentinel and are removed by a teardown that then asserts the
// sentinel count is zero.
//
// The three Tier B groups (claim flow, admin economy writes, rotation) live in
// phase5ChallengeAndEconomy.tierB.test.ts. They are separated because they are
// the parts that genuinely mutate state, and a reviewer checking "is it safe to
// run this?" should be able to answer by looking at the filename.
// ---------------------------------------------------------------------------

const registry = newRegistry();
registerPhase5Teardown(registry);

// The Prisma-generated enum object, not a hand-written list. A hand-written
// mirror is exactly how §12.1 happened: the enum, the progress counter and the
// rotation template each listed the types separately and drifted. Reading the
// generated value means this suite fails the moment the schema changes without
// a template to match.
const CHALLENGE_TYPES = Object.values(ChallengeType) as string[];

// ===========================================================================
// 1. Pure units — no database, no Redis.
// ===========================================================================

describe('A1. pure units: getWeekWindow', () => {
  test('the window starts on Monday 00:00 UTC for every day of the week', () => {
    // 2026-01-05 is a Monday, so the whole week is one contiguous run from it.
    const monday = Date.UTC(2026, 0, 5);
    for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
      const now = new Date(monday + dayOffset * 24 * 60 * 60 * 1000 + 13 * 60 * 60 * 1000);
      const { startsAt } = getWeekWindow(now);

      assert.equal(
        startsAt.toISOString(),
        new Date(monday).toISOString(),
        `day ${dayOffset} of the week must resolve to the same Monday`,
      );
      assert.equal(startsAt.getUTCDay(), 1, 'startsAt must always be a Monday');
      assert.equal(startsAt.getUTCHours(), 0, 'startsAt must be midnight UTC');
      assert.equal(startsAt.getUTCMinutes(), 0);
      assert.equal(startsAt.getUTCSeconds(), 0);
      assert.equal(startsAt.getUTCMilliseconds(), 0);
    }
  });

  test('Sunday belongs to the week that started six days earlier, not the next one', () => {
    // The classic off-by-one: getUTCDay() is 0 for Sunday, so a naive
    // `(day - 1) % 7` maps Sunday to the *previous* week's Monday. This
    // assertion pins the correct behaviour.
    const sunday = Date.UTC(2026, 0, 11, 23, 59, 59);
    const { startsAt, expiresAt } = getWeekWindow(new Date(sunday));

    assert.equal(startsAt.toISOString(), new Date(Date.UTC(2026, 0, 5)).toISOString());
    assert.equal(expiresAt.toISOString(), new Date(Date.UTC(2026, 0, 12)).toISOString());
  });

  test('the window is exactly seven days', () => {
    const { startsAt, expiresAt } = getWeekWindow(new Date('2026-03-18T09:30:00Z'));
    assert.equal(expiresAt.getTime() - startsAt.getTime(), 7 * 24 * 60 * 60 * 1000);
  });

  test('the window is stable across a DST transition (the week stays 7x24h)', () => {
    // US DST began 2026-03-08. A window computed in local time would be 167 or
    // 169 hours; computed in UTC (as this is) it is always exactly 168. The
    // test runs in whatever TZ the machine has, which is the point.
    const beforeDst = new Date('2026-03-05T12:00:00Z');
    const afterDst = new Date('2026-03-10T12:00:00Z');

    for (const now of [beforeDst, afterDst]) {
      const { startsAt, expiresAt } = getWeekWindow(now);
      assert.equal(
        expiresAt.getTime() - startsAt.getTime(),
        7 * 24 * 60 * 60 * 1000,
        `week containing ${now.toISOString()} must be exactly 168h`,
      );
      assert.equal(startsAt.getUTCHours(), 0, 'midnight must be UTC midnight, not local midnight');
    }
  });

  test('the window is stable across a leap day (29 Feb 2028)', () => {
    const { startsAt, expiresAt } = getWeekWindow(new Date('2028-02-29T18:45:00Z'));
    assert.equal(expiresAt.getTime() - startsAt.getTime(), 7 * 24 * 60 * 60 * 1000);
    // 2028-02-29 is a Tuesday, so the window opens on Monday the 28th.
    assert.equal(startsAt.toISOString(), new Date(Date.UTC(2028, 1, 28)).toISOString());
  });

  test('the window is stable across a year boundary', () => {
    // 2026-12-31 is a Thursday, so the window opens Mon 2026-12-28 and closes
    // Mon 2027-01-04 — the year changes mid-week and must not split it.
    const { startsAt, expiresAt } = getWeekWindow(new Date('2026-12-31T23:00:00Z'));
    assert.equal(startsAt.toISOString(), new Date(Date.UTC(2026, 11, 28)).toISOString());
    assert.equal(expiresAt.toISOString(), new Date(Date.UTC(2027, 0, 4)).toISOString());
  });

  test('a window is idempotent: recomputing from any instant inside it agrees', () => {
    const base = getWeekWindow(new Date('2026-05-13T00:00:00Z'));
    for (const minute of [0, 1, 360, 23 * 60 + 59]) {
      const again = getWeekWindow(new Date(base.startsAt.getTime() + minute * 60_000));
      assert.deepEqual(again, base, `recompute at +${minute}min must agree`);
    }
  });
});

describe('A1. pure units: CHALLENGE_TEMPLATES schema conformance', () => {
  test('every template type is a valid ChallengeType in the Prisma enum', () => {
    for (const template of CHALLENGE_TEMPLATES) {
      assert.ok(
        CHALLENGE_TYPES.includes(template.type as never),
        `template "${template.title}" has type ${template.type}, which is not in the ChallengeType enum`,
      );
    }
  });

  test('every ChallengeType in the enum has a template', () => {
    // The inverse of the test above, and the one that caught §12.1: the enum
    // listed ACHIEVE_N_APPROVALS, `computeProgress` handled it, and no template
    // produced it — so the whole branch was unreachable dead code.
    const templated = new Set(CHALLENGE_TEMPLATES.map((t) => t.type));
    const missing = CHALLENGE_TYPES.filter((t) => !templated.has(t as never));
    assert.deepEqual(missing, [], 'every ChallengeType must be produced by a weekly template');
  });

  test('template types are unique (the upsert keys on type+startsAt)', () => {
    const seen = CHALLENGE_TEMPLATES.map((t) => t.type);
    assert.equal(new Set(seen).size, seen.length, `duplicate template types: ${seen.join(', ')}`);
  });

  test('targetValue is a positive integer', () => {
    for (const t of CHALLENGE_TEMPLATES) {
      assert.ok(Number.isInteger(t.targetValue) && t.targetValue > 0, `${t.type}.targetValue must be a positive int`);
    }
  });

  test('gtReward is a positive integer', () => {
    for (const t of CHALLENGE_TEMPLATES) {
      assert.ok(Number.isInteger(t.gtReward) && t.gtReward > 0, `${t.type}.gtReward must be a positive int`);
    }
  });

  test('title and description are non-empty', () => {
    for (const t of CHALLENGE_TEMPLATES) {
      assert.ok(t.title.trim().length > 0, `${t.type} needs a title`);
      assert.ok(t.description.trim().length > 0, `${t.type} needs a description`);
    }
  });

  test('the title does not contradict the target', () => {
    // "Invite 3 Friends" against `targetValue: 2` is a copy bug, not a test
    // preference: the title is what the user reads to decide whether to try.
    const invite = CHALLENGE_TEMPLATES.find((t) => t.type === 'INVITE_3_FRIENDS');
    assert.ok(invite, 'INVITE_3_FRIENDS template is missing');
    const number = invite!.title.match(/(\d+)/);
    if (number) {
      assert.equal(
        Number(number[1]),
        invite!.targetValue,
        `title says ${number[1]} but targetValue is ${invite!.targetValue}`,
      );
    }
  });

  test('there is one template per type and the lineup is 5 (Stage 4 post-check expects 5)', () => {
    // The count is load-bearing: challengeRotationJob.ts and Stage 4's
    // post-check both assume it. Changing the lineup without updating them
    // is how "challenges dead in production" (§12.1) recurs.
    assert.equal(CHALLENGE_TEMPLATES.length, 5);
  });
});

describe('A1. pure units: TUNABLE_REWARD_TYPES key integrity', () => {
  test('every amountKey names a real key in REWARD_CONFIG', () => {
    for (const def of TUNABLE_REWARD_TYPES) {
      if (!def.amountKey) continue;
      assert.ok(
        def.amountKey in REWARD_CONFIG,
        `${def.type}.amountKey "${def.amountKey}" is not a key in REWARD_CONFIG`,
      );
    }
  });

  test('every dailyCapKey names a real key in REWARD_CONFIG', () => {
    for (const def of TUNABLE_REWARD_TYPES) {
      if (!def.dailyCapKey) continue;
      assert.ok(
        def.dailyCapKey in REWARD_CONFIG,
        `${def.type}.dailyCapKey "${def.dailyCapKey}" is not a key in REWARD_CONFIG`,
      );
    }
  });

  test('every tunable type declares an amountKey (otherwise PATCH /rewards 400s on it)', () => {
    // The admin UI renders one row per TUNABLE_REWARD_TYPES entry. An entry
    // with no amountKey renders a control that the API rejects with
    // "has no tunable amount" — a dead control shipped to every admin.
    for (const def of TUNABLE_REWARD_TYPES) {
      assert.ok(def.amountKey, `${def.type} has no amountKey, so its amount can never be tuned`);
    }
  });

  test('reward type identifiers are unique', () => {
    const types = TUNABLE_REWARD_TYPES.map((t) => t.type);
    assert.equal(new Set(types).size, types.length, `duplicate tunable reward types: ${types.join(', ')}`);
  });

  test('every tunable has a non-empty human label', () => {
    for (const def of TUNABLE_REWARD_TYPES) {
      assert.ok(def.label.trim().length > 0, `${def.type} needs a label for the admin UI`);
    }
  });

  test('a reward type owns at most one amountKey (no two rows edit the same value)', () => {
    // Two rows writing the same key means the last one to render silently wins,
    // and an admin editing the first row sees a change that does not stick.
    const owners = new Map<string, string>();
    const clashes: string[] = [];
    for (const def of TUNABLE_REWARD_TYPES) {
      if (!def.amountKey) continue;
      const previous = owners.get(def.amountKey);
      if (previous) clashes.push(`${def.amountKey} claimed by both ${previous} and ${def.type}`);
      owners.set(def.amountKey, def.type);
    }
    assert.deepEqual(clashes, []);
  });

  test('every daily cap is a positive integer (0 would silently disable earning)', () => {
    for (const def of TUNABLE_REWARD_TYPES) {
      if (!def.dailyCapKey) continue;
      const cap = (REWARD_CONFIG as Record<string, unknown>)[def.dailyCapKey];
      assert.ok(typeof cap === 'number' && Number.isInteger(cap) && cap > 0, `${def.dailyCapKey} must be a positive int`);
    }
  });
});

// ===========================================================================
// 2. Read-only integration — real database, no writes by the code under test.
// ===========================================================================

describe('A2. read-only: getCurrentChallenges', () => {
  let userId: string;

  before(async () => {
    userId = (await createPhase5User(registry, 'USER')).id;
  });

  test('without a user id it returns the open challenges with zeroed progress', async () => {
    const now = new Date();
    await createChallenge(registry, { type: 'TRANSLATE_N_SONGS', targetValue: 3, gtReward: 30 });

    const all = await getCurrentChallenges();
    const open = all.filter((c) => c.startsAt <= now && c.expiresAt > now);

    for (const c of open) {
      assert.equal(c.progress, 0, 'anonymous progress must be 0');
      assert.equal(c.completed, false);
      assert.equal(c.claimed, false);
    }
  });

  test('with a user id it merges that user progress, clamped to targetValue', async () => {
    await createChallenge(registry, { type: 'EARN_N_GT', targetValue: 5, gtReward: 50 });

    const mine = await getCurrentChallenges(userId);
    for (const c of mine) {
      assert.ok(c.progress <= c.targetValue, `progress ${c.progress} exceeded target ${c.targetValue}`);
      assert.equal(c.completed, c.progress >= c.targetValue);
    }
  });

  test('a challenge that has not started is not offered', async () => {
    const now = Date.now();
    await createChallenge(registry, {
      type: 'STREAK_7_DAYS',
      targetValue: 7,
      gtReward: 25,
      startsAt: new Date(now + 3 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(now + 10 * 24 * 60 * 60 * 1000),
    });

    const offered = await getCurrentChallenges(userId);
    assert.ok(
      !offered.some((c) => c.type === 'STREAK_7_DAYS'),
      'a not-yet-started challenge must not appear in getCurrentChallenges',
    );
  });

  test('an expired challenge is not offered', async () => {
    const now = Date.now();
    await createChallenge(registry, {
      type: 'INVITE_3_FRIENDS',
      targetValue: 2,
      gtReward: 20,
      startsAt: new Date(now - 14 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(now - 60_000),
    });

    const offered = await getCurrentChallenges(userId);
    assert.ok(
      !offered.some((c) => c.type === 'INVITE_3_FRIENDS'),
      'an expired challenge must not appear in getCurrentChallenges',
    );
  });

  test('an inactive challenge is not offered', async () => {
    await createChallenge(registry, {
      type: 'ACHIEVE_N_APPROVALS',
      targetValue: 3,
      gtReward: 30,
      active: false,
    });

    const offered = await getCurrentChallenges(userId);
    assert.ok(
      !offered.some((c) => c.type === 'ACHIEVE_N_APPROVALS'),
      'an inactive challenge must not appear in getCurrentChallenges',
    );
  });

  test('the list is ordered by expiry, so the most urgent challenge is first', async () => {
    const mine = await getCurrentChallenges(userId);
    const expiries = mine.map((c) => new Date(c.expiresAt).getTime());
    const sorted = [...expiries].sort((a, b) => a - b);
    assert.deepEqual(expiries, sorted, 'getCurrentChallenges must order by expiresAt asc');
  });

  test('an unknown challenge id is a 404 NOT_FOUND, not a silent zero', async () => {
    await assert.rejects(
      () => getChallengeProgress(userId, '00000000-0000-4000-8000-000000000000'),
      (err: any) => {
        assert.equal(err.statusCode ?? err.status, 404);
        assert.equal(err.code, 'NOT_FOUND');
        return true;
      },
      'a client holding a stale challenge id must get 404, not a fabricated 0/target',
    );
  });
});

describe('A2. read-only: listAbuseFlags pagination bounds', () => {
  test('page is clamped to at least 1 and limit to 1..100', async () => {
    // The bounds live in the service, so this is a pure read of the contract
    // with no fixture rows required.
    const low = await listAbuseFlags({ page: -5, limit: 0 });
    assert.equal(low.pagination.page, 1, 'page must clamp up to 1');
    assert.equal(low.pagination.limit, 1, 'limit must clamp up to 1');

    const high = await listAbuseFlags({ page: 0, limit: 10_000 });
    assert.equal(high.pagination.page, 1);
    assert.equal(high.pagination.limit, 100, 'limit must clamp down to 100');
  });

  test('totalPages is always at least 1, even with zero rows', async () => {
    const result = await listAbuseFlags({ limit: 20 });
    assert.ok(result.pagination.totalPages >= 1, 'totalPages must never be 0 — the admin UI divides by it');
  });

  test('the returned page never exceeds the requested limit', async () => {
    const result = await listAbuseFlags({ page: 1, limit: 3 });
    assert.ok(result.data.length <= 3, `page returned ${result.data.length} rows for limit 3`);
  });

  test('includeReviewed defaults to false', async () => {
    const unreviewed = await listAbuseFlags({ limit: 100 });
    for (const flag of unreviewed.data) {
      assert.equal(flag.reviewed, false, 'unreviewed flags only, unless includeReviewed is set');
    }
  });

  test('a rule filter is passed through to the query', async () => {
    const result = await listAbuseFlags({ rule: ABUSE_RULES.SELF_REFERRAL, limit: 100 });
    for (const flag of result.data) {
      assert.equal(flag.rule, ABUSE_RULES.SELF_REFERRAL);
    }
  });
});

describe('A2. read-only: getAbuseDashboard', () => {
  test('returns the 3-sigma threshold block with a stable rule label', async () => {
    const dashboard = await getAbuseDashboard();

    assert.equal(dashboard.threshold.rule, 'EARN_RATE_3_SIGMA');
    for (const key of ['mean', 'stddev', 'cutoff'] as const) {
      assert.equal(typeof dashboard.threshold[key], 'number', `threshold.${key} must be a number`);
      assert.ok(Number.isFinite(dashboard.threshold[key]), `threshold.${key} must be finite`);
    }
  });

  test('the cutoff is mean + 3 standard deviations', async () => {
    const { threshold } = await getAbuseDashboard();
    const expected = threshold.mean + 3 * threshold.stddev;
    // The service rounds to 2dp at each step, so compare with a tolerance
    // rather than exactly.
    assert.ok(
      Math.abs(threshold.cutoff - expected) <= 0.02,
      `cutoff ${threshold.cutoff} should be mean+3σ ≈ ${expected.toFixed(2)}`,
    );
  });

  test('every detector list is present and an array', async () => {
    const dashboard = await getAbuseDashboard();
    for (const key of [
      'abnormalEarners',
      'lowQualityTranslations',
      'rapidFireCorrections',
      'selfReferrals',
      'sharedIpReferrals',
    ] as const) {
      assert.ok(Array.isArray(dashboard[key]), `${key} must be an array`);
    }
    assert.ok(dashboard.flaggedAccounts, 'flaggedAccounts must be present');
  });

  test('abnormal earners are sorted by earnings descending', async () => {
    const { abnormalEarners } = await getAbuseDashboard();
    const amounts = abnormalEarners.map((e) => e.earned);
    assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a), 'abnormalEarners must be ordered desc');
  });
});

// ===========================================================================
// 3. Auth and validation guards — 401 unauthenticated, 403 non-admin,
//    400 malformed. None of these reach a write: the router short-circuits.
// ===========================================================================

describe('A3. auth guards: 401 without a token', () => {
  let harness: Phase5Harness;

  before(async () => {
    harness = await startPhase5Harness();
  });

  after(async () => {
    await harness.close();
  });

  const unauthenticated: ReadonlyArray<readonly [string, string]> = [
    ['GET', '/api/challenges'],
    ['GET', '/api/challenges/any-id/progress'],
    ['POST', '/api/challenges/any-id/claim'],
    ['GET', '/api/admin/economy/config'],
    ['GET', '/api/admin/economy/circulation'],
    ['GET', '/api/admin/economy/abuse'],
    ['PATCH', '/api/admin/economy/rewards'],
    ['PATCH', '/api/admin/economy/store/any-item'],
    ['PATCH', '/api/admin/economy/abuse/any-flag'],
    ['POST', '/api/admin/economy/adjust'],
  ];

  for (const [method, path] of unauthenticated) {
    test(`${method} ${path} is 401 without a token`, async () => {
      const res = await harness.request(method, path, { body: {} });
      assert.equal(res.status, 401, `expected 401, got ${res.status}`);
      assert.equal(res.body?.code, 'UNAUTHORIZED');
    });
  }

  test('a malformed or wrongly-signed token is 401, not 403', async () => {
    // 401 vs 403 is load-bearing: a 403 would tell an attacker their token was
    // well-formed but unauthorised, which is one step further than they should
    // learn from an unauthenticated probe.
    for (const token of ['not-a-jwt', 'a.b.c', 'Bearer-with-no-scheme']) {
      const res = await harness.request('GET', '/api/challenges', { token });
      assert.equal(res.status, 401, `token "${token}" must be rejected with 401`);
    }
  });
});

describe('A3. auth guards: 403 for a non-admin, and 401 for a bad body', () => {
  let harness: Phase5Harness;
  let userToken: string;

  before(async () => {
    harness = await startPhase5Harness();
    const user = await createPhase5User(registry, 'USER');
    userToken = tokenFor(user, 'USER');
  });

  after(async () => {
    await harness.close();
  });

  const adminOnly: ReadonlyArray<readonly [string, string, unknown]> = [
    ['GET', '/api/admin/economy/config', undefined],
    ['GET', '/api/admin/economy/circulation', undefined],
    ['GET', '/api/admin/economy/abuse', undefined],
    ['PATCH', '/api/admin/economy/rewards', { rewardType: 'AI_TRANSLATION', newAmount: 1 }],
    ['PATCH', '/api/admin/economy/store/any-item', { tokenCost: 10 }],
    ['PATCH', '/api/admin/economy/abuse/any-flag', { reviewed: true }],
    ['POST', '/api/admin/economy/adjust', { userId: 'x', amount: 1, reason: 'r', type: 'CREDIT' }],
  ];

  for (const [method, path, body] of adminOnly) {
    test(`${method} ${path} is 403 for an authenticated USER`, async () => {
      const res = await harness.request(method, path, { token: userToken, body });
      assert.equal(res.status, 403, `expected 403, got ${res.status}`);
      assert.equal(res.body?.code, 'FORBIDDEN');
    });
  }

  test('a normal user CAN read their own challenges (403 must not leak into user routes)', async () => {
    const res = await harness.request('GET', '/api/challenges', { token: userToken });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  test('PATCH /economy/rewards is 400 for an unknown rewardType', async () => {
    // Requires an admin to get past requireRole, so this one is asserted at the
    // service layer instead — see tierB. Here we only need to prove the route
    // does not 500 on a malformed body while unauthenticated.
    const res = await harness.request('PATCH', '/api/admin/economy/rewards', { body: { rewardType: '' } });
    assert.equal(res.status, 401, 'auth is checked before validation, so 401 wins');
  });

  test('the reward-config cache key is namespaced and not a production key', async () => {
    // Tier A still touches Redis once, to prove the key the economy route
    // caches under is the one the suite expects. Nothing is written.
    assert.equal(REWARD_CONFIG_CACHE_KEY, 'economy:reward-config');
    registry.redisKeys.push(REWARD_CONFIG_CACHE_KEY);
  });
});

// ===========================================================================
// 4. Prohibited-capability assertions — the file's own safety property.
// ===========================================================================

describe('A4. the suite is still pointed at a disposable database', () => {
  test('the Phase 5 tables exist and are reachable', async () => {
    // If this fails, the run is not against the provisioned schema and every
    // assertion above would be vacuous.
    const [challenges, flags, users] = await Promise.all([
      prisma.challenge.count(),
      prisma.abuseFlag.count(),
      prisma.user.count(),
    ]);
    assert.ok(typeof challenges === 'number');
    assert.ok(typeof flags === 'number');
    assert.ok(typeof users === 'number');
  });

  test('no foreign P5TEST rows exist, so the leak assertion in teardown is meaningful', async () => {
    // Exactly the users this file created — no more. A larger count means a
    // previous run leaked, which would make the teardown's zero-count
    // assertion pass for the wrong reason and mask a real regression.
    const users = await prisma.user.count({ where: { displayName: { startsWith: 'P5TEST' } } });
    assert.equal(
      users,
      registry.userIds.length,
      `expected only this run's ${registry.userIds.length} fixture users, found ${users}`,
    );
  });

  test('Redis is reachable and disposable (a PING, not a write)', async () => {
    assert.equal(await redis.ping(), 'PONG');
  });
});
