import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { awardTokens } from '../src/services/tokenService';
import { getLeaderboard, getMyRank, isLeaderboardPeriod, isLeaderboardScope } from '../src/services/leaderboardService';
import { createUser, cleanupUser, uid } from './helpers';

describe('leaderboardService', () => {
  let userA: Awaited<ReturnType<typeof createUser>>;
  let userB: Awaited<ReturnType<typeof createUser>>;
  let artistId: string;
  let songId: string;

  before(async () => {
    userA = await createUser();
    userB = await createUser();
    const artist = await prisma.artist.create({ data: { name: `R3 Lb Artist ${uid()}` } });
    artistId = artist.id;
    songId = (
      await prisma.song.create({ data: { title: `R3 Lb Song ${uid()}`, artistId } })
    ).id;
  });

  after(async () => {
    await prisma.song.deleteMany({ where: { id: songId } });
    await prisma.artist.deleteMany({ where: { id: artistId } });
    await cleanupUser(userA.id);
    await cleanupUser(userB.id);
  });

  test('period guards reject invalid values', () => {
    assert.equal(isLeaderboardPeriod('all'), true);
    assert.equal(isLeaderboardPeriod('week'), true);
    assert.equal(isLeaderboardPeriod('month'), true);
    assert.equal(isLeaderboardPeriod('year'), false);
    assert.equal(isLeaderboardScope('tokens'), true);
    assert.equal(isLeaderboardScope('quality'), true);
    assert.equal(isLeaderboardScope('x'), false);
  });

  test('token scope sums EARN rows and ranks by total', async () => {
    await awardTokens({ userId: userA.id, type: 'EARN', amount: 40, reason: 'lb test', sourceType: 'TEST', sourceId: uid() });
    await awardTokens({ userId: userB.id, type: 'EARN', amount: 20, reason: 'lb test', sourceType: 'TEST', sourceId: uid() });

    const { entries } = await getLeaderboard('all', 100, 'tokens');
    const a = entries.find((e) => e.userId === userA.id);
    const b = entries.find((e) => e.userId === userB.id);
    assert.equal(a?.totalTokens, 40);
    assert.equal(b?.totalTokens, 20);
    assert.ok(a && b && a.rank < b.rank);

    const mine = await getMyRank('all', userA.id, 'tokens');
    assert.equal(mine.rank, a?.rank);
    assert.equal(mine.totalTokens, 40);
  });

  test('period filters constrain the window', async () => {
    const all = await getLeaderboard('all', 100);
    const week = await getLeaderboard('week', 100);
    const month = await getLeaderboard('month', 100);
    const a = all.entries.find((e) => e.userId === userA.id);
    assert.ok(a);
    assert.ok(week.entries.find((e) => e.userId === userA.id));
    assert.ok(month.entries.find((e) => e.userId === userA.id));
  });

  test('quality scope ranks APPROVED translation counts', async () => {
    const LANGS = ['fr', 'es', 'sw', 'pt', 'ar'];
    let seq = 0;
    const mk = (userId: string, approvedAt: Date) => {
      const target = LANGS[seq % LANGS.length];
      seq += 1;
      return prisma.translation.create({
        data: {
          songId,
          userId,
          originalLyrics: 'x',
          translatedLyrics: 'y',
          sourceLang: 'en',
          targetLang: target,
          status: 'APPROVED',
          approvedAt,
        },
      });
    };
    await mk(userA.id, new Date());
    await mk(userA.id, new Date());
    await mk(userB.id, new Date());

    const { entries } = await getLeaderboard('all', 100, 'quality');
    const a = entries.find((e) => e.userId === userA.id);
    const b = entries.find((e) => e.userId === userB.id);
    assert.equal(a?.approvedCount, 2);
    assert.equal(b?.approvedCount, 1);
    assert.ok(a && b && a.rank < b.rank);

    const mine = await getMyRank('all', userB.id, 'quality');
    assert.equal(mine.approvedCount, 1);
  });

  test('limit is clamped to 1..200', async () => {
    const zero = await getLeaderboard('all', 0);
    const huge = await getLeaderboard('all', 10_000);
    assert.ok(zero.entries.length <= 1);
    assert.ok(huge.entries.length <= 200);
  });
});
