import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { env } from '../src/lib/env';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { getSongById } from '../src/services/songService';

type TestResult = {
  name: string;
  pass: boolean;
  details: string;
};

const results: TestResult[] = [];

const addResult = (name: string, pass: boolean, details: string) => {
  results.push({ name, pass, details });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} :: ${details}`);
};

const jsonFetch = async <T = unknown>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
};

const run = async () => {
  const runId = Date.now();
  const port = 4025;
  const baseUrl = `http://127.0.0.1:${port}`;

  const admin = await prisma.user.create({
    data: {
      email: `checklist_admin_${runId}@example.com`,
      passwordHash: 'checklist_hash',
      role: 'ADMIN',
      displayName: 'Checklist Admin',
    },
  });

  const nonAdmin = await prisma.user.create({
    data: {
      email: `checklist_user_${runId}@example.com`,
      passwordHash: 'checklist_hash',
      role: 'USER',
      displayName: 'Checklist User',
    },
  });

  const adminToken = jwt.sign({ userId: admin.id, email: admin.email, role: admin.role }, env.JWT_SECRET, { expiresIn: '1h' });
  const nonAdminToken = jwt.sign({ userId: nonAdmin.id, email: nonAdmin.email, role: nonAdmin.role }, env.JWT_SECRET, { expiresIn: '1h' });

  const adminHeaders = {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };

  const nonAdminHeaders = {
    Authorization: `Bearer ${nonAdminToken}`,
    'Content-Type': 'application/json',
  };

  const createdSongIds: string[] = [];
  const createdArtistIds: string[] = [];

  const server = app.listen(port);

  try {
    const page2 = await jsonFetch<{
      songs?: Array<{ id: string }>;
      total?: number;
      page?: number;
      totalPages?: number;
    }>(`${baseUrl}/api/songs?page=2&limit=10`);

    const page2Ok =
      page2.status === 200 &&
      Array.isArray(page2.body.songs) &&
      page2.body.songs.length === 10 &&
      typeof page2.body.total === 'number' &&
      typeof page2.body.page === 'number' &&
      typeof page2.body.totalPages === 'number' &&
      page2.body.page === 2;

    addResult(
      'GET /api/songs?page=2&limit=10 returns 10 songs with pagination metadata',
      page2Ok,
      `status=${page2.status}, songs=${page2.body.songs?.length ?? 0}, page=${page2.body.page ?? 'n/a'}, total=${page2.body.total ?? 'n/a'}`,
    );

    const yo = await jsonFetch<{ songs?: Array<{ id: string; songLanguages?: Array<{ languageCode: string; percentage: number }> }> }>(
      `${baseUrl}/api/songs?lang=yo&limit=50`,
    );

    const yoOnly =
      yo.status === 200 &&
      Array.isArray(yo.body.songs) &&
      yo.body.songs.every((song) =>
        (song.songLanguages ?? []).some((sl) => sl.languageCode.toLowerCase() === 'yo' && Number(sl.percentage) >= 30),
      );

    addResult(
      'GET /api/songs?lang=yo returns only Yoruba-categorised songs',
      yoOnly,
      `status=${yo.status}, count=${yo.body.songs?.length ?? 0}`,
    );

    const artistRes = await jsonFetch<{ id: string }>(`${baseUrl}/api/artists`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: `Checklist Artist ${runId}`,
        imageUrl: 'https://example.com/artist.jpg',
        genres: ['ChecklistGenre'],
      }),
    });

    if (artistRes.status !== 201 || !artistRes.body.id) {
      throw new Error(`Unable to create checklist artist. status=${artistRes.status}`);
    }

    createdArtistIds.push(artistRes.body.id);

    const songRes = await jsonFetch<{ id: string }>(`${baseUrl}/api/songs`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        title: `Checklist Mixed Song ${runId}`,
        artistId: artistRes.body.id,
        albumName: 'Checklist Album',
        releaseYear: 2026,
        genres: ['ChecklistGenre'],
        languages: ['yo', 'en'],
        lyrics: {
          rawText: 'Mo fe dupe, olorun, eyin eniyan, this is a mixed language test lyric.',
        },
      }),
    });

    if (songRes.status !== 201 || !songRes.body.id) {
      throw new Error(`Unable to create checklist song. status=${songRes.status}`);
    }

    createdSongIds.push(songRes.body.id);

    await prisma.songLanguage.upsert({
      where: { songId_languageCode: { songId: songRes.body.id, languageCode: 'yo' } },
      create: { songId: songRes.body.id, languageCode: 'yo', percentage: 40 },
      update: { percentage: 40 },
    });

    await prisma.songLanguage.upsert({
      where: { songId_languageCode: { songId: songRes.body.id, languageCode: 'en' } },
      create: { songId: songRes.body.id, languageCode: 'en', percentage: 60 },
      update: { percentage: 60 },
    });

    const yoAfter = await jsonFetch<{ songs?: Array<{ id: string }> }>(`${baseUrl}/api/songs?lang=yo&limit=50`);
    const enAfter = await jsonFetch<{ songs?: Array<{ id: string }> }>(`${baseUrl}/api/songs?lang=en&limit=50`);

    const mixedBoth =
      (yoAfter.body.songs ?? []).some((song) => song.id === songRes.body.id) &&
      (enAfter.body.songs ?? []).some((song) => song.id === songRes.body.id);

    addResult(
      'Mixed Yoruba/English song appears in both language categories',
      mixedBoth,
      `inYo=${(yoAfter.body.songs ?? []).some((song) => song.id === songRes.body.id)}, inEn=${(enAfter.body.songs ?? []).some((song) => song.id === songRes.body.id)}`,
    );

    const viewKey = `song:views:${songRes.body.id}`;
    await redis.del(viewKey);

    const beforeDb = await prisma.song.findUnique({ where: { id: songRes.body.id }, select: { views: true } });

    await Promise.all(Array.from({ length: 1000 }, () => getSongById(songRes.body.id)));

    const afterDb = await prisma.song.findUnique({ where: { id: songRes.body.id }, select: { views: true } });
    const redisCount = Number((await redis.get(viewKey)) ?? '0');

    const rapidViewOk = redisCount >= 1000 && beforeDb?.views === afterDb?.views;

    addResult(
      'View song 1000 times rapidly has no DB write errors and Redis increments atomically',
      rapidViewOk,
      `redisCount=${redisCount}, dbBefore=${beforeDb?.views ?? 'n/a'}, dbAfter=${afterDb?.views ?? 'n/a'}`,
    );

    const seededSourceProvider = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(DISTINCT s."id")::bigint AS count
      FROM "Song" s
      JOIN "Lyric" l ON l."songId" = s."id"
      WHERE l."sourceProvider" IS NOT NULL
    `;

    const seededWithSourceProvider = Number(seededSourceProvider[0]?.count ?? 0);

    addResult(
      'All 78 songs have sourceProvider set (not null)',
      seededWithSourceProvider >= 78,
      `songsWithSourceProvider=${seededWithSourceProvider}`,
    );

    await prisma.translation.create({
      data: {
        songId: songRes.body.id,
        userId: admin.id,
        originalLyrics: 'orig',
        translatedLyrics: 'trad-fr',
        sourceLang: 'en',
        targetLang: 'fr',
        status: 'APPROVED',
      },
    });

    const details = await jsonFetch<{
      artist?: { name?: string; imageUrl?: string | null };
      lyrics?: Array<{ content?: string | null }>;
      latestApprovedTranslations?: Record<string, { translatedLyrics?: string }>;
    }>(`${baseUrl}/api/songs/${songRes.body.id}`);

    const detailsOk =
      details.status === 200 &&
      !!details.body.artist?.name &&
      !!details.body.artist?.imageUrl &&
      Array.isArray(details.body.lyrics) &&
      (details.body.lyrics ?? []).length > 0 &&
      !!details.body.latestApprovedTranslations?.fr?.translatedLyrics;

    addResult(
      'GET /api/songs/:id has artist name, image, lyrics, translation',
      detailsOk,
      `status=${details.status}, artistName=${details.body.artist?.name ?? 'n/a'}, image=${details.body.artist?.imageUrl ?? 'n/a'}, lyrics=${(details.body.lyrics ?? []).length}, hasFr=${!!details.body.latestApprovedTranslations?.fr}`,
    );

    const nonAdminDelete = await jsonFetch(`${baseUrl}/api/admin/songs/${songRes.body.id}`, {
      method: 'DELETE',
      headers: nonAdminHeaders,
    });

    addResult(
      'DELETE /api/admin/songs/:id as non-admin returns 403',
      nonAdminDelete.status === 403,
      `status=${nonAdminDelete.status}`,
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

    await prisma.genre.deleteMany({ where: { name: 'ChecklistGenre' } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
    await prisma.user.deleteMany({ where: { id: nonAdmin.id } });

    await prisma.$disconnect();
    await redis.quit();
  }

  const failed = results.filter((result) => !result.pass);

  console.log('\n===== Songs/Artists Checklist Summary =====');
  console.log(`Total: ${results.length}`);
  console.log(`Passed: ${results.length - failed.length}`);
  console.log(`Failed: ${failed.length}`);

  if (failed.length > 0) {
    for (const row of failed) {
      console.log(`- ${row.name}: ${row.details}`);
    }
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
};

void run().catch((error) => {
  console.error('Checklist run failed unexpectedly:', error);
  process.exitCode = 1;
});
