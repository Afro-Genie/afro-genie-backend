import jwt from 'jsonwebtoken';
import type { Job } from 'bullmq';
import { app } from '../src/app';
import { processLyricsEnrichmentJob } from '../src/jobs/lyricsEnrichmentJob';
import { env } from '../src/lib/env';
import { prisma } from '../src/lib/prisma';
import { languageCategorizationQueue, lyricsEnrichmentQueue, searchIndexQueue } from '../src/lib/queue';
import { redis } from '../src/lib/redis';

type TestResult = {
  name: string;
  pass: boolean;
  details: string;
};

type QueueJobRecord = {
  name: string;
  data: { songId: string };
  opts?: { delay?: number };
};

type MockScenario = 'success' | 'rate-limit-once-then-success';

const results: TestResult[] = [];
const queuedLyricsJobs: QueueJobRecord[] = [];

const providerState = {
  scenario: 'success' as MockScenario,
  searchCalls: 0,
  fetchCalls: 0,
  rateLimitTriggered: false,
};

const redisMockState = {
  count: 0,
};

const addResult = (name: string, pass: boolean, details: string) => {
  results.push({ name, pass, details });
  const status = pass ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name} :: ${details}`);
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const jsonFetch = async <T = unknown>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
};

const fakeJob = (songId: string): Job<{ songId: string }> => {
  return {
    id: `job-${songId}-${Date.now()}`,
    name: 'enrichLyrics',
    data: { songId },
    attemptsMade: 0,
  } as unknown as Job<{ songId: string }>;
};

const main = async () => {
  const port = 4016;
  const baseUrl = `http://127.0.0.1:${port}`;
  const runId = Date.now();

  process.env.MUSICMATCH_API_KEY = process.env.MUSICMATCH_API_KEY ?? 'test-musicmatch-key';

  const createdSongIds: string[] = [];
  const createdArtistIds: string[] = [];

  const adminUser = await prisma.user.create({
    data: {
      email: `lyrics_admin_${runId}@example.com`,
      passwordHash: 'acceptance_hash',
      displayName: 'Lyrics Admin',
      role: 'ADMIN',
    },
  });

  const adminToken = jwt.sign(
    { userId: adminUser.id, email: adminUser.email, role: adminUser.role },
    env.JWT_SECRET,
    { expiresIn: '1h' },
  );

  const adminHeaders = {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };

  const originalFetch = globalThis.fetch;
  const originalRedisIncr = redis.incr.bind(redis);
  const originalRedisExpire = redis.expire.bind(redis);
  const originalLyricsQueueAdd = lyricsEnrichmentQueue.add.bind(lyricsEnrichmentQueue);
  const originalLanguageQueueAdd = languageCategorizationQueue.add.bind(languageCategorizationQueue);
  const originalSearchQueueAdd = searchIndexQueue.add.bind(searchIndexQueue);

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    if (url.includes('/track.search')) {
      providerState.searchCalls += 1;
      return new Response(
        JSON.stringify({
          message: {
            header: { status_code: 200 },
            body: {
              track_list: [
                {
                  track: {
                    track_id: 987654,
                    track_name: 'Mock Song',
                    artist_name: 'Mock Artist',
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.includes('/track.lyrics.get')) {
      providerState.fetchCalls += 1;
      return new Response(
        JSON.stringify({
          message: {
            header: { status_code: 200 },
            body: {
              lyrics: {
                lyrics_body: 'Mock enriched lyrics body\nLine 2\nLine 3',
              },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return originalFetch(input as never, init);
  }) as typeof fetch;

  redis.incr = (async () => {
    redisMockState.count += 1;

    if (providerState.scenario === 'rate-limit-once-then-success' && !providerState.rateLimitTriggered) {
      providerState.rateLimitTriggered = true;
      return 2001;
    }

    return Math.min(redisMockState.count, 2000);
  }) as typeof redis.incr;

  redis.expire = (async () => 1) as typeof redis.expire;

  lyricsEnrichmentQueue.add = (async (name: string, data: { songId: string }, opts?: { delay?: number }) => {
    queuedLyricsJobs.push({ name, data, opts });
    return { id: `queued-${data.songId}-${queuedLyricsJobs.length}` } as never;
  }) as typeof lyricsEnrichmentQueue.add;

  languageCategorizationQueue.add = (async () => ({ id: 'noop-language' } as never)) as typeof languageCategorizationQueue.add;
  searchIndexQueue.add = (async () => ({ id: 'noop-search' } as never)) as typeof searchIndexQueue.add;

  const server = app.listen(port);

  try {
    const artistA = await prisma.artist.create({
      data: {
        name: `Lyrics Acceptance Artist A ${runId}`,
        genres: ['Afrobeats'],
      },
    });
    createdArtistIds.push(artistA.id);

    providerState.scenario = 'success';
    providerState.searchCalls = 0;
    providerState.fetchCalls = 0;
    providerState.rateLimitTriggered = false;

    const createA = await jsonFetch<{ id?: string }>(`${baseUrl}/api/admin/songs`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        title: `Lyrics Auto Song ${runId}`,
        artistId: artistA.id,
      }),
    });

    const songAId = createA.body.id;
    if (!songAId || createA.status !== 201) {
      throw new Error(`Failed to create auto-enrichment song: status=${createA.status}`);
    }
    createdSongIds.push(songAId);

    const queuedAutoJob = queuedLyricsJobs.find((job) => job.data.songId === songAId);
    if (!queuedAutoJob) {
      throw new Error('Auto enrichment did not queue a lyrics job.');
    }

    const startA = Date.now();
    await wait(1000);
    await processLyricsEnrichmentJob(fakeJob(songAId));

    const lyricA = await prisma.lyric.findFirst({
      where: { songId: songAId, sourceProvider: 'MUSICMATCH' },
      orderBy: { createdAt: 'desc' },
      select: { sourceProvider: true, licenseStatus: true, content: true },
    });

    addResult(
      'Add song with no lyrics -> within 15s lyrics exist in DB',
      Boolean(lyricA?.content) && Date.now() - startA <= 15_000,
      `elapsedMs=${Date.now() - startA}`,
    );

    addResult(
      'Lyric fields set to sourceProvider=MUSICMATCH and licenseStatus=LICENSED',
      lyricA?.sourceProvider === 'MUSICMATCH' && lyricA.licenseStatus === 'LICENSED',
      `sourceProvider=${lyricA?.sourceProvider ?? 'n/a'}, licenseStatus=${lyricA?.licenseStatus ?? 'n/a'}`,
    );

    const aiLogsA = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "AICallLog"
      WHERE "songId" = ${songAId}
        AND UPPER("provider") = 'MUSICMATCH'
    `;

    addResult(
      'AICallLog entry for every MusicMatch call (auto flow)',
      Number(aiLogsA[0]?.count ?? 0) >= providerState.searchCalls + providerState.fetchCalls,
      `musicMatchCalls=${providerState.searchCalls + providerState.fetchCalls}, aiCallLogs=${Number(aiLogsA[0]?.count ?? 0)}`,
    );

    const artistB = await prisma.artist.create({
      data: {
        name: `Lyrics Acceptance Artist B ${runId}`,
        genres: ['Afrobeats'],
      },
    });
    createdArtistIds.push(artistB.id);

    providerState.scenario = 'rate-limit-once-then-success';
    providerState.searchCalls = 0;
    providerState.fetchCalls = 0;
    providerState.rateLimitTriggered = false;

    const createB = await jsonFetch<{ id?: string }>(`${baseUrl}/api/admin/songs`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        title: `Lyrics Retry Song ${runId}`,
        artistId: artistB.id,
      }),
    });

    const songBId = createB.body.id;
    if (!songBId || createB.status !== 201) {
      throw new Error(`Failed to create rate-limit song: status=${createB.status}`);
    }
    createdSongIds.push(songBId);

    await wait(1000);
    await processLyricsEnrichmentJob(fakeJob(songBId));

    const delayedRequeue = queuedLyricsJobs.find(
      (job) =>
        job.data.songId === songBId &&
        typeof job.opts?.delay === 'number' &&
        job.opts.delay >= 1200,
    );

    await wait(1300);
    await processLyricsEnrichmentJob(fakeJob(songBId));

    const lyricB = await prisma.lyric.findFirst({
      where: { songId: songBId, sourceProvider: 'MUSICMATCH' },
      orderBy: { createdAt: 'desc' },
      select: { content: true },
    });

    addResult(
      'Mock rate limit exceeded -> queued -> retried next window',
      Boolean(delayedRequeue) && providerState.searchCalls >= 1 && Boolean(lyricB?.content),
      `requeuedWithDelay=${Boolean(delayedRequeue)}, searchCalls=${providerState.searchCalls}, lyricRecovered=${Boolean(lyricB?.content)}`,
    );

    const artistC = await prisma.artist.create({
      data: {
        name: `Lyrics Acceptance Artist C ${runId}`,
        genres: ['Afrobeats'],
      },
    });
    createdArtistIds.push(artistC.id);

    const songC = await prisma.song.create({
      data: {
        title: `Lyrics Manual Fetch Song ${runId}`,
        artistId: artistC.id,
      },
    });
    createdSongIds.push(songC.id);

    providerState.scenario = 'success';
    providerState.searchCalls = 0;
    providerState.fetchCalls = 0;
    providerState.rateLimitTriggered = false;

    const manualStart = Date.now();
    const manualRes = await jsonFetch<{ jobId?: string; status?: string }>(
      `${baseUrl}/api/admin/songs/${songC.id}/fetch-lyrics`,
      {
        method: 'POST',
        headers: adminHeaders,
      },
    );

    await processLyricsEnrichmentJob(fakeJob(songC.id));

    const lyricC = await prisma.lyric.findFirst({
      where: { songId: songC.id, sourceProvider: 'MUSICMATCH' },
      orderBy: { createdAt: 'desc' },
      select: { content: true },
    });

    addResult(
      'Admin fetches manually -> lyrics appear within 10s',
      manualRes.status === 202 && manualRes.body.status === 'queued' && Boolean(lyricC?.content) && Date.now() - manualStart <= 10_000,
      `http=${manualRes.status}, queued=${manualRes.body.status ?? 'n/a'}, elapsedMs=${Date.now() - manualStart}`,
    );

    const aiLogsC = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "AICallLog"
      WHERE "songId" = ${songC.id}
        AND UPPER("provider") = 'MUSICMATCH'
    `;

    addResult(
      'AICallLog entry for every MusicMatch call (manual flow)',
      Number(aiLogsC[0]?.count ?? 0) >= providerState.searchCalls + providerState.fetchCalls,
      `musicMatchCalls=${providerState.searchCalls + providerState.fetchCalls}, aiCallLogs=${Number(aiLogsC[0]?.count ?? 0)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;

    redis.incr = originalRedisIncr;
    redis.expire = originalRedisExpire;

    lyricsEnrichmentQueue.add = originalLyricsQueueAdd;
    languageCategorizationQueue.add = originalLanguageQueueAdd;
    searchIndexQueue.add = originalSearchQueueAdd;

    server.close();

    if (createdSongIds.length > 0) {
      await prisma.$executeRaw`DELETE FROM "AICallLog" WHERE "songId" = ANY(${createdSongIds})`;
      await prisma.lyric.deleteMany({ where: { songId: { in: createdSongIds } } });
      await prisma.song.deleteMany({ where: { id: { in: createdSongIds } } });
    }

    if (createdArtistIds.length > 0) {
      await prisma.artist.deleteMany({ where: { id: { in: createdArtistIds } } });
    }

    await prisma.user.deleteMany({ where: { id: adminUser.id } });
    await prisma.$disconnect();
  }

  const failed = results.filter((result) => !result.pass);

  console.log('\n===== Lyrics Enrichment Acceptance Summary =====');
  console.log(`Total: ${results.length}`);
  console.log(`Passed: ${results.length - failed.length}`);
  console.log(`Failed: ${failed.length}`);

  if (failed.length > 0) {
    for (const failure of failed) {
      console.log(`- ${failure.name}: ${failure.details}`);
    }
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
};

void main().catch((error) => {
  console.error('Lyrics enrichment acceptance test failed unexpectedly:', error);
  process.exitCode = 1;
});
