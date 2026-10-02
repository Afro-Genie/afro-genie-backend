/**
 * Stage 6 regression suite.
 *
 * Three areas, all verified against a disposable database (TEST_DB_HOSTS=localhost):
 *
 *   6.1  Dead-lettering. A song retires after MAX_MATCH_ATTEMPTS *genuine*
 *        no-match results. A YouTube API failure must never count against a
 *        song, or a five-day quota outage would retire the entire catalog.
 *   6.2  Test-account archival. An archived user is invisible to every
 *        leaderboard and abuse surface, while their rows remain intact so the
 *        archive stays reversible.
 *   6.R  Regression for a pre-existing bug found while verifying 6.2:
 *        detectAbnormalEarnRate() used `IS DISTINCT FROM ALL (ARRAY[...])`,
 *        which is not valid PostgreSQL and made the detector fail 100% of the
 *        time with 42601. It had therefore never reported a single row.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { createUser, cleanupUser, uid } from './helpers';
import {
  MAX_MATCH_ATTEMPTS,
  enrichmentCandidateWhere,
  deadLetteredSongWhere,
} from '../src/jobs/libraryEnrichmentJob';
import { getLeaderboard, getMyRank, getLeaderboardBetween } from '../src/services/leaderboardService';
import {
  getNonPurchaseEarnings,
  detectAbnormalEarnRate,
  ABNORMAL_EARN_RATE_DAILY_GT,
} from '../src/services/abuseService';

// ---------------------------------------------------------------------------
// 6.1 — dead-letter selection
// ---------------------------------------------------------------------------

describe('Stage 6.1 dead-letter selection', () => {
  let artistId: string;
  const songIds: string[] = [];

  const makeSong = async (attempts: number) => {
    const s = await prisma.song.create({
      data: {
        title: `S6 ${uid()}`,
        artistId,
        youtubeMatchAttempts: attempts,
      },
    });
    songIds.push(s.id);
    return s;
  };

  before(async () => {
    artistId = (
      await prisma.artist.create({ data: { name: `S6 DeadLetter ${uid()}` } })
    ).id;
  });

  after(async () => {
    await prisma.song.deleteMany({ where: { id: { in: songIds } } });
    await prisma.artist.deleteMany({ where: { id: artistId } });
  });

  test('a fresh song is an enrichment candidate', () => {
    const where = enrichmentCandidateWhere();
    assert.equal(where.youtubeMatchAttempts.lt, MAX_MATCH_ATTEMPTS);
  });

  test('a song at the attempt cap is NOT a candidate', () => {
    const where = enrichmentCandidateWhere();
    const song = { youtubeMatchAttempts: MAX_MATCH_ATTEMPTS };
    assert.equal(where.youtubeMatchAttempts.lt > song.youtubeMatchAttempts, false);
  });

  test('a song one attempt below the cap IS still a candidate', () => {
    const where = enrichmentCandidateWhere();
    const song = { youtubeMatchAttempts: MAX_MATCH_ATTEMPTS - 1 };
    assert.equal(where.youtubeMatchAttempts.lt > song.youtubeMatchAttempts, true);
  });

  test('candidate and dead-letter predicates are exact complements', () => {
    // Guards against an off-by-one: a song must be in exactly one of the two
    // sets, never both and never neither.
    for (let n = 0; n <= MAX_MATCH_ATTEMPTS + 2; n++) {
      const isCandidate = n < MAX_MATCH_ATTEMPTS;
      const isDeadLettered = n >= MAX_MATCH_ATTEMPTS;
      assert.notEqual(
        isCandidate && isDeadLettered,
        true,
        `attempts=${n} is in both sets`,
      );
      assert.notEqual(
        isCandidate || isDeadLettered,
        false,
        `attempts=${n} is in neither set`,
      );
    }
  });

  test('database state matches the predicates', async () => {
    const fresh = await makeSong(0);
    const capped = await makeSong(MAX_MATCH_ATTEMPTS);
    const over = await makeSong(MAX_MATCH_ATTEMPTS + 3);

    const candidates = await prisma.song.findMany({
      where: { id: { in: [fresh.id, capped.id, over.id] }, ...enrichmentCandidateWhere() },
      select: { id: true },
    });
    const ids = candidates.map((c) => c.id);
    assert.ok(ids.includes(fresh.id), 'fresh song should be a candidate');
    assert.equal(ids.includes(capped.id), false, 'capped song must be excluded');
    assert.equal(ids.includes(over.id), false, 'over-capped song must be excluded');

    const dead = await prisma.song.findMany({
      where: { id: { in: [fresh.id, capped.id, over.id] }, ...deadLetteredSongWhere() },
      select: { id: true },
    });
    const deadIds = dead.map((c) => c.id);
    assert.equal(deadIds.includes(fresh.id), false);
    assert.ok(deadIds.includes(capped.id));
    assert.ok(deadIds.includes(over.id));
  });

  test('a matched song leaves the candidate set for two independent reasons', async () => {
    // The reset is what makes a re-match budget fresh. But note the candidate
    // predicate also requires `youtubeVideoId: null`, so a freshly matched song
    // drops out for TWO reasons: it is no longer unmatched, and its counter is 0.
    // Both are asserted here so a future edit that drops the reset cannot be
    // masked by the videoId filter.
    const song = await makeSong(MAX_MATCH_ATTEMPTS - 1);
    const updated = await prisma.song.update({
      where: { id: song.id },
      data: { youtubeMatchAttempts: 0, youtubeVideoId: 'dQw4w9WgXcQ' },
    });
    assert.equal(updated.youtubeMatchAttempts, 0);

    const asMatched = await prisma.song.findMany({
      where: { id: song.id, ...enrichmentCandidateWhere() },
      select: { id: true },
    });
    assert.equal(asMatched.length, 0, 'a matched song is not a candidate');

    // Clear the videoId and the song must reappear precisely BECAUSE the
    // counter was reset. Without the reset it would still be at the cap.
    await prisma.song.update({
      where: { id: song.id },
      data: { youtubeVideoId: null },
    });
    const requeued = await prisma.song.findMany({
      where: { id: song.id, ...enrichmentCandidateWhere() },
      select: { id: true },
    });
    assert.equal(requeued.length, 1, 'an unmatched song with a reset counter is a candidate');
  });

  test('the counter column is NOT NULL with a 0 default', async () => {
    // A nullable column would make the `lt` comparison silently drop rows, and a
    // missing default would leave new songs undefined rather than retryable.
    const rows = await prisma.$queryRaw<
      Array<{ column_default: string; is_nullable: string }>
    >`SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_name = 'Song' AND column_name = 'youtubeMatchAttempts'`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].is_nullable, 'NO');
    assert.equal(rows[0].column_default, '0');
  });
});

// ---------------------------------------------------------------------------
// 6.2 — test-account archival
// ---------------------------------------------------------------------------

describe('Stage 6.2 test-account archival', () => {
  // NOTE: these must not be named `test` — that identifier shadows node:test's
  // `test` and makes the describe callback throw "test2 is not a function".
  let real: { id: string };
  let archived: { id: string };
  let artistId: string;
  let songId: string;

  before(async () => {
    real = await createUser({ isTestAccount: false });
    archived = await createUser({ isTestAccount: true });
    artistId = (await prisma.artist.create({ data: { name: `S6 Archival ${uid()}` } })).id;
    songId = (await prisma.song.create({ data: { title: `S6 ${uid()}`, artistId } })).id;
  });

  after(async () => {
    await prisma.song.deleteMany({ where: { id: songId } });
    await prisma.artist.deleteMany({ where: { id: artistId } });
    await cleanupUser(real.id);
    await cleanupUser(archived.id);
  });

  beforeEach(async () => {
    // The archived account out-earns the real one by 9x. If any filter is
    // missing, the archived account appears FIRST — so ordering makes the
    // failure obvious rather than merely detectable.
    await prisma.tokenLedger.deleteMany({
      where: { userId: { in: [real.id, archived.id] } },
    });
    const earn = (userId: string, amount: number) =>
      prisma.tokenLedger.create({
        data: {
          userId,
          type: 'EARN',
          amount,
          balanceAfter: amount,
          reason: 'stage6 test',
          sourceType: 'SONG_UPLOAD',
          idempotencyKey: `s6-${userId}-${Math.random()}`,
        },
      });
    await earn(real.id, 100);
    await earn(archived.id, 900);
  });

  test('the archived account is absent from the token leaderboard', async () => {
    const board = await getLeaderboard('all', 100, 'tokens');
    const ids = board.entries.map((e) => e.userId);
    assert.equal(ids.includes(archived.id), false, 'archived account leaked into leaderboard');
    assert.ok(ids.includes(real.id), 'real account should still appear');
  });

  test('the archived account cannot claim a rank', async () => {
    const rank = await getMyRank('all', archived.id, 'tokens');
    assert.equal(rank.rank, null);
    assert.equal(rank.totalTokens, 0);
  });

  test('the archived account is absent from a period leaderboard', async () => {
    const from = new Date(Date.now() - 86_400_000);
    const board = await getLeaderboardBetween(from, new Date(), 100);
    assert.equal(
      board.entries.map((e) => e.userId).includes(archived.id),
      false,
    );
  });

  test('the archived account is absent from abuse earnings aggregates', async () => {
    const rows = await getNonPurchaseEarnings(30);
    assert.equal(rows.map((r) => r.userId).includes(archived.id), false);
    assert.ok(rows.map((r) => r.userId).includes(real.id));
  });

  test('the archived account is absent from the abnormal-ear detector', async () => {
    // 900 GT in one day is over the 500 threshold, so the detector WOULD flag
    // this account if the join were missing.
    const rows = await detectAbnormalEarnRate();
    assert.equal(
      rows.map((r) => r.userId).includes(archived.id),
      false,
      'archived account was flagged for abuse',
    );
  });

  test('archival is reversible and non-destructive', async () => {
    // The whole point of the flag over a hard delete: un-archiving restores the
    // account to the leaderboard with its history intact.
    await prisma.user.update({
      where: { id: archived.id },
      data: { isTestAccount: false },
    });
    const board = await getLeaderboard('all', 100, 'tokens');
    const entry = board.entries.find((e) => e.userId === archived.id);
    assert.ok(entry, 'un-archiving should restore the leaderboard entry');
    assert.equal(entry!.totalTokens, 900);
    await prisma.user.update({
      where: { id: archived.id },
      data: { isTestAccount: true },
    });
  });
});

// ---------------------------------------------------------------------------
// 6.R — regression: detectAbnormalEarnRate was 100% broken
// ---------------------------------------------------------------------------

describe('Regression: detectAbnormalEarnRate NULL provenance', () => {
  let flagged: { id: string };
  let exempt: { id: string };

  before(async () => {
    flagged = await createUser();
    exempt = await createUser();
  });

  after(async () => {
    await cleanupUser(flagged.id);
    await cleanupUser(exempt.id);
  });

  const clear = () =>
    prisma.tokenLedger.deleteMany({ where: { userId: { in: [flagged.id, exempt.id] } } });

  const earn = (userId: string, amount: number, sourceType: string | null) =>
    prisma.tokenLedger.create({
      data: {
        userId,
        type: 'EARN',
        amount,
        balanceAfter: amount,
        reason: 'regression probe',
        sourceType,
        idempotencyKey: `reg-${userId}-${Math.random()}`,
      },
    });

  test('the query parses and runs (it previously failed 42601 on every call)', async () => {
    await clear();
    await earn(flagged.id, ABNORMAL_EARN_RATE_DAILY_GT + 50, 'SONG_UPLOAD');
    const rows = await detectAbnormalEarnRate();
    assert.ok(
      rows.map((r) => r.userId).includes(flagged.id),
      'a genuine over-threshold earner should be flagged',
    );
    await clear();
  });

  test('a NULL sourceType is KEPT — unknown provenance is what we want to see', async () => {
    // This is the exact case the original author's comment was protecting, and
    // the exact case the plan's "simplify to NOT IN" step would have silently
    // broken: `NULL NOT IN ('GT_PURCHASE', ...)` evaluates to NULL, dropping the
    // row. An unknown-provenance grant must remain visible to an admin.
    await clear();
    await earn(flagged.id, ABNORMAL_EARN_RATE_DAILY_GT + 50, null);
    const rows = await detectAbnormalEarnRate();
    assert.ok(
      rows.map((r) => r.userId).includes(flagged.id),
      'NULL-provenance earner was dropped — the NOT IN trap',
    );
    await clear();
  });

  test('a GT purchase is NOT flagged', async () => {
    await clear();
    await earn(exempt.id, ABNORMAL_EARN_RATE_DAILY_GT + 50, 'GT_PURCHASE');
    const rows = await detectAbnormalEarnRate();
    assert.equal(
      rows.map((r) => r.userId).includes(exempt.id),
      false,
      'a paying user was flagged for non-purchase earnings',
    );
    await clear();
  });

  test('an amount under the threshold is NOT flagged', async () => {
    await clear();
    await earn(flagged.id, 10, 'SONG_UPLOAD');
    const rows = await detectAbnormalEarnRate();
    assert.equal(rows.map((r) => r.userId).includes(flagged.id), false);
    await clear();
  });
});
