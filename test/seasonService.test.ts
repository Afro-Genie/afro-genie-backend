import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { freezeSeason, getSeason, getSeasons, periodKeyOf } from '../src/services/seasonService';
import { REWARD_CONFIG } from '../src/config/rewards';
import { createUser, cleanupUser, uid } from './helpers';

const PERIOD = '1999-07';
const FREEZE_DATE = new Date(Date.UTC(1999, 6, 15));

describe('seasonService', () => {
  let a: Awaited<ReturnType<typeof createUser>>;
  let b: Awaited<ReturnType<typeof createUser>>;

  before(async () => {
    a = await createUser();
    b = await createUser();

    const janStart = Date.UTC(1999, 6, 1);
    const janEnd = Date.UTC(1999, 7, 1);
    const rows = [
      { userId: a.id, amount: 90, createdAt: new Date(janStart + 1000) },
      { userId: b.id, amount: 45, createdAt: new Date(janStart + 2000) },
    ];
    await prisma.tokenLedger.createMany({
      data: rows.map((r, i) => ({
        userId: r.userId,
        type: 'EARN' as const,
        amount: r.amount,
        balanceAfter: r.amount,
        reason: 'season test seed',
        sourceType: 'SEASON_TEST' as const,
        sourceId: `season-test-${uid()}`,
        idempotencyKey: `season-test-${uid()}`,
        createdAt: r.createdAt,
      })),
    });
  });

  after(async () => {
    await prisma.seasonalSnapshot.deleteMany({ where: { period: PERIOD } });
    await cleanupUser(b.id);
    await cleanupUser(a.id);
  });

  test('periodKeyOf formats UTC YYYY-MM', () => {
    assert.equal(periodKeyOf(new Date(Date.UTC(2024, 0, 1))), '2024-01');
    assert.equal(periodKeyOf(new Date(Date.UTC(2024, 11, 31))), '2024-12');
  });

  test('freezeSeason snapshots the period and rewards the top 3', async () => {
    const snapshot = await freezeSeason(FREEZE_DATE);
    assert.equal(snapshot.period, PERIOD);

    const data = snapshot.data as Record<string, unknown>;
    const entries = data.entries as Array<{ userId: string; totalTokens: number }>;
    assert.ok(entries.some((e) => e.userId === a.id && e.totalTokens === 90));
    assert.ok(entries.some((e) => e.userId === b.id && e.totalTokens === 45));

    const bonusRows = await prisma.tokenLedger.findMany({
      where: { sourceType: 'SEASON_BONUS', sourceId: PERIOD },
    });
    const byUser = new Map(bonusRows.map((r) => [r.userId, r.amount]));
    assert.equal(byUser.get(a.id), REWARD_CONFIG.SEASON_TOP3_BONUS[0]);
    assert.equal(byUser.get(b.id), REWARD_CONFIG.SEASON_TOP3_BONUS[1]);

    const champBadges = await prisma.userBadge.count({
      where: { badgeType: 'SEASON_CHAMPION' },
    });
    assert.ok(champBadges >= 2);
  });

  test('re-freezing the same period is idempotent (no double pay)', async () => {
    const again = await freezeSeason(FREEZE_DATE);
    const first = await prisma.seasonalSnapshot.findUnique({ where: { period: PERIOD } });
    assert.equal(again.id, first?.id);

    const bonusRows = await prisma.tokenLedger.findMany({
      where: { sourceType: 'SEASON_BONUS', sourceId: PERIOD },
    });
    const byUser = new Map(bonusRows.map((r) => [r.userId, r.amount]));
    assert.equal(byUser.get(a.id), REWARD_CONFIG.SEASON_TOP3_BONUS[0]);
  });

  test('getSeasons lists the frozen period and getSeason returns it', async () => {
    const seasons = await getSeasons();
    assert.ok(seasons.some((s) => s.period === PERIOD));
    const byId = await getSeason(seasons.find((s) => s.period === PERIOD)!.id);
    assert.equal(byId.period, PERIOD);
  });
});
