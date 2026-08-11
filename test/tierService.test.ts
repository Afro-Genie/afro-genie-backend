import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { recomputeTier, getTier, getMultiplier } from '../src/services/tierService';
import { resolveTier, TIER_CONFIG } from '../src/config/rewards';
import { createUser, cleanupUser, uid } from './helpers';

describe('tierService', () => {
  let userId: string;
  let songId: string;

  before(async () => {
    userId = (await createUser()).id;
    const artist = await prisma.artist.create({
      data: { name: `R3 Tier Artist ${uid()}` },
    });
    songId = (
      await prisma.song.create({
        data: { title: `R3 Tier Song ${uid()}`, artistId: artist.id },
      })
    ).id;
  });

  after(async () => {
    await prisma.song.deleteMany({ where: { id: songId } });
    await prisma.artist.deleteMany({ where: { songs: { none: {} } } });
    await cleanupUser(userId);
  });

  const LANGS = ['fr', 'es', 'sw', 'pt', 'ar', 'yo', 'ig', 'am', 'ha', 'zu'];
  let translationSeq = 0;
  const makeTranslation = async (status: string) => {
    const target = LANGS[translationSeq % LANGS.length];
    translationSeq += 1;
    return prisma.translation.create({
      data: {
        songId,
        userId,
        originalLyrics: 'original',
        translatedLyrics: 'translated',
        sourceLang: 'en',
        targetLang: target,
        status: status as any,
      },
    });
  };

  test('resolveTier boundary: 0 -> LISTENER, 5 -> SCRIBE, 50 -> MASTER_TRANSLATOR', () => {
    assert.equal(resolveTier(0).tier, 'LISTENER');
    assert.equal(resolveTier(4).tier, 'LISTENER');
    assert.equal(resolveTier(5).tier, 'SCRIBE');
    assert.equal(resolveTier(49).tier, 'SCRIBE');
    assert.equal(resolveTier(50).tier, 'MASTER_TRANSLATOR');
  });

  test('tier thresholds and multipliers are consistent', () => {
    assert.deepEqual(
      TIER_CONFIG.map((c) => c.tier),
      ['LISTENER', 'SCRIBE', 'MASTER_TRANSLATOR'],
    );
    assert.equal(TIER_CONFIG[0].multiplier, 1);
    assert.ok(TIER_CONFIG[1].multiplier > TIER_CONFIG[0].multiplier);
    assert.ok(TIER_CONFIG[2].multiplier > TIER_CONFIG[1].multiplier);
  });

  test('recomputeTier stores LISTENER for a user with zero approvals', async () => {
    await recomputeTier(userId);
    const tier = await getTier(userId);
    assert.equal(tier.tier, 'LISTENER');
    assert.equal(tier.multiplier, 1);
  });

  test('recomputeTier promotes to SCRIBE at 5 approved translations', async () => {
    for (let i = 0; i < 5; i += 1) await makeTranslation('APPROVED');
    await recomputeTier(userId);
    assert.equal((await getTier(userId)).tier, 'SCRIBE');
    assert.equal(await getMultiplier(userId), 1.2);
  });

  test('pending translations do not count toward tier', async () => {
    await makeTranslation('PENDING');
    await recomputeTier(userId);
    assert.equal((await getTier(userId)).approvedCount, 5);
  });

  test('idempotent recompute does not change existing tier', async () => {
    await recomputeTier(userId);
    await recomputeTier(userId);
    assert.equal((await getTier(userId)).tier, 'SCRIBE');
  });
});
