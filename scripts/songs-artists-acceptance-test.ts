import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { env } from '../src/lib/env';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { languageCategorizationQueue } from '../src/lib/queue';
import { processLanguageCategorizationJob } from '../src/jobs/languageCategorizationJob';
import {
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

class MockLanguageProvider implements TranslationProvider {
  readonly name = 'mock-language-provider';

  async translate(params: TranslateParams): Promise<TranslationResult> {
    return {
      translatedLyrics: `[${params.targetLang}] ${params.lyrics.slice(0, 40)}`,
      culturalContext: 'mocked',
      tokensInput: 1,
      tokensOutput: 1,
      tokensUsed: 2,
      model: 'mock-v1',
      promptVersion: params.promptVersion ?? 'v1',
    };
  }

  async detectLanguage(lyrics: string): Promise<LanguageDetectionResult> {
    const normalized = lyrics.toLowerCase();
    if (normalized.includes('olorun') || normalized.includes('mo fe') || normalized.includes('eyin')) {
      return { languageCode: 'yo', confidence: 0.99, tokensInput: 1, tokensOutput: 1, model: 'mock-v1' };
    }

    return { languageCode: 'en', confidence: 0.99, tokensInput: 1, tokensOutput: 1, model: 'mock-v1' };
  }
}

const processLanguageJobForSong = async (songId: string): Promise<boolean> => {
  for (let i = 0; i < 20; i += 1) {
    const jobs = await languageCategorizationQueue.getJobs(['waiting', 'delayed'], 0, 50);
    const job = jobs.find((candidate) => {
      const data = candidate.data as { songId?: string };
      return data.songId === songId;
    });

    if (job) {
      await processLanguageCategorizationJob(job as never);
      await job.remove();
      return true;
    }

    await wait(200);
  }

  return false;
};

const main = async () => {
  const port = 4012;
  const baseUrl = `http://127.0.0.1:${port}`;
  const runId = Date.now();

  registerTranslationProvider('mock-language-provider', () => new MockLanguageProvider());
  process.env.AI_PROVIDER = 'mock-language-provider';
  process.env.AI_TRANSLATION_PROVIDER = 'mock-language-provider';
  resetActiveProvider();

  const adminEmail = `songs_admin_${runId}@example.com`;
  const userEmail = `songs_user_${runId}@example.com`;

  const adminUser = await prisma.user.create({
    data: {
      email: adminEmail,
      passwordHash: 'acceptance_hash',
      role: 'ADMIN',
      displayName: 'Songs Admin',
    },
  });

  const normalUser = await prisma.user.create({
    data: {
      email: userEmail,
      passwordHash: 'acceptance_hash',
      role: 'USER',
      displayName: 'Songs User',
    },
  });

  const adminToken = jwt.sign({ userId: adminUser.id, email: adminUser.email, role: adminUser.role }, env.JWT_SECRET, {
    expiresIn: '1h',
  });

  const userToken = jwt.sign({ userId: normalUser.id, email: normalUser.email, role: normalUser.role }, env.JWT_SECRET, {
    expiresIn: '1h',
  });

  const adminHeaders = {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };

  const userHeaders = {
    Authorization: `Bearer ${userToken}`,
    'Content-Type': 'application/json',
  };

  const createdArtistIds: string[] = [];
  const createdSongIds: string[] = [];
  const createdGenreNames = new Set<string>();

  const server = app.listen(port);

  try {
    const migratedSongsCount = await prisma.song.count();
    addResult(
      'All 78 songs are present in PostgreSQL',
      migratedSongsCount === 78,
      `songCount=${migratedSongsCount}`,
    );

    const lyricNulls = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "Lyric"
      WHERE "sourceProvider" IS NULL OR "licenseStatus" IS NULL
    `;

    const lyricNullCount = Number(lyricNulls[0]?.count ?? 0);
    addResult(
      'Every lyric has sourceProvider and licenseStatus populated',
      lyricNullCount === 0,
      `nullRows=${lyricNullCount}`,
    );

    const songsList = await jsonFetch<{
      songs?: Array<{ id: string; artistId: string; songLanguages?: Array<{ languageCode: string; percentage: number }> }>;
      total?: number;
      nextCursor?: string | null;
    }>(`${baseUrl}/api/songs?limit=10`);

    const supportsPagination = songsList.status === 200 && Array.isArray(songsList.body.songs) && typeof songsList.body.total === 'number';
    addResult(
      'GET /api/songs supports pagination and returns total count',
      supportsPagination,
      `status=${songsList.status}, songs=${songsList.body.songs?.length ?? 0}, total=${songsList.body.total ?? 'n/a'}`,
    );

    const firstSongId = songsList.body.songs?.[0]?.id;

    if (!firstSongId) {
      throw new Error('No song returned from /api/songs; cannot continue acceptance checks.');
    }

    const cursorPageOne = await jsonFetch<{ songs?: Array<{ id: string }>; nextCursor?: string | null }>(
      `${baseUrl}/api/songs?limit=5`,
    );
    const cursor = cursorPageOne.body.nextCursor;
    const cursorPageTwo = cursor
      ? await jsonFetch<{ songs?: Array<{ id: string }> }>(`${baseUrl}/api/songs?limit=5&cursor=${encodeURIComponent(cursor)}`)
      : { status: 0, body: {} as { songs?: Array<{ id: string }> } };

    const cursorOk =
      cursorPageOne.status === 200 &&
      typeof cursor === 'string' &&
      cursor.length > 0 &&
      cursorPageTwo.status === 200 &&
      (cursorPageTwo.body.songs?.[0]?.id ?? '') !== (cursorPageOne.body.songs?.[0]?.id ?? '');

    addResult(
      'GET /api/songs supports cursor pagination (cursor, limit)',
      cursorOk,
      `status1=${cursorPageOne.status}, status2=${cursorPageTwo.status}, nextCursor=${cursor ?? 'null'}`,
    );

    const yoFilter = await jsonFetch<{
      songs?: Array<{ id: string; songLanguages?: Array<{ languageCode: string; percentage: number }> }>;
    }>(`${baseUrl}/api/songs?lang=yo&limit=50`);

    const yoFilterOk =
      yoFilter.status === 200 &&
      Array.isArray(yoFilter.body.songs) &&
      yoFilter.body.songs.every((song) =>
        (song.songLanguages ?? []).some(
          (entry) => entry.languageCode.toLowerCase() === 'yo' && Number(entry.percentage) >= 30,
        ),
      );

    addResult(
      'Filtering by lang=yo returns only songs where Yoruba >= 30%',
      yoFilterOk,
      `status=${yoFilter.status}, resultCount=${yoFilter.body.songs?.length ?? 0}`,
    );

    const existingArtistId = songsList.body.songs?.[0]?.artistId;
    const existingSongId = songsList.body.songs?.[0]?.id;
    if (!existingArtistId || !existingSongId) {
      throw new Error('Cannot identify baseline song/artist from list response.');
    }

    const genreRow = await prisma.songGenre.findFirst({
      where: { songId: existingSongId },
      include: { genre: true },
    });

    const songsByArtist = await jsonFetch<{ songs?: Array<{ artistId: string }> }>(
      `${baseUrl}/api/songs?artistId=${encodeURIComponent(existingArtistId)}&limit=30`,
    );
    const artistFilterOk =
      songsByArtist.status === 200 &&
      Array.isArray(songsByArtist.body.songs) &&
      songsByArtist.body.songs.every((song) => song.artistId === existingArtistId);

    const songsByGenre = genreRow
      ? await jsonFetch<{ songs?: Array<{ genres?: Array<{ genre: { name: string } }> }> }>(
          `${baseUrl}/api/songs?genre=${encodeURIComponent(genreRow.genre.name)}&limit=30`,
        )
      : { status: 0, body: {} as { songs?: Array<{ genres?: Array<{ genre: { name: string } }> }> } };

    const genreFilterOk =
      !!genreRow &&
      songsByGenre.status === 200 &&
      Array.isArray(songsByGenre.body.songs) &&
      songsByGenre.body.songs.every((song) =>
        (song.genres ?? []).some((g) => g.genre.name.toLowerCase() === genreRow.genre.name.toLowerCase()),
      );

    addResult(
      'Filter by language, genre, artist query params works',
      artistFilterOk && genreFilterOk,
      `artistStatus=${songsByArtist.status}, genreStatus=${songsByGenre.status}`,
    );

    const artistList = await jsonFetch<{ data?: Array<{ id: string }>; nextCursor?: string | null; total?: number }>(
      `${baseUrl}/api/artists?limit=5`,
    );
    const artistCursor = artistList.body.nextCursor;
    const artistPage2 = artistCursor
      ? await jsonFetch<{ data?: Array<{ id: string }> }>(`${baseUrl}/api/artists?limit=5&cursor=${encodeURIComponent(artistCursor)}`)
      : { status: 0, body: {} as { data?: Array<{ id: string }> } };

    const artistsPaginationOk =
      artistList.status === 200 &&
      Array.isArray(artistList.body.data) &&
      typeof artistList.body.total === 'number' &&
      typeof artistCursor === 'string' &&
      artistPage2.status === 200;

    addResult(
      'GET /api/artists mirrors pagination pattern',
      artistsPaginationOk,
      `status1=${artistList.status}, status2=${artistPage2.status}, nextCursor=${artistCursor ?? 'null'}`,
    );

    const testArtist = await jsonFetch<{ id: string }>(`${baseUrl}/api/artists`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: `Acceptance Artist ${runId}`,
        genres: ['AcceptanceGenre'],
      }),
    });

    if (testArtist.status !== 201 || !testArtist.body.id) {
      throw new Error(`Failed to create test artist: status=${testArtist.status}`);
    }

    createdArtistIds.push(testArtist.body.id);

    const bilingualSongRes = await jsonFetch<{ id: string }>(`${baseUrl}/api/songs`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        title: `Acceptance Bilingual Song ${runId}`,
        artistId: testArtist.body.id,
        albumName: 'Acceptance Album',
        releaseYear: 2026,
        genres: ['AcceptanceGenre'],
        languages: ['yo', 'en'],
        lyrics: {
          rawText: 'Mo fe dupe fun olorun, this is acceptance lyrics in mixed language',
        },
      }),
    });

    if (bilingualSongRes.status !== 201 || !bilingualSongRes.body.id) {
      throw new Error(`Failed to create bilingual song: status=${bilingualSongRes.status}`);
    }

    createdSongIds.push(bilingualSongRes.body.id);
    createdGenreNames.add('AcceptanceGenre');

    const yoLanguage = await prisma.language.upsert({
      where: { code: 'yo' },
      create: { code: 'yo', name: 'Yoruba' },
      update: {},
    });

    const enLanguage = await prisma.language.upsert({
      where: { code: 'en' },
      create: { code: 'en', name: 'English' },
      update: {},
    });

    await prisma.songLanguage.upsert({
      where: { songId_languageCode: { songId: bilingualSongRes.body.id, languageCode: yoLanguage.code } },
      create: { songId: bilingualSongRes.body.id, languageCode: yoLanguage.code, percentage: 40 },
      update: { percentage: 40 },
    });

    await prisma.songLanguage.upsert({
      where: { songId_languageCode: { songId: bilingualSongRes.body.id, languageCode: enLanguage.code } },
      create: { songId: bilingualSongRes.body.id, languageCode: enLanguage.code, percentage: 60 },
      update: { percentage: 60 },
    });

    const yoSongsAfterCreate = await jsonFetch<{ songs?: Array<{ id: string }> }>(`${baseUrl}/api/songs?lang=yo&limit=100`);
    const enSongsAfterCreate = await jsonFetch<{ songs?: Array<{ id: string }> }>(`${baseUrl}/api/songs?lang=en&limit=100`);

    const inYo = (yoSongsAfterCreate.body.songs ?? []).some((song) => song.id === bilingualSongRes.body.id);
    const inEn = (enSongsAfterCreate.body.songs ?? []).some((song) => song.id === bilingualSongRes.body.id);

    addResult(
      'Song with 40% Yoruba + 60% English appears in BOTH categories',
      inYo && inEn,
      `inYo=${inYo}, inEn=${inEn}`,
    );

    const createdSongInGenreFilter = await jsonFetch<{ songs?: Array<{ id: string }> }>(
      `${baseUrl}/api/songs?genre=${encodeURIComponent('AcceptanceGenre')}&artistId=${encodeURIComponent(testArtist.body.id)}&limit=20`,
    );

    const genreArtistCombinedOk =
      createdSongInGenreFilter.status === 200 &&
      (createdSongInGenreFilter.body.songs ?? []).some((song) => song.id === bilingualSongRes.body.id);

    addResult(
      'Created song is queryable via genre + artist filters',
      genreArtistCombinedOk,
      `status=${createdSongInGenreFilter.status}, found=${genreArtistCombinedOk}`,
    );

    await prisma.translation.create({
      data: {
        songId: bilingualSongRes.body.id,
        userId: adminUser.id,
        originalLyrics: 'original',
        translatedLyrics: 'translation-fr',
        sourceLang: 'en',
        targetLang: 'fr',
        status: 'APPROVED',
      },
    });

    const detailsRes = await jsonFetch<{
      id?: string;
      artist?: { id: string };
      lyrics?: Array<{ id: string }>;
      latestApprovedTranslations?: Record<string, { translatedLyrics: string }>;
    }>(`${baseUrl}/api/songs/${bilingualSongRes.body.id}`);

    const detailsOk =
      detailsRes.status === 200 &&
      detailsRes.body.id === bilingualSongRes.body.id &&
      !!detailsRes.body.artist &&
      Array.isArray(detailsRes.body.lyrics) &&
      detailsRes.body.lyrics.length > 0 &&
      !!detailsRes.body.latestApprovedTranslations?.fr;

    addResult(
      'GET /api/songs/:id returns song + artist + lyrics + latest translation',
      detailsOk,
      `status=${detailsRes.status}, hasArtist=${!!detailsRes.body.artist}, hasLyric=${(detailsRes.body.lyrics ?? []).length > 0}, hasFr=${!!detailsRes.body.latestApprovedTranslations?.fr}`,
    );

    const redisKey = `song:views:${bilingualSongRes.body.id}`;
    await redis.del(redisKey);
    const beforeViews = await prisma.song.findUnique({ where: { id: bilingualSongRes.body.id }, select: { views: true } });

    await jsonFetch(`${baseUrl}/api/songs/${bilingualSongRes.body.id}`);
    await jsonFetch(`${baseUrl}/api/songs/${bilingualSongRes.body.id}`);

    const redisViews = Number((await redis.get(redisKey)) ?? '0');
    const afterViews = await prisma.song.findUnique({ where: { id: bilingualSongRes.body.id }, select: { views: true } });

    const viewCounterOk = redisViews >= 2 && beforeViews?.views === afterViews?.views;

    addResult(
      'View counter uses Redis atomic increment with no DB write per view request',
      viewCounterOk,
      `redisCount=${redisViews}, dbBefore=${beforeViews?.views ?? 'n/a'}, dbAfter=${afterViews?.views ?? 'n/a'}`,
    );

    const forbiddenPostSongs = await jsonFetch(`${baseUrl}/api/songs`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ title: 'x', artistId: testArtist.body.id }),
    });
    const forbiddenPatchSongs = await jsonFetch(`${baseUrl}/api/songs/${bilingualSongRes.body.id}`, {
      method: 'PATCH',
      headers: userHeaders,
      body: JSON.stringify({ title: 'x2' }),
    });
    const forbiddenDeleteSongs = await jsonFetch(`${baseUrl}/api/songs/${bilingualSongRes.body.id}`, {
      method: 'DELETE',
      headers: userHeaders,
    });
    const unauthorizedAdminSongs = await jsonFetch(`${baseUrl}/api/admin/songs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', artistId: testArtist.body.id }),
    });

    const protectedOk =
      forbiddenPostSongs.status === 403 &&
      forbiddenPatchSongs.status === 403 &&
      forbiddenDeleteSongs.status === 403 &&
      unauthorizedAdminSongs.status === 401;

    addResult(
      'Admin endpoints are protected by requireRole(ADMIN)',
      protectedOk,
      `post403=${forbiddenPostSongs.status}, patch403=${forbiddenPatchSongs.status}, delete403=${forbiddenDeleteSongs.status}, anon401=${unauthorizedAdminSongs.status}`,
    );

    const patchRes = await jsonFetch<{ title?: string }>(`${baseUrl}/api/songs/${bilingualSongRes.body.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ title: `Acceptance Updated ${runId}` }),
    });

    addResult(
      'PATCH /api/songs/:id (admin only) updates metadata',
      patchRes.status === 200 && patchRes.body.title === `Acceptance Updated ${runId}`,
      `status=${patchRes.status}, title=${patchRes.body.title ?? 'n/a'}`,
    );

    const autoLangSong = await jsonFetch<{ id: string }>(`${baseUrl}/api/songs`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        title: `Acceptance AutoLang ${runId}`,
        artistId: testArtist.body.id,
        albumName: 'Acceptance Album',
        releaseYear: 2026,
        genres: ['AcceptanceGenre'],
        lyrics: {
          rawText: 'Mo fe dupe, olorun oba, eyin eniyan, we sing with joy',
        },
      }),
    });

    if (autoLangSong.status !== 201 || !autoLangSong.body.id) {
      throw new Error(`Failed to create auto-language song: status=${autoLangSong.status}`);
    }

    createdSongIds.push(autoLangSong.body.id);

    const processed = await processLanguageJobForSong(autoLangSong.body.id);
    const detectedLanguage = await prisma.songLanguage.findFirst({
      where: { songId: autoLangSong.body.id, languageCode: 'yo' },
    });

    addResult(
      'Language auto-detection runs when primaryLanguage is not provided',
      processed && !!detectedLanguage && detectedLanguage.percentage >= 30,
      `jobProcessed=${processed}, yoPct=${detectedLanguage?.percentage ?? 'none'}`,
    );

    const deleteRes = await jsonFetch<{ success?: boolean }>(`${baseUrl}/api/songs/${bilingualSongRes.body.id}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });

    const softDeleteRow = await prisma.$queryRaw<Array<{ softDeleted: boolean }>>`
      SELECT "softDeleted"
      FROM "Song"
      WHERE "id" = ${bilingualSongRes.body.id}
      LIMIT 1
    `;

    const deletedPublic = await jsonFetch(`${baseUrl}/api/songs/${bilingualSongRes.body.id}`);
    const listAfterDelete = await jsonFetch<{ songs?: Array<{ id: string }> }>(`${baseUrl}/api/songs?limit=200`);

    const softDeleteOk =
      deleteRes.status === 200 &&
      softDeleteRow[0]?.softDeleted === true &&
      deletedPublic.status === 404 &&
      !(listAfterDelete.body.songs ?? []).some((song) => song.id === bilingualSongRes.body.id);

    addResult(
      'DELETE /api/songs/:id soft-deletes and public API excludes softDeleted records',
      softDeleteOk,
      `deleteStatus=${deleteRes.status}, softDeleted=${softDeleteRow[0]?.softDeleted ?? 'n/a'}, getAfterDelete=${deletedPublic.status}`,
    );
  } finally {
    server.close();

    for (const songId of createdSongIds) {
      await prisma.translation.deleteMany({ where: { songId } });
      await prisma.songGenre.deleteMany({ where: { songId } });
      await prisma.songLanguage.deleteMany({ where: { songId } });
      await prisma.lyric.deleteMany({ where: { songId } });
      await prisma.song.deleteMany({ where: { id: songId } });
      await redis.del(`song:views:${songId}`);
    }

    for (const artistId of createdArtistIds) {
      await prisma.artist.deleteMany({ where: { id: artistId } });
    }

    for (const name of createdGenreNames) {
      await prisma.genre.deleteMany({ where: { name } });
    }

    await prisma.user.deleteMany({ where: { id: adminUser.id } });
    await prisma.user.deleteMany({ where: { id: normalUser.id } });

    await languageCategorizationQueue.obliterate({ force: true });
    await prisma.$disconnect();
    await redis.quit();
  }

  const failed = results.filter((result) => !result.pass);

  console.log('\n===== Songs & Artists Acceptance Summary =====');
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
  console.error('Songs/artists acceptance run failed unexpectedly:', error);
  process.exitCode = 1;
});
