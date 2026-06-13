import jwt from 'jsonwebtoken';
import type { Job } from 'bullmq';
import { app } from '../src/app';
import { env } from '../src/lib/env';
import { prisma } from '../src/lib/prisma';
import { translationQueue } from '../src/lib/queue';
import { translationWorker } from '../src/jobs/workers';
import {
  getActiveProvider,
  registerTranslationProvider,
  resetActiveProvider,
} from '../src/services/translationService';
import type {
  LanguageDetectionResult,
  TranslateParams,
  TranslationProvider,
  TranslationResult,
} from '../src/types/translation';

type TestResult = {
  name: string;
  pass: boolean;
  details: string;
};

const results: TestResult[] = [];

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

const languageFromLyrics = (lyrics: string): string => {
  const sample = lyrics.toLowerCase();

  const yorubaSignals = ['mo fe', 'emi', 'olorun', 'eyin', 'se o'];
  const igboSignals = ['anyị', 'ndi', 'chukwu', 'nna', 'biko'];
  const pidginSignals = ['na you', 'dey', 'wahala', 'abeg', 'wetin'];

  const score = (signals: string[]) => signals.reduce((acc, token) => acc + (sample.includes(token) ? 1 : 0), 0);

  const yo = score(yorubaSignals);
  const ig = score(igboSignals);
  const pcm = score(pidginSignals);

  if (yo >= ig && yo >= pcm && yo > 0) return 'yo';
  if (ig >= yo && ig >= pcm && ig > 0) return 'ig';
  if (pcm >= yo && pcm >= ig && pcm > 0) return 'pcm';

  return 'en';
};

class MockGeminiProvider implements TranslationProvider {
  readonly name = 'gemini';

  async translate(params: TranslateParams): Promise<TranslationResult> {
    return {
      translatedLyrics: `[${params.targetLang}] ${params.lyrics.slice(0, 80)}`,
      culturalContext: 'Mocked cultural context for acceptance testing.',
      tokensInput: Math.max(1, Math.ceil(params.lyrics.length / 8)),
      tokensOutput: 32,
      tokensUsed: Math.max(1, Math.ceil(params.lyrics.length / 8)) + 32,
      model: 'mock-gemini-v1',
      promptVersion: params.promptVersion ?? 'v1.0',
    };
  }

  async detectLanguage(lyrics: string): Promise<LanguageDetectionResult> {
    return {
      languageCode: languageFromLyrics(lyrics),
      confidence: 0.98,
      tokensInput: 24,
      tokensOutput: 6,
      model: 'mock-gemini-v1',
    };
  }
}

class MockAltProvider extends MockGeminiProvider {
  readonly name = 'mock-alt';
}

class FailingProvider implements TranslationProvider {
  readonly name = 'gemini';

  async translate(_params: TranslateParams): Promise<TranslationResult> {
    throw new Error('Provider unavailable for test');
  }

  async detectLanguage(_lyrics: string): Promise<LanguageDetectionResult> {
    return {
      languageCode: 'en',
      confidence: 0.5,
      tokensInput: 1,
      tokensOutput: 1,
      model: 'failing-provider',
    };
  }
}

async function waitForJobFinalState(jobId: string, timeoutMs = 120_000): Promise<Job | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await translationQueue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') {
        return job;
      }
    }
    await wait(250);
  }
  return null;
}

const main = async () => {
  const port = 4010;
  const baseUrl = `http://127.0.0.1:${port}`;
  const seed = Date.now();
  const testEmail = `translation_acceptance_${seed}@example.com`;

  process.env.AI_TRANSLATION_PROVIDER = 'gemini';
  process.env.AI_PROVIDER = 'gemini';

  registerTranslationProvider('gemini', () => new MockGeminiProvider());
  registerTranslationProvider('mock-alt', () => new MockAltProvider());
  registerTranslationProvider('gemini-fail', () => new FailingProvider());
  resetActiveProvider();

  await translationQueue.drain(true);

  const user = await prisma.user.create({
    data: {
      email: testEmail,
      displayName: 'Translation Acceptance User',
      role: 'USER',
      passwordHash: 'seeded_hash',
    },
  });

  const accessToken = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    env.JWT_SECRET,
    { expiresIn: '15m' },
  );

  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const server = app.listen(port);

  const createdSong = await prisma.song.create({
    data: {
      title: `Empty Lyrics Test ${seed}`,
      artist: {
        create: {
          name: `Acceptance Artist ${seed}`,
          genres: ['Afrobeats'],
        },
      },
      lyrics: {
        create: {
          content: '',
          sourceProvider: 'MANUAL',
          licenseStatus: 'UNKNOWN',
        },
      },
    },
    include: { lyrics: true },
  });

  const createdSongId = createdSong.id;

  let capturedLogs = '';
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, encoding?: BufferEncoding, cb?: (err?: Error | null) => void) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    capturedLogs += text;
    return originalStdoutWrite(chunk as never, encoding as never, cb as never);
  }) as typeof process.stdout.write;

  try {
    const songs = await prisma.song.findMany({
      where: { lyrics: { some: {} } },
      select: { id: true },
      take: 78,
      orderBy: { createdAt: 'asc' },
    });

    addResult(
      'Seed contains at least 78 songs with lyrics',
      songs.length === 78,
      `selected=${songs.length}`,
    );

    if (songs.length !== 78) {
      throw new Error(`Expected 78 songs, found ${songs.length}`);
    }

    await prisma.translation.deleteMany({
      where: {
        userId: user.id,
        targetLang: 'fr',
      },
    });

    await prisma.$executeRaw`DELETE FROM "AICallLog" WHERE "userId" = ${user.id}`;

    const jobIds: string[] = [];

    for (const song of songs) {
      const response = await jsonFetch<{ status?: string; jobId?: string; translation?: { id: string } }>(
        `${baseUrl}/api/translations/request`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ songId: song.id, sourceLang: 'en', targetLang: 'fr' }),
        },
      );

      const ok = response.status === 202 || response.status === 200;
      if (!ok) {
        addResult(
          'Request translation for 78 songs',
          false,
          `failed status=${response.status} on song=${song.id}`,
        );
        throw new Error(`Translation request failed for ${song.id}: status=${response.status}`);
      }

      if (response.body.jobId) {
        jobIds.push(response.body.jobId);
      }
    }

    addResult(
      'Request translation for each of 78 songs returns success response',
      true,
      `queued=${jobIds.length}, existing=${78 - jobIds.length}`,
    );

    const waitStarted = Date.now();
    while (Date.now() - waitStarted < 180_000) {
      const count = await prisma.translation.count({
        where: {
          userId: user.id,
          targetLang: 'fr',
          songId: { in: songs.map((s) => s.id) },
        },
      });

      if (count === 78) {
        break;
      }

      await wait(500);
    }

    const translationCount = await prisma.translation.count({
      where: {
        userId: user.id,
        targetLang: 'fr',
        songId: { in: songs.map((s) => s.id) },
      },
    });

    addResult(
      'All 78 translation jobs produced translation records',
      translationCount === 78,
      `translations=${translationCount}`,
    );

    const keyLeaked = capturedLogs.includes(env.GEMINI_API_KEY);
    addResult(
      'Server logs do not expose Gemini API key in client requests',
      !keyLeaked,
      keyLeaked ? 'API key string found in logs' : 'no key material found in captured logs',
    );

    const logs = await prisma.$queryRaw<Array<{ tokensInput: number; tokensOutput: number }>>`
      SELECT "tokensInput", "tokensOutput"
      FROM "AICallLog"
      WHERE "userId" = ${user.id}
    `;

    const tokenCountsPresent = logs.length >= 78 && logs.every((l) => l.tokensInput > 0 && l.tokensOutput > 0);
    addResult(
      'AICallLog records exist after translation with token counts present',
      tokenCountsPresent,
      `records=${logs.length}`,
    );

    process.env.AI_PROVIDER = 'gemini-fail';
    process.env.AI_TRANSLATION_PROVIDER = 'gemini-fail';
    resetActiveProvider();

    const failReq = await jsonFetch<{ jobId?: string }>(`${baseUrl}/api/translations/request`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ songId: songs[0].id, sourceLang: 'en', targetLang: 'de' }),
    });

    if (!failReq.body.jobId) {
      throw new Error(`Expected queued job for failure scenario, status=${failReq.status}`);
    }

    const failedJob = await waitForJobFinalState(failReq.body.jobId, 180_000);
    if (!failedJob) {
      throw new Error('Timed out waiting for failed job');
    }

    const failedAttempts = failedJob.attemptsMade;
    const failedState = await failedJob.getState();

    const statusRes = await jsonFetch<{ state?: string; userMessage?: string; failedReason?: string }>(
      `${baseUrl}/api/translations/status/${failReq.body.jobId}`,
      {
        method: 'GET',
        headers: authHeaders,
      },
    );

    const retryAndErrorOk =
      failedState === 'failed' &&
      failedAttempts === 3 &&
      statusRes.body.state === 'failed' &&
      typeof statusRes.body.userMessage === 'string' &&
      statusRes.body.userMessage.length > 0;

    addResult(
      'Failing provider retries 3 times, ends failed, and returns clear user error',
      retryAndErrorOk,
      `attempts=${failedAttempts}, state=${statusRes.body.state ?? 'n/a'}`,
    );

    process.env.AI_PROVIDER = 'gemini';
    process.env.AI_TRANSLATION_PROVIDER = 'gemini';
    resetActiveProvider();

    const yoRes = await jsonFetch<{ languageCode?: string }>(`${baseUrl}/api/translations/detect-language`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ lyrics: 'Mo fe lo si ile, emi ni mo so pe o dara gan-an.' }),
    });

    const igRes = await jsonFetch<{ languageCode?: string }>(`${baseUrl}/api/translations/detect-language`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ lyrics: 'anyị ga-azụ ahịa echi, biko gwa nna m ka o bia.' }),
    });

    const pcmRes = await jsonFetch<{ languageCode?: string }>(`${baseUrl}/api/translations/detect-language`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ lyrics: 'Abeg make you no dey cause wahala, na you I dey wait for.' }),
    });

    const languageOk =
      yoRes.status === 200 && yoRes.body.languageCode === 'yo' &&
      igRes.status === 200 && igRes.body.languageCode === 'ig' &&
      pcmRes.status === 200 && pcmRes.body.languageCode === 'pcm';

    addResult(
      'Language detection returns correct codes for Yoruba, Igbo, and Pidgin samples',
      languageOk,
      `yo=${yoRes.body.languageCode ?? 'n/a'}, ig=${igRes.body.languageCode ?? 'n/a'}, pcm=${pcmRes.body.languageCode ?? 'n/a'}`,
    );

    process.env.AI_PROVIDER = 'mock-alt';
    process.env.AI_TRANSLATION_PROVIDER = 'mock-alt';
    resetActiveProvider();
    const activeProvider = getActiveProvider();

    addResult(
      'Changing AI_PROVIDER switches provider without code change',
      activeProvider.name === 'mock-alt',
      `active=${activeProvider.name}`,
    );

    process.env.AI_PROVIDER = 'gemini';
    process.env.AI_TRANSLATION_PROVIDER = 'gemini';
    resetActiveProvider();

    const emptyReq = await jsonFetch<{ jobId?: string }>(`${baseUrl}/api/translations/request`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ songId: createdSongId, sourceLang: 'en', targetLang: 'es' }),
    });

    if (!emptyReq.body.jobId) {
      throw new Error(`Expected empty-lyrics request to queue, status=${emptyReq.status}`);
    }

    const emptyJob = await waitForJobFinalState(emptyReq.body.jobId, 120_000);
    if (!emptyJob) {
      throw new Error('Timed out waiting for empty lyrics job completion');
    }

    const emptyJobState = await emptyJob.getState();
    const emptyStatusRes = await jsonFetch<{ state?: string; userMessage?: string }>(
      `${baseUrl}/api/translations/status/${emptyReq.body.jobId}`,
      {
        method: 'GET',
        headers: authHeaders,
      },
    );

    const emptyTranslation = await prisma.translation.findFirst({
      where: {
        songId: createdSongId,
        userId: user.id,
        sourceLang: 'en',
        targetLang: 'es',
      },
      select: {
        translatedLyrics: true,
        culturalContext: true,
      },
    });

    const gracefulEmptyLyrics =
      emptyJobState === 'completed' &&
      emptyStatusRes.status === 200 &&
      emptyStatusRes.body.state === 'completed' &&
      Boolean(emptyTranslation) &&
      emptyTranslation?.translatedLyrics === '' &&
      typeof emptyTranslation.culturalContext === 'string' &&
      emptyTranslation.culturalContext.length > 0;

    addResult(
      'Empty lyrics translation is graceful (not 500) and returns fallback response',
      gracefulEmptyLyrics,
      `jobState=${emptyJobState}, http=${emptyStatusRes.status}`,
    );
  } finally {
    process.stdout.write = originalStdoutWrite;

    server.close();

    await translationWorker.close();
    await translationQueue.close();

    await prisma.$executeRaw`DELETE FROM "AICallLog" WHERE "userId" = ${user.id}`;
    await prisma.translation.deleteMany({ where: { userId: user.id } });
    await prisma.lyric.deleteMany({ where: { songId: createdSongId } });
    await prisma.song.deleteMany({ where: { id: createdSongId } });
    await prisma.artist.deleteMany({ where: { name: `Acceptance Artist ${seed}` } });
    await prisma.user.deleteMany({ where: { id: user.id } });

    await prisma.$disconnect();
  }

  const failed = results.filter((result) => !result.pass);

  console.log('\n===== Translation Acceptance Summary =====');
  console.log(`Total: ${results.length}`);
  console.log(`Passed: ${results.length - failed.length}`);
  console.log(`Failed: ${failed.length}`);

  if (failed.length > 0) {
    for (const result of failed) {
      console.log(`- ${result.name}: ${result.details}`);
    }
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
};

void main().catch((error) => {
  console.error('Translation acceptance test failed unexpectedly:', error);
  process.exitCode = 1;
});
