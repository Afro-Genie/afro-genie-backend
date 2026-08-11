import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { ApiError } from '../src/middleware/errorHandler';
import {
  adjustTokens,
  awardTokens,
  getBalance,
  getLedger,
  getProfile,
  spendTokens,
} from '../src/services/tokenService';
import { getMultiplier, recomputeTier } from '../src/services/tierService';
import { recordLogin } from '../src/services/streakService';
import { getLeaderboard, getMyRank } from '../src/services/leaderboardService';
import { approveTranslation, reviewCorrection, submitCorrection } from '../src/services/reviewService';
import { onAiTranslationCompleted, onTopicShare } from '../src/services/rewardHooks';
import { communityService } from '../src/services/communityService';

type Result = { name: string; pass: boolean; details: string };
const results: Result[] = [];
const addResult = (name: string, pass: boolean, details: string) => {
  results.push({ name, pass, details });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} :: ${details}`);
};

const seed = Date.now();
const ids: Record<string, string> = {};

const cleanup = async () => {
  try {
    for (const key of Object.keys(ids)) {
      if (key.startsWith('user')) {
        await prisma.user.delete({ where: { id: ids[key] } }).catch(() => undefined);
      }
    }
    for (const key of Object.keys(ids)) {
      if (key.startsWith('song')) {
        await prisma.song.delete({ where: { id: ids[key] } }).catch(() => undefined);
      }
    }
    if (ids.artist) await prisma.artist.delete({ where: { id: ids.artist } }).catch(() => undefined);
  } catch (err) {
    console.log('cleanup error (non-fatal):', err);
  }
};

const expectThrows = async (fn: () => Promise<unknown>, code: string): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch (err) {
    return err instanceof ApiError && err.code === code;
  }
};

const main = async () => {
  try {
    // ── Seed ──────────────────────────────────────────────────
    const contributor = await prisma.user.create({ data: { email: `p1_contrib_${seed}@example.com`, displayName: 'P1 Contributor' } });
    const moderator = await prisma.user.create({ data: { email: `p1_mod_${seed}@example.com`, displayName: 'P1 Moderator', role: 'MODERATOR' } });
    const user2 = await prisma.user.create({ data: { email: `p1_u2_${seed}@example.com`, displayName: 'P1 User2' } });
    ids.userContrib = contributor.id;
    ids.userMod = moderator.id;
    ids.user2 = user2.id;

    const artist = await prisma.artist.create({ data: { name: `P1 Artist ${seed}` } });
    ids.artist = artist.id;

    // ── Core ledger ───────────────────────────────────────────
    await awardTokens({ userId: contributor.id, type: 'EARN', amount: 10, reason: 'Test earn', sourceType: 'TEST', sourceId: 'a1', idempotencyKey: 'verify:a1' });
    const bal1 = await getBalance(contributor.id);
    addResult('award EARN +10 updates balance', bal1 === 10, `balance=${bal1}`);

    const dup = await awardTokens({ userId: contributor.id, type: 'EARN', amount: 10, reason: 'Test earn', sourceType: 'TEST', sourceId: 'a1', idempotencyKey: 'verify:a1' });
    const balAfterDup = await getBalance(contributor.id);
    const ledgerCount = await prisma.tokenLedger.count({ where: { userId: contributor.id, idempotencyKey: 'verify:a1' } });
    addResult('idempotency: replay same key = single ledger row', ledgerCount === 1 && balAfterDup === 10, `rows=${ledgerCount} balance=${balAfterDup} dupId=${dup.id}`);

    const insufficient = await expectThrows(
      () => spendTokens({ userId: contributor.id, amount: -999, reason: 'x', sourceType: 'TEST', sourceId: 'spend', idempotencyKey: 'verify:spend' }),
      'INSUFFICIENT_FUNDS',
    );
    addResult('spend with insufficient balance rejected', insufficient, '');

    await spendTokens({ userId: contributor.id, amount: -4, reason: 'Test spend', sourceType: 'TEST', sourceId: 'a2', idempotencyKey: 'verify:a2' });
    const bal3 = await getBalance(contributor.id);
    addResult('spend -4', bal3 === 6, `balance=${bal3}`);

    await adjustTokens({ userId: contributor.id, amount: -3, reason: 'Admin deduction' });
    const bal4 = await getBalance(contributor.id);
    addResult('admin adjust -3', bal4 === 3, `balance=${bal4}`);

    const ledger = await getLedger(contributor.id, 1, 2);
    addResult('getLedger pagination shape', ledger.rewards.length === 2 && ledger.pagination.total === 3 && ledger.pagination.totalPages === 2, JSON.stringify(ledger.pagination));

    const profile = await getProfile(contributor.id);
    addResult('getProfile aggregates balance/badges/memberSince', profile.tokenBalance === 3 && Array.isArray(profile.badges) && !!profile.memberSince, `balance=${profile.tokenBalance} badges=${profile.badges.length}`);

    const notFound = await expectThrows(() => getProfile('does-not-exist'), 'NOT_FOUND');
    addResult('getProfile unknown user -> 404', notFound, '');

    // ── Tiers ─────────────────────────────────────────────────
    const songIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const s = await prisma.song.create({ data: { title: `P1 Song ${seed} ${i}`, artistId: artist.id } });
      songIds.push(s.id);
      await prisma.lyric.create({ data: { songId: s.id, content: `lyrics ${i}`, sourceProvider: 'MANUAL', licenseStatus: 'UNKNOWN' } });
      await prisma.translation.create({
        data: { songId: s.id, userId: contributor.id, originalLyrics: `lyrics ${i}`, translatedLyrics: `traduccion ${i}`, sourceLang: 'es', targetLang: `sw${i}`, status: 'APPROVED' },
      });
    }
    ids.songs = songIds;
    const tier = await recomputeTier(contributor.id);
    addResult('tier recompute: 5 approved -> SCRIBE 1.2x', tier.tier === 'SCRIBE' && tier.multiplier === 1.2 && tier.approvedCount === 5, JSON.stringify({ tier: tier.tier, mult: tier.multiplier, count: tier.approvedCount }));
    addResult('getMultiplier honors tier', (await getMultiplier(contributor.id)) === 1.2, `mult=${await getMultiplier(contributor.id)}`);

    // ── Streaks ───────────────────────────────────────────────
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.userStreak.upsert({
      where: { userId: user2.id },
      update: { currentStreak: 1, longestStreak: 1, lastLoginDate: yesterday },
      create: { userId: user2.id, currentStreak: 1, longestStreak: 1, lastLoginDate: yesterday },
    });
    await recordLogin(user2.id);
    const streak = await prisma.userStreak.findUnique({ where: { userId: user2.id } });
    const todayKey = new Date().toISOString().slice(0, 10);
    const loginAward = await prisma.tokenLedger.findUnique({ where: { idempotencyKey: `login:${user2.id}:${todayKey}` } });
    const bonusAward = await prisma.tokenLedger.findUnique({ where: { idempotencyKey: `login-bonus:${user2.id}:${todayKey}` } });
    addResult('streak: login after yesterday -> streak 2', streak?.currentStreak === 2, `streak=${streak?.currentStreak}`);
    addResult('streak: daily login +1 awarded', loginAward?.amount === 1, `amount=${loginAward?.amount}`);
    addResult('streak: bonus +5 awarded', bonusAward?.amount === 5, `amount=${bonusAward?.amount}`);

    await recordLogin(user2.id);
    const streakAgain = await prisma.userStreak.findUnique({ where: { userId: user2.id } });
    const loginRows = await prisma.tokenLedger.count({ where: { idempotencyKey: `login:${user2.id}:${todayKey}` } });
    addResult('streak: same-day re-login is a no-op', streakAgain?.currentStreak === 2 && loginRows === 1, `streak=${streakAgain?.currentStreak} rows=${loginRows}`);

    // ── Reward hooks (events) ─────────────────────────────────
    const song = await prisma.song.create({ data: { title: `P1 Hook Song ${seed}`, artistId: artist.id } });
    ids.songHook = song.id;
    await prisma.lyric.create({ data: { songId: song.id, content: 'hook lyrics', sourceProvider: 'MANUAL', licenseStatus: 'UNKNOWN' } });
    const translation = await prisma.translation.create({
      data: { songId: song.id, userId: contributor.id, originalLyrics: 'hook lyrics', translatedLyrics: 'traduccion hook', sourceLang: 'es', targetLang: 'sw', status: 'PENDING' },
    });
    ids.translation = translation.id;

    // AI trigger reward
    await onAiTranslationCompleted({ jobId: `verify-job-${seed}`, userId: user2.id });
    await onAiTranslationCompleted({ jobId: `verify-job-${seed}`, userId: user2.id });
    const aiRows = await prisma.tokenLedger.count({ where: { idempotencyKey: `ai-trigger:verify-job-${seed}` } });
    addResult('AI trigger +2, replay no double-award', aiRows === 1, `rows=${aiRows}`);

    // Translation approval: moderator +10, contributor tier recomputed
    await approveTranslation(translation.id, moderator.id);
    const modApproval = await prisma.tokenLedger.findUnique({ where: { idempotencyKey: `translation-approved:${translation.id}:${moderator.id}` } });
    const contributorTier = await prisma.userTier.findUnique({ where: { userId: contributor.id } });
    addResult('translation approval: moderator +10', modApproval?.amount === 10, `amount=${modApproval?.amount}`);
    addResult('translation approval: contributor tier recomputed', (contributorTier?.approvedCount ?? 0) >= 5, `approvedCount=${contributorTier?.approvedCount}`);

    // Correction approved: author +20 × tier (SCRIBE 1.2) = 24
    await prisma.userTier.upsert({
      where: { userId: user2.id },
      update: { tier: 'SCRIBE', multiplier: 1.2, approvedCount: 5 },
      create: { userId: user2.id, tier: 'SCRIBE', multiplier: 1.2, approvedCount: 5 },
    });
    const correction = await submitCorrection({ translationId: translation.id, userId: user2.id, suggestedText: 'Una correccion sustancialmente diferente para ganar tokens aqui', reason: 'mejora' });
    await reviewCorrection((correction as { id: string }).id, 'APPROVED', moderator.id);
    const corrAward = await prisma.tokenLedger.findUnique({ where: { idempotencyKey: `correction:${(correction as { id: string }).id}` } });
    addResult('correction approved: author +20 × tier', corrAward?.amount === 24, `amount=${corrAward?.amount}`);

    // Topic share reward
    const forumCategory = await prisma.forumCategory.create({ data: { name: `P1 Cat ${seed}` } });
    ids.category = forumCategory.id;
    const topic = await prisma.topic.create({ data: { title: `P1 Topic ${seed}`, content: 'content', authorId: user2.id, category: 'GENERAL', forumCategoryId: forumCategory.id } });
    ids.topic = topic.id;
    await communityService.shareTopic(topic.id, user2.id);
    const shareAward = await prisma.tokenLedger.findUnique({ where: { idempotencyKey: `share:${topic.id}:${user2.id}` } });
    const topicAfter = await prisma.topic.findUnique({ where: { id: topic.id } });
    addResult('topic share: +2 + shares increment', shareAward?.amount === 2 && topicAfter?.shares === 1, `amount=${shareAward?.amount} shares=${topicAfter?.shares}`);

    // Notifications persisted by hooks
    const notifications = await prisma.notification.count({ where: { userId: { in: [contributor.id, moderator.id, user2.id] } } });
    addResult('reward/event notifications persisted', notifications > 0, `notifications=${notifications}`);

    // ── Leaderboards ──────────────────────────────────────────
    const board = await getLeaderboard('all');
    const inBoard = board.entries.some((e) => e.userId === contributor.id);
    addResult('leaderboard includes contributors', inBoard && board.entries[0].rank === 1, `entries=${board.entries.length}`);
    const myRank = await getMyRank('all', contributor.id);
    addResult('leaderboard/me returns rank + totals', myRank.rank !== null && myRank.totalTokens > 0 && myRank.rewardCount > 0, JSON.stringify(myRank));

    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    if (failed > 0) process.exitCode = 1;
  } catch (err) {
    console.error('Verification error:', err);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
};

main();
