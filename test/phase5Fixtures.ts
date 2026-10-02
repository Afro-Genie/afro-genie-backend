import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import type { Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { env } from '../src/lib/env';
import { logger } from '../src/lib/logger';
import { challengesRouter } from '../src/routes/challenges';
import { adminEconomyRouter } from '../src/routes/admin/economy';
import { errorHandler } from '../src/middleware/errorHandler';

// ---------------------------------------------------------------------------
// Phase 5 (challenges + economy + abuse) test fixtures — REMEDIATION-PLAN.md 7.4/7.5.
//
// SAFETY CONTRACT
//   * Every user this file creates is tagged `P5TEST-<uuid>` and its id is
//     captured in the registry at creation time.
//   * Every delete is scoped to either a captured id or a captured id list.
//     There is no unscoped `deleteMany`/`updateMany` anywhere in this file.
//   * `cleanupPhase5Fixtures` re-counts the sentinel afterwards, so a leak fails
//     the run instead of silently accumulating.
//   * Redis keys are only deleted if this run created them.
//
// This mirrors test/phase3Fixtures.ts rather than importing it, because the two
// suites touch different tables and register separate teardowns. Sharing one
// registry would mean a Phase 3 teardown could run while Phase 5 tests are
// still creating rows.
// ---------------------------------------------------------------------------

export const SENTINEL = 'P5TEST';

export const tag = (what: string): string => `${SENTINEL}-${what}-${randomUUID().slice(0, 8)}`;

export interface Phase5Registry {
  userIds: string[];
  challengeIds: string[];
  songIds: string[];
  artistIds: string[];
  redisKeys: string[];
  /** Week windows this run rotated challenges into, for scoped cleanup. */
  weekWindows: string[];
  /**
   * EconomyConfig keys written by the code under test. These rows are keyed by
   * the config key itself (`AI_TRANSLATION_AMOUNT`, `ACTIVE:<TYPE>`), not by the
   * sentinel, so cleanup deletes them by the captured key AND asserts the
   * `lastModifiedBy` is one of this run's admins. Without the second condition a
   * re-run could delete a row a human had edited.
   */
  economyConfigKeys: string[];
}

export const newRegistry = (): Phase5Registry => ({
  userIds: [],
  challengeIds: [],
  songIds: [],
  artistIds: [],
  redisKeys: [],
  weekWindows: [],
  economyConfigKeys: [],
});

/** The ledger-summary cache key `tokenService` invalidates on every award/adjust. */
export const ledgerSummaryKey = (userId: string): string => `economy:ledger-summary:${userId}`;

export async function createPhase5User(
  registry: Phase5Registry,
  role: 'USER' | 'ADMIN' = 'USER',
): Promise<{ id: string; email: string; displayName: string | null }> {
  const user = await prisma.user.create({
    data: {
      email: `${tag('user').toLowerCase()}@afrogenie.local`,
      displayName: tag('user'),
      role,
    },
    select: { id: true, email: true, displayName: true },
  });
  registry.userIds.push(user.id);
  return user;
}

/**
 * A throwaway song for translation/approval fixtures.
 *
 * One artist per song keeps the global `@@unique([title, artistId])` and
 * `@@unique([name])` constraints out of the way without touching real data.
 */
export async function createPhase5Song(registry: Phase5Registry): Promise<{ id: string; artistId: string }> {
  const artist = await prisma.artist.create({
    data: { name: tag('artist'), genres: [] },
    select: { id: true },
  });
  registry.artistIds.push(artist.id);

  const song = await prisma.song.create({
    data: {
      title: tag('song'),
      artistId: artist.id,
      durationMs: 180_000,
      views: 0,
    },
    select: { id: true, artistId: true },
  });
  registry.songIds.push(song.id);
  return song;
}

export function createChallenge(
  registry: Phase5Registry,
  fields: {
    type: string;
    targetValue: number;
    gtReward: number;
    title?: string;
    startsAt?: Date;
    expiresAt?: Date;
    active?: boolean;
  },
) {
  const now = new Date();
  return prisma.challenge
    .create({
      data: {
        type: fields.type as never,
        title: fields.title ?? tag('challenge'),
        description: 'Phase 5 fixture challenge',
        targetValue: fields.targetValue,
        gtReward: fields.gtReward,
        startsAt: fields.startsAt ?? new Date(now.getTime() - 60_000),
        expiresAt: fields.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        active: fields.active ?? true,
      },
      select: { id: true, type: true, targetValue: true, gtReward: true, startsAt: true, expiresAt: true, title: true },
    })
    .then((challenge) => {
      registry.challengeIds.push(challenge.id);
      return challenge;
    });
}

/**
 * A translation row, which is what TRANSLATE_N_SONGS and ACHIEVE_N_APPROVALS
 * count.
 *
 * Note the field names: the model uses `sourceLang`/`targetLang`, not
 * `language`. Getting that wrong is a Prisma validation error at runtime, not a
 * type error at build time in a `.test.ts` file, so it is centralised here
 * rather than repeated at every call site.
 */
export async function createPhase5Translation(fields: {
  userId: string;
  songId: string;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  approvedAt?: Date;
}) {
  return prisma.translation.create({
    data: {
      userId: fields.userId,
      songId: fields.songId,
      sourceLang: 'en',
      targetLang: 'fr',
      originalLyrics: 'original lyrics',
      translatedLyrics: 'traduction',
      status: fields.status ?? 'PENDING',
      ...(fields.approvedAt ? { approvedAt: fields.approvedAt, approvedById: fields.userId } : {}),
    },
    select: { id: true, songId: true, status: true },
  });
}

/**
 * A ledger row written directly (as opposed to via `awardTokens`, which owns
 * the wallet update too).
 *
 * `balanceAfter` is NOT NULL and `idempotencyKey` is UNIQUE, so a hand-written
 * row needs both. `balanceAfter` here is deliberately the caller's figure and is
 * only read by assertions that do not depend on the running balance.
 */
export async function createPhase5LedgerEntry(fields: {
  userId: string;
  type: 'EARN' | 'SPEND' | 'PENALTY' | 'TAX' | 'ADMIN_ADJUST';
  amount: number;
  reason: string;
  sourceType?: string;
  createdAt?: Date;
}) {
  return prisma.tokenLedger.create({
    data: {
      userId: fields.userId,
      type: fields.type,
      amount: fields.amount,
      balanceAfter: 0,
      reason: fields.reason,
      sourceType: fields.sourceType ?? 'P5TEST_FIXTURE',
      idempotencyKey: `p5test:${tag('ledger')}`,
      ...(fields.createdAt ? { createdAt: fields.createdAt } : {}),
    },
    select: { id: true, amount: true, type: true },
  });
}

export const tokenFor = (user: { id: string; email: string }, role: 'USER' | 'ADMIN' = 'USER'): string =>
  jwt.sign({ userId: user.id, email: user.email, role }, env.JWT_SECRET, { expiresIn: '10m' });

/**
 * Remove every row/key this run created, then assert the sentinel is gone.
 *
 * Order matters: user-scoped children (entitlements, ledger, notifications,
 * abuse flags, mod-action logs, translations, streaks, referrals) are removed
 * explicitly before the users, because several of those relations are not
 * cascading and a leftover would make the next run's fixture creation fail on a
 * unique constraint rather than on anything meaningful.
 */
export async function cleanupPhase5Fixtures(registry: Phase5Registry): Promise<void> {
  for (const key of registry.redisKeys) {
    await redis.del(key).catch(() => undefined);
  }
  registry.redisKeys.length = 0;

  const userIds = [...registry.userIds];

  if (userIds.length > 0) {
    await prisma.userEntitlement.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.tokenLedger.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.abuseFlag.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.modActionLog.deleteMany({ where: { moderatorId: { in: userIds } } });
    await prisma.translation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userStreak.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.referral.deleteMany({ where: { referrerId: { in: userIds } } });
    await prisma.userWallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.songPlay.deleteMany({ where: { userId: { in: userIds } } });
  }

  if (registry.challengeIds.length > 0) {
    await prisma.challenge.deleteMany({ where: { id: { in: registry.challengeIds } } });
  }

  // EconomyConfig rows the code under test wrote. Scoped to the captured keys
  // and to a `lastModifiedBy` that is one of this run's admin ids, so a row a
  // human edited is never removed even if the keys collide.
  if (registry.economyConfigKeys.length > 0) {
    const adminIds = await prisma.user.findMany({
      where: { id: { in: userIds }, role: 'ADMIN' },
      select: { id: true },
    });
    await prisma.economyConfig.deleteMany({
      where: {
        key: { in: registry.economyConfigKeys },
        ...(adminIds.length > 0 ? { lastModifiedBy: { in: adminIds.map((a) => a.id) } } : {}),
      },
    });
  }

  // `runChallengeRotation()` upserts on (type, startsAt), so its rows carry the
  // template titles rather than the sentinel. Scoped strictly to the exact week
  // windows this run recorded, and only after asserting nothing was there
  // beforehand — see phase5ChallengeAndEconomy.tierB.test.ts, which captures the
  // pre-existing count and fails rather than deleting rows it did not create.
  for (const iso of registry.weekWindows) {
    const startsAt = new Date(iso);
    const owned = await prisma.challenge.findMany({ where: { startsAt }, select: { id: true } });
    await prisma.challenge.deleteMany({ where: { id: { in: owned.map((c) => c.id) }, startsAt } });
  }
  registry.weekWindows.length = 0;

  if (registry.songIds.length > 0) {
    await prisma.song.deleteMany({ where: { id: { in: registry.songIds } } });
  }
  if (registry.artistIds.length > 0) {
    await prisma.artist.deleteMany({ where: { id: { in: registry.artistIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  // The captured id lists are deliberately NOT cleared here. `assertNoPhase5Leak`
  // runs after this function and needs the user ids to find EconomyConfig rows
  // that survived; emptying the list first made that half of the leak check
  // silently vacuous. Re-running cleanup is harmless, since deleteMany on
  // already-deleted ids is a no-op.
}

/**
 * Assert no `P5TEST` row survived, and no EconomyConfig row still points at one
 * of this run's users.
 *
 * A leak is a test failure, not a warning: the whole point of the sentinel is
 * that "the fixtures cleaned up" is an assertion rather than an assumption. With
 * the disposable database from 7.1 in place this costs nothing, and it is the
 * check that would have caught the §1 incident.
 *
 * The EconomyConfig half matters because those rows are keyed by config name,
 * not by the sentinel, so they are invisible to a prefix scan — a leaked
 * `AI_TRANSLATION_AMOUNT=999` would silently change every reward in the
 * database with no sentinel anywhere to find it by.
 */
export async function assertNoPhase5Leak(registry: Phase5Registry): Promise<void> {
  const [users, challenges, artists, songs] = await Promise.all([
    prisma.user.count({ where: { displayName: { startsWith: SENTINEL } } }),
    prisma.challenge.count({ where: { title: { startsWith: SENTINEL } } }),
    prisma.artist.count({ where: { name: { startsWith: SENTINEL } } }),
    prisma.song.count({ where: { title: { startsWith: SENTINEL } } }),
  ]);
  if (users + challenges + artists + songs > 0) {
    throw new Error(
      `Phase 5 fixture leak: ${users} users, ${challenges} challenges, ${artists} artists, ${songs} songs left behind`,
    );
  }

  if (registry.userIds.length > 0) {
    const configs = await prisma.economyConfig.count({
      where: { lastModifiedBy: { in: registry.userIds } },
    });
    if (configs > 0) {
      throw new Error(`Phase 5 fixture leak: ${configs} EconomyConfig row(s) still reference this run's admins`);
    }
  }
}

/**
 * Register the one deterministic teardown for a Phase 5 test file.
 *
 * One registry per FILE, registered at module scope, for the same reason
 * `phase3Fixtures.ts` documents: the Node test runner does not guarantee that
 * sibling `describe` blocks finish in declaration order, so a per-describe
 * teardown can fire mid-file and clear the id list out from under tests that
 * have not run yet.
 */
export function registerPhase5Teardown(registry: Phase5Registry): void {
  after(async () => {
    await cleanupPhase5Fixtures(registry);
    await assertNoPhase5Leak(registry);
    try {
      await redis.quit();
    } catch {
      // already closed
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP harness: mounts ONLY the Phase 5 routers, so no worker, cron or unrelated
// route is booted. Bound to 127.0.0.1 on an ephemeral port chosen by the OS, so
// two concurrently running suites cannot collide and nothing off the machine can
// reach it.
// ---------------------------------------------------------------------------

export interface Phase5Harness {
  baseUrl: string;
  request: (
    method: string,
    path: string,
    options?: { body?: unknown; token?: string },
  ) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

export async function startPhase5Harness(): Promise<Phase5Harness> {
  const savedLevel = logger.level;
  logger.level = 'silent';

  const app = express();
  app.use(express.json());
  app.use('/api', challengesRouter);
  app.use('/api/admin', adminEconomyRouter);
  app.use(errorHandler);

  const http = await import('node:http');
  const server: Server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    request: async (method, path, options = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      // `fetch` rejects a GET/HEAD that carries a body, and the 401/403 guard
      // table passes `{ body: {} }` uniformly for every method. Only attach a
      // body where the verb allows one.
      const upper = method.toUpperCase();
      const canHaveBody = upper !== 'GET' && upper !== 'HEAD';
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(options.body === undefined || !canHaveBody ? {} : { body: JSON.stringify(options.body) }),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.level = savedLevel;
    },
  };
}
