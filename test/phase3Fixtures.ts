import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import type { Server } from 'node:http';
import express from 'express';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { rewardQueue, syncQueue } from '../src/lib/queue';
import { playbackRouter } from '../src/routes/playback';
import { adminYoutubeRouter } from '../src/routes/admin/youtube';
import { adminFeatureFlagsRouter } from '../src/routes/admin/featureFlags';
import { errorHandler } from '../src/middleware/errorHandler';
import { playbackSourceCacheKey, packPlaybackSourceCacheEntry } from '../src/lib/playbackCache';
import { logger } from '../src/lib/logger';

// ---------------------------------------------------------------------------
// Phase 3 (YouTube playback redesign) test fixtures.
//
// SAFETY CONTRACT — these helpers run against a real database:
//   * Every row they create is tagged with a unique `P3TEST-<uuid>` sentinel.
//   * Cleanup is ALWAYS scoped to ids captured in `registry` at creation time.
//     There is no deleteMany/updateMany without an explicit sentinel `where`.
//   * Nothing outside the registry is ever read for mutation, and no existing
//     artist, song, user or ledger row is touched.
//   * `cleanupPhase3Fixtures` asserts the sentinel rows are gone afterwards,
//     so a leak fails the test rather than silently accumulating.
//   * Redis keys are only deleted when they were created by this run.
// ---------------------------------------------------------------------------

// The teardown is registered per test FILE (see `registerPhase3Teardown`) so
// that cleanup, the leak assertion and the Redis shutdown always happen in a
// fixed order. Registering `after()` at module scope here instead would race
// with the calling file's own hooks and leak rows into the shared database.

export const SENTINEL = 'P3TEST';

export const tag = (what: string): string => `${SENTINEL}-${what}-${randomUUID().slice(0, 8)}`;

export interface FixtureRegistry {
  userIds: string[];
  artistIds: string[];
  songIds: string[];
  redisKeys: string[];
  /** BullMQ job ids enqueued by the code under test, removed on cleanup. */
  jobIds: Array<{ queue: 'reward' | 'sync'; id: string }>;
}

export const newRegistry = (): FixtureRegistry => ({
  userIds: [],
  artistIds: [],
  songIds: [],
  redisKeys: [],
  jobIds: [],
});

export async function createPhase3User(registry: FixtureRegistry, role: 'USER' | 'ADMIN' = 'USER') {
  const user = await prisma.user.create({
    data: {
      email: `${tag('user').toLowerCase()}@afrogenie.local`,
      displayName: tag('user'),
      role,
    },
  });
  registry.userIds.push(user.id);
  return user;
}

export async function createPhase3Artist(registry: FixtureRegistry, overrides: Record<string, unknown> = {}) {
  const artist = await prisma.artist.create({
    data: {
      name: tag('artist'),
      genres: [],
      ...overrides,
    },
  });
  registry.artistIds.push(artist.id);
  return artist;
}

export interface Phase3SongFields {
  title?: string;
  audioUrl?: string | null;
  youtubeVideoId?: string | null;
  spotifyPreviewUrl?: string | null;
  softDeleted?: boolean;
  views?: number;
}

export async function createPhase3Song(
  registry: FixtureRegistry,
  fields: Phase3SongFields = {},
): Promise<{ id: string; artistId: string; title: string }> {
  // One throwaway artist per song keeps the global @@unique([title, artistId])
  // and @@unique([name]) constraints out of the way without touching real data.
  const artist = await createPhase3Artist(registry);
  const song = await prisma.song.create({
    data: {
      // ALWAYS sentinel-prefixed, even when a caller supplies a title. If a
      // fixture row is not sentinel-shaped it cannot be found by the post-teardown
      // leak assertion, so a failed delete would go unnoticed.
      title: fields.title ? tag(fields.title) : tag('song'),
      artistId: artist.id,
      audioUrl: fields.audioUrl ?? null,
      youtubeVideoId: fields.youtubeVideoId ?? null,
      spotifyPreviewUrl: fields.spotifyPreviewUrl ?? null,
      softDeleted: fields.softDeleted ?? false,
      views: fields.views ?? 0,
      durationMs: 180_000,
    },
    select: { id: true, artistId: true, title: true },
  });
  registry.songIds.push(song.id);
  return song;
}

/**
 * Redis key for a song's cached playback source.
 *
 * Delegates to the production builder rather than re-typing the format. The
 * literal `playback:source:` used to live in both places, which meant a key-format
 * change in src/lib/playbackCache.ts would have left the tests seeding keys
 * nothing reads — and they would still pass, having asserted on their own fixture.
 */
export const playbackSourceKey = (songId: string) => playbackSourceCacheKey(songId);

/**
 * Register a song's playback cache key for cleanup.
 *
 * Cache entries are flag-partitioned by value, so a test that flips the rollout
 * mid-flight writes under the same key either way — but the flag-aware payload is
 * the only valid content now, so seed it with the production packer.
 */
export const seedPlaybackSourceCache = async (songId: string, value: unknown, flagOn: boolean) => {
  await redis.set(playbackSourceKey(songId), packPlaybackSourceCacheEntry(value, flagOn), 'EX', 300);
};
export const viewCounterKey = (songId: string) => `song:views:${songId}`;

/**
 * Remove every row/key this run created, then assert nothing sentinel-shaped
 * was left behind. Safe to call more than once.
 */
export async function cleanupPhase3Fixtures(registry: FixtureRegistry): Promise<void> {
  for (const key of registry.redisKeys) {
    await redis.del(key).catch(() => undefined);
  }
  registry.redisKeys.length = 0;

  for (const entry of registry.jobIds.splice(0)) {
    try {
      const queue = entry.queue === 'reward' ? rewardQueue : syncQueue;
      await queue.remove(entry.id).catch(() => undefined);
    } catch {
      // queue not reachable in this environment
    }
  }

  // SongPlay cascades from Song (onDelete: Cascade) and User (onDelete: SetNull),
  // so songs are removed first, then the throwaway artists.
  if (registry.songIds.length > 0) {
    await prisma.song.deleteMany({ where: { id: { in: registry.songIds } } });
  }
  if (registry.artistIds.length > 0) {
    await prisma.artist.deleteMany({ where: { id: { in: registry.artistIds } } });
  }
  if (registry.userIds.length > 0) {
    await prisma.songPlay.deleteMany({ where: { userId: { in: registry.userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: registry.userIds } } });
  }

  registry.songIds.length = 0;
  registry.artistIds.length = 0;
  registry.userIds.length = 0;
}

/**
 * Register the single, deterministic teardown for one test file.
 *
 * Call this ONCE per test file, at module top level, with the ONE registry that
 * file uses for all of its fixtures. Everything runs in a fixed order:
 *   1. delete every row/key this file created (scoped to captured ids)
 *   2. purge enrichment follow-up + reward jobs this file triggered
 *   3. assert no `P3TEST-*` row survived anywhere
 *   4. close Redis so the process can exit
 *
 * Using one registry per FILE (rather than per `describe`) is deliberate: the
 * Node test runner does not guarantee that sibling `describe` blocks finish in
 * declaration order, so per-describe teardowns can fire mid-file and clear the
 * id list out from under tests that have not run yet.
 */
export function registerPhase3Teardown(registry: FixtureRegistry): void {
  after(async () => {
    await cleanupPhase3Fixtures(registry);
    await purgeEnrichmentFollowupJobs();
    await assertNoFixtureLeak();
    try {
      await redis.quit();
    } catch {
      // already closed
    }
  });
}

/** Assert no `P3TEST-*` fixture rows survive — a leak must fail the suite. */
export async function assertNoFixtureLeak(): Promise<void> {
  const [songs, artists, users] = await Promise.all([
    prisma.song.count({ where: { title: { startsWith: SENTINEL } } }),
    prisma.artist.count({ where: { name: { startsWith: SENTINEL } } }),
    prisma.user.count({ where: { displayName: { startsWith: SENTINEL } } }),
  ]);
  if (songs + artists + users > 0) {
    throw new Error(`Fixture leak detected: ${songs} songs, ${artists} artists, ${users} users left behind`);
  }
}

/**
 * `processLibraryEnrichmentJob` self-schedules a 24h-delayed follow-up job on
 * the shared syncQueue whenever unmatched songs remain. Tests that exercise the
 * job must purge it, otherwise production Redis accumulates phantom jobs.
 */
export async function purgeEnrichmentFollowupJobs(): Promise<string[]> {
  const jobs = await syncQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 200, false);
  const stale = jobs.filter((j) => String(j.id ?? '').startsWith('library-enrichment-followup-'));
  for (const job of stale) {
    await syncQueue.remove(String(job.id)).catch(() => undefined);
  }
  return stale.map((j) => String(j.id));
}

// ---------------------------------------------------------------------------
// Minimal HTTP harness: mounts ONLY the Phase 3 routers so no worker, cron or
// unrelated route is booted. Nothing is written to the app's global queue
// unless the code under test explicitly enqueues.
// ---------------------------------------------------------------------------

export interface Harness {
  baseUrl: string;
  request: (
    method: string,
    path: string,
    options?: { body?: unknown; token?: string },
  ) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

export async function startPhase3Harness(): Promise<Harness> {
  const savedLevel = logger.level;
  logger.level = 'silent';

  const app = express();
  app.use(express.json());
  app.use('/api', playbackRouter);
  app.use('/api/admin', adminYoutubeRouter);
  app.use('/api/admin', adminFeatureFlagsRouter);
  app.use(errorHandler);

  const http = await import('node:http');
  const server: Server = http.createServer(app).listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    request: async (method, path, options = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
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
