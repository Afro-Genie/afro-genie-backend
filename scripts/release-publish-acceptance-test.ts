/**
 * End-to-end acceptance test for the artist release publish flow.
 *
 * Runs the real Express app in-process on an ephemeral port against the live
 * database, then drives the HTTP flow: create songs -> create release (draft /
 * scheduled / publish-now) -> publish -> verify public visibility -> verify
 * terminal status rules -> cleanup.
 *
 * Run: npx tsx scripts/release-publish-acceptance-test.ts
 */

import 'dotenv/config';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { prisma } from '../src/lib/prisma';

let base = '';
let server: ReturnType<typeof createServer>;

const results: { name: string; ok: boolean; detail?: string }[] = [];

function record(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const todayStr = () => new Date().toISOString().split('T')[0];

async function req(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function catalogContainsSong(songId: string, artistId: string, expected: boolean) {
  const res = await req('GET', `/catalog/songs?artistId=${artistId}&limit=500`);
  const ids = new Set((res.data?.songs ?? []).map((s: { id: string }) => s.id));
  return ids.has(songId) === expected;
}

async function main() {
  server = createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      base = `http://127.0.0.1:${(addr as { port: number }).port}/api`;
      resolve();
    }),
  );

  const userEmail = `release-e2e-${Date.now()}-${randomUUID().slice(0, 6)}@afrogenie.test`;
  const userPassword = 'TestPassword123!';

  // ─── Setup: register user, promote to ARTIST, link Artist row ─────────────
  const reg = await req('POST', '/auth/register', {
    email: userEmail,
    password: userPassword,
    displayName: 'Release E2E Artist',
  });
  const userId = reg.data?.user?.id;
  record('register test user', reg.status === 201 && !!userId, `status=${reg.status}`);

  await prisma.user.update({ where: { id: userId }, data: { role: 'ARTIST' } });
  const artist = await prisma.artist.create({
    data: { userId, name: `Release E2E ${randomUUID().slice(0, 8)}` },
  });
  const token = jwt.sign(
    { userId, sub: userId, email: userEmail, role: 'ARTIST' },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  );

  const songTargets = ['alpha', 'bravo', 'charlie'].map(
    (n) => ({ title: `E2E ${n} ${randomUUID().slice(0, 6)}` }),
  );

  try {
    // ─── Create songs ──────────────────────────────────────────────────────
    const songIds: string[] = [];
    for (const t of songTargets) {
      const s = await req('POST', '/artists/me/songs', { title: t.title }, token);
      record(`create song "${t.title}"`, s.status === 201 && !!s.data.songId, `status=${s.status}`);
      songIds.push(s.data.songId);
    }
    const [s1, s2, s3] = songIds;

    // ─── Release A: create as DRAFT with 2 tracks ──────────────────────────
    const draftRelease = await req(
      'POST',
      '/artists/me/releases',
      { title: `E2E Draft Album ${randomUUID().slice(0, 6)}`, type: 'ALBUM', status: 'DRAFT', songIds: [s1, s2] },
      token,
    );
    record(
      'create release as DRAFT',
      draftRelease.status === 201 && draftRelease.data.status === 'DRAFT',
      `status=${draftRelease.status}, releaseStatus=${draftRelease.data?.status}`,
    );
    const releaseA = draftRelease.data.releaseId;

    const listA = await req('GET', '/artists/me/releases', undefined, token);
    const a = listA.data?.releases?.find((r: { id: string }) => r.id === releaseA);
    record(
      'GET releases maps tracks + trackCount',
      !!a && a.trackCount === 2 && Array.isArray(a.tracks) && a.tracks.length === 2,
      JSON.stringify(a ? { trackCount: a.trackCount, tracks: a.tracks } : listA.data),
    );

    // Gap check: DRAFT-release songs must NOT be publicly visible
    const draftHidden = await catalogContainsSong(s1, artist.id, false);
    record('gap: DRAFT release songs hidden from public catalog', draftHidden);

    // ─── Publish release A now ─────────────────────────────────────────────
    const pubA = await req(
      'PUT',
      `/artists/me/releases/${releaseA}`,
      { status: 'PUBLISHED' },
      token,
    );
    record('publish draft release (publish now)', pubA.status === 200 && pubA.data.status === 'PUBLISHED', `status=${pubA.status}`);

    const dbA = await prisma.release.findUnique({ where: { id: releaseA } });
    record(
      'publish now sets releaseDate to today',
      !!dbA && dbA.releaseDate != null && dbA.releaseDate.toISOString().split('T')[0] === todayStr(),
      `releaseDate=${dbA?.releaseDate?.toISOString()}`,
    );

    const dbS1 = await prisma.song.findUnique({ where: { id: s1 } });
    const dbS2 = await prisma.song.findUnique({ where: { id: s2 } });
    record(
      'published release marks tracks released',
      !!dbS1 && !!dbS2 && dbS1.released === true && dbS2.released === true,
      `s1.released=${dbS1?.released}, s2.released=${dbS2?.released}`,
    );

    // View live: public song detail must resolve after publishing
    const live = await req('GET', `/songs/${s1}`);
    record(
      'view-live link resolves public song detail',
      live.status === 200 && !!live.data?.id,
      `status=${live.status}`,
    );

    const pubVis = await catalogContainsSong(s1, artist.id, true);
    record('published release songs visible in catalog', pubVis);

    // ─── Release B: create as SCHEDULED with future date ───────────────────
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const schedRelease = await req(
      'POST',
      '/artists/me/releases',
      { title: `E2E Scheduled Single ${randomUUID().slice(0, 6)}`, type: 'SINGLE', status: 'SCHEDULED', releaseDate: future, songIds: [s3] },
      token,
    );
    record(
      'create release as SCHEDULED',
      schedRelease.status === 201 && schedRelease.data.status === 'SCHEDULED',
      `status=${schedRelease.status}, releaseStatus=${schedRelease.data?.status}`,
    );
    const releaseB = schedRelease.data.releaseId;

    const dbB0 = await prisma.release.findUnique({ where: { id: releaseB } });
    const dbS3hidden = await prisma.song.findUnique({ where: { id: s3 } });
    record(
      'scheduled release stays private (song not released, hidden)',
      !!dbB0 && dbB0.status === 'SCHEDULED' && dbS3hidden?.released === false,
      `status=${dbB0?.status}, s3.released=${dbS3hidden?.released}`,
    );
    const schedHidden = await catalogContainsSong(s3, artist.id, false);
    record('gap-check: scheduled release songs hidden from catalog', schedHidden);

    // Publish scheduled release now
    const pubB = await req(
      'PUT',
      `/artists/me/releases/${releaseB}`,
      { status: 'PUBLISHED' },
      token,
    );
    record('publish scheduled release now', pubB.status === 200 && pubB.data.status === 'PUBLISHED', `status=${pubB.status}`);
    const dbS3 = await prisma.song.findUnique({ where: { id: s3 } });
    record('published scheduled release marks track released', dbS3?.released === true, `s3.released=${dbS3?.released}`);

    // ─── Terminal status rules ──────────────────────────────────────────────
    const backToDraft = await req('PUT', `/artists/me/releases/${releaseA}`, { status: 'DRAFT' }, token);
    record('gap-check: cannot unpublish published release (DRAFT rejected)', backToDraft.status === 400, `status=${backToDraft.status}`);

    const backToSched = await req('PUT', `/artists/me/releases/${releaseA}`, { status: 'SCHEDULED' }, token);
    record('cannot schedule an already-published release', backToSched.status === 400, `status=${backToSched.status}`);

    // Gap check: SCHEDULED without a future date must be rejected
    const noDateSched = await req(
      'POST',
      '/artists/me/releases',
      { title: `E2E Bad Sched ${randomUUID().slice(0, 6)}`, type: 'SINGLE', status: 'SCHEDULED', songIds: [] },
      token,
    );
    record('gap-check: SCHEDULED release requires a future release date', noDateSched.status === 400, `status=${noDateSched.status}`);

    const pastSched = await req(
      'POST',
      '/artists/me/releases',
      { title: `E2E Past Sched ${randomUUID().slice(0, 6)}`, type: 'SINGLE', status: 'SCHEDULED', releaseDate: '2020-01-01', songIds: [] },
      token,
    );
    record('gap-check: SCHEDULED release requires a FUTURE release date', pastSched.status === 400, `status=${pastSched.status}`);

    // Editing a published release keeps its tracks + status stable
    const editA = await req(
      'PUT',
      `/artists/me/releases/${releaseA}`,
      { title: `${dbA?.title} (revised)`, songIds: [s1, s2] },
      token,
    );
    record('edit published release without touching status', editA.status === 200, `status=${editA.status}`);
    const dbA2 = await prisma.release.findUnique({ where: { id: releaseA } });
    const dbS2b = await prisma.song.findUnique({ where: { id: s2 } });
    record(
      'editing published release keeps status + released flag',
      !!dbA2 && dbA2.status === 'PUBLISHED' && dbS2b?.released === true,
      `status=${dbA2?.status}, s2.released=${dbS2b?.released}`,
    );

    await sleep(150);
  } catch (err) {
    record('uncaught test error', false, String(err));
  } finally {
    // ─── Cleanup ────────────────────────────────────────────────────────────
    await prisma.song.deleteMany({ where: { artistId: artist.id } });
    await prisma.release.deleteMany({ where: { artistId: artist.id } });
    await prisma.artist.deleteMany({ where: { id: artist.id } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  }

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.filter((r) => r.ok).length} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    failures.forEach((f) => console.log(`  FAILED: ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
  }
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});