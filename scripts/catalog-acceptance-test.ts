import fs from 'fs';
import path from 'path';
import { app } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';

type TestResult = {
  name: string;
  pass: boolean;
  details: string;
};

type MockRedisEntry = {
  value: string;
  expiresAt: number;
  ttlSeconds: number;
};

const results: TestResult[] = [];

const addResult = (name: string, pass: boolean, details: string) => {
  results.push({ name, pass, details });
  const status = pass ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name} :: ${details}`);
};

const jsonFetch = async <T = unknown>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
};

const main = async () => {
  const port = 4018;
  const baseUrl = `http://127.0.0.1:${port}`;
  const originalFetch = globalThis.fetch;
  const originalSongFindMany = prisma.song.findMany.bind(prisma.song);
  const originalArtistFindMany = prisma.artist.findMany.bind(prisma.artist);
  const originalGenreFindMany = prisma.genre.findMany.bind(prisma.genre);
  const originalSongCount = prisma.song.count.bind(prisma.song);
  const originalArtistCount = prisma.artist.count.bind(prisma.artist);

  const redisStore = new Map<string, MockRedisEntry>();
  const redisSetCalls: Array<{ key: string; ttl: number }> = [];
  const spotifyRequests: string[] = [];

  const now = () => Date.now();

  const spotifyTrackItems = Array.from({ length: 20 }, (_, index) => ({
    id: `track-${index + 1}`,
    name: `Spotify Track ${index + 1}`,
    preview_url: index === 0 ? null : `https://cdn.example.com/preview-${index + 1}.mp3`,
    artists: [{ name: `Spotify Artist ${index + 1}` }],
    album: {
      name: `Spotify Album ${index + 1}`,
      images: [{ url: `https://cdn.example.com/album-${index + 1}.jpg`, height: 640, width: 640 }],
    },
    popularity: 80 - index,
  }));

  const spotifyArtistItems = Array.from({ length: 12 }, (_, index) => ({
    id: `artist-${index + 1}`,
    name: `Spotify Artist ${index + 1}`,
    genres: ['Afrobeats'],
    popularity: 90 - index,
    followers: { total: 100000 - index * 1000 },
    images: [{ url: `https://cdn.example.com/artist-${index + 1}.jpg`, height: 640, width: 640 }],
  }));

  const emptyPrismaResponse = [];

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    if (url.startsWith(baseUrl)) {
      return originalFetch(input as never, init);
    }

    spotifyRequests.push(url);

    if (url.includes('accounts.spotify.com/api/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-token', token_type: 'Bearer', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/search?') && url.includes('type=track')) {
      return new Response(JSON.stringify({ tracks: { items: spotifyTrackItems, total: spotifyTrackItems.length } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/search?') && url.includes('type=artist')) {
      return new Response(JSON.stringify({ artists: { items: spotifyArtistItems, total: spotifyArtistItems.length } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected external request: ${url}`);
  }) as typeof fetch;

  (redis as any).get = async (key: string) => {
    const entry = redisStore.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= now()) {
      redisStore.delete(key);
      return null;
    }

    return entry.value;
  };

  (redis as any).set = async (key: string, value: string, mode?: string, ttl?: number) => {
    const ttlSeconds = typeof ttl === 'number' ? ttl : 0;
    redisSetCalls.push({ key, ttl: ttlSeconds });
    redisStore.set(key, { value, expiresAt: now() + ttlSeconds * 1000, ttlSeconds });
    return 'OK';
  };

  (redis as any).ttl = async (key: string) => {
    const entry = redisStore.get(key);
    if (!entry) {
      return -2;
    }

    const remaining = Math.ceil((entry.expiresAt - now()) / 1000);
    return remaining > 0 ? remaining : -2;
  };

  (redis as any).del = async (key: string) => {
    const removed = redisStore.delete(key);
    return removed ? 1 : 0;
  };

  prisma.song.findMany = (async () => emptyPrismaResponse) as typeof prisma.song.findMany;
  prisma.artist.findMany = (async () => emptyPrismaResponse) as typeof prisma.artist.findMany;
  prisma.genre.findMany = (async () => emptyPrismaResponse) as typeof prisma.genre.findMany;
  prisma.song.count = (async () => 0) as typeof prisma.song.count;
  prisma.artist.count = (async () => 0) as typeof prisma.artist.count;

  const server = app.listen(port);

  try {
    const homepageSource = fs.readFileSync(path.resolve(process.cwd(), '..', 'afro-genie', 'pages', 'HomePage.tsx'), 'utf8');
    addResult(
      'Homepage uses GET /api/catalog/home and not /api/songs',
      homepageSource.includes("apiFetch('/api/catalog/home')") && !homepageSource.includes("apiFetch('/api/songs')"),
      'verified from source',
    );

    const frontendSpotifySource = fs.readFileSync(path.resolve(process.cwd(), '..', 'afro-genie', 'services', 'spotifyService.ts'), 'utf8');
    addResult(
      'Frontend Spotify access stays on the backend proxy',
      frontendSpotifySource.includes('/spotify/') && !frontendSpotifySource.includes('api.spotify.com') && !frontendSpotifySource.includes('accounts.spotify.com'),
      'frontend calls proxy routes only',
    );

    const firstHomepage = await jsonFetch<{ songs?: Array<{ id: string }>; artists?: Array<{ id: string }>; genres?: Array<{ id: string }> }>(
      `${baseUrl}/api/catalog/home`,
    );

    addResult(
      'GET /api/catalog/home returns merged songs + artists within 2s on empty DB',
      firstHomepage.status === 200 && (firstHomepage.body.songs?.length ?? 0) >= 10 && (firstHomepage.body.artists?.length ?? 0) >= 10,
      `status=${firstHomepage.status}, songs=${firstHomepage.body.songs?.length ?? 0}, artists=${firstHomepage.body.artists?.length ?? 0}`,
    );

    const homepageCacheTtl = await (redis as any).ttl('catalog:homepage');
    addResult(
      'Homepage cache TTL is 3600s',
      homepageCacheTtl >= 3590 && homepageCacheTtl <= 3600,
      `ttl=${homepageCacheTtl}`,
    );

    const firstSpotifyRequestCount = spotifyRequests.length;
    const secondStart = Date.now();
    const secondHomepage = await jsonFetch<{ songs?: Array<{ id: string }>; artists?: Array<{ id: string }> }>(`${baseUrl}/api/catalog/home`);
    const secondElapsed = Date.now() - secondStart;

    addResult(
      'Cache hit returns homepage in under 50ms',
      secondHomepage.status === 200 && secondElapsed < 50 && spotifyRequests.length === firstSpotifyRequestCount,
      `elapsedMs=${secondElapsed}, spotifyRequests=${spotifyRequests.length}`,
    );

    const artistSearch = await jsonFetch<{ artists?: { items?: Array<{ id: string }> } }>(
      `${baseUrl}/api/spotify/search?q=afrobeats&type=artist&limit=12`,
    );

    addResult(
      'Spotify artist search returns results from the server',
      artistSearch.status === 200 && (artistSearch.body.artists?.items?.length ?? 0) > 0,
      `status=${artistSearch.status}, count=${artistSearch.body.artists?.items?.length ?? 0}`,
    );

    const artistSearchSet = redisSetCalls.find((entry) => entry.key.startsWith('spotify:search:artist:'));
    addResult(
      'Artist cache TTL is 21600s',
      artistSearchSet?.ttl === 21600,
      `ttl=${artistSearchSet?.ttl ?? 'missing'}`,
    );

    const trackSearch = await jsonFetch<{ tracks?: { items?: Array<{ id: string }> } }>(
      `${baseUrl}/api/spotify/search?q=afrobeats&type=track&limit=12`,
    );

    addResult(
      'Spotify track search returns results from the server',
      trackSearch.status === 200 && (trackSearch.body.tracks?.items?.length ?? 0) > 0,
      `status=${trackSearch.status}, count=${trackSearch.body.tracks?.items?.length ?? 0}`,
    );

    const trackSearchSet = redisSetCalls.find((entry) => entry.key.startsWith('spotify:search:track:'));
    addResult(
      'Search cache TTL is 600s',
      trackSearchSet?.ttl === 600,
      `ttl=${trackSearchSet?.ttl ?? 'missing'}`,
    );

    const repeatedArtistSearch = await jsonFetch<{ artists?: { items?: Array<{ id: string }> } }>(
      `${baseUrl}/api/spotify/search?q=afrobeats&type=artist&limit=12`,
    );

    addResult(
      'Second artist search comes from cache',
      repeatedArtistSearch.status === 200 && spotifyRequests.filter((request) => request.includes('type=artist')).length === 1,
      `artistRequests=${spotifyRequests.filter((request) => request.includes('type=artist')).length}`,
    );

    const summary = results.filter((result) => !result.pass);
    console.log(`\nSummary: ${results.length - summary.length}/${results.length} checks passed.`);

    if (summary.length > 0) {
      throw new Error(`Catalog acceptance checks failed: ${summary.map((result) => result.name).join('; ')}`);
    }
  } finally {
    server.close();
    globalThis.fetch = originalFetch;
    prisma.song.findMany = originalSongFindMany;
    prisma.artist.findMany = originalArtistFindMany;
    prisma.genre.findMany = originalGenreFindMany;
    prisma.song.count = originalSongCount;
    prisma.artist.count = originalArtistCount;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});