import 'dotenv/config';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { redis, scanKeys } from '../src/lib/redis';
import { dedupFetch, dedupFetchCount } from '../src/lib/requestDedup';
import {
  cachedSearch,
  cachedFetchLyrics,
  cachedFetchLyricsWithSync,
} from '../src/services/lyricsProviders/lyricsCache';
import type { LyricsProvider, LyricsSearchResult } from '../src/services/lyricsProviders/lyricsProvider';
import { extractLyricsFromDataContainerHtml, extractLyricsFromHtml, extractLyricsFromLegacyContainerHtml, extractLyricsFromPreloadedState } from '../src/services/lyricsProviders/geniusProvider';
import {
  BANDWIDTH_THRESHOLDS,
  BANDWIDTH_MAX_QUERY_DAYS,
  classifyRoute,
  recordBandwidth,
  flushBandwidthCounters,
  getBandwidthDaily,
  getBandwidthByGroup,
  getBandwidthAlerts,
  DAILY_PREFIX,
} from '../src/lib/bandwidthMonitor';

// ---------------------------------------------------------------------------
// Phase 6 — Background Worker Optimization (IMPLEMENTATION-PLAN.md §7)
// Audited 2026-09-28.
//
// SAFETY CONTRACT
//   This suite performs NO database writes of any kind. It does not import any
//   service that calls prisma.*.create/update/delete.
//
//   Redis: every key written is namespaced under a test-only provider name
//   (`p6test`) that no real provider uses, plus the shared bandwidth counters,
//   which are captured before the write and restored byte-for-byte in teardown.
//   See restoreBandwidthCounters().
//
//   GeniusProvider (2.13): the audit-log port is now injectable, so the three
//   HTML extractors are exported as pure functions and exercised at runtime
//   against fixture HTML — no DB, no network. The network-facing happy path is
//   still not triggered; reading it would require a live fetch.
// ---------------------------------------------------------------------------

const BACKEND_ROOT = path.resolve(__dirname, '..');
const readBackendFile = (...parts: string[]) => readFile(path.join(BACKEND_ROOT, ...parts), 'utf8');

/** Provider name that cannot collide with genius/lrclib/lyricfind/musicmatch. */
const TEST_PROVIDER = 'p6test';
const TEST_PROVIDER_KEYS = [
  `lyrics:search:${TEST_PROVIDER}:*`,
  `lyrics:neg:${TEST_PROVIDER}:*`,
  `lyrics:lyrics:${TEST_PROVIDER}:*`,
  `lyrics:synced:${TEST_PROVIDER}:*`,
  // The synced provider is named `${TEST_PROVIDER}-synced`, so `p6test:*` does
  // NOT glob-match `p6test-synced:*` — it needs its own pattern or keys leak
  // between runs and make the "provider was called" assertions read false.
  `lyrics:synced:${TEST_PROVIDER}-synced:*`,
];

const utcDay = () => new Date().toISOString().slice(0, 10);
const utcHour = () => new Date().toISOString().slice(0, 13);

// Only the STRING counters belong here.
//
// `bandwidth:group:<day>` is deliberately absent: it is a Redis *hash* (written
// with HINCRBY), so `GET` on it raises WRONGTYPE. It is snapshotted separately
// as a hash in `snapshotBandwidthCounters`.
//
// That this was previously harmless is worth recording: the group hash only
// exists once something has written to it. Before 2.10 buffered the writes, the
// suite did not create today's hash itself, so on a day with no production
// traffic the key did not exist and `GET` returned nil instead of throwing. The
// day the buffering landed, the test started creating the key and cancelled all
// nine suites at once with a WRONGTYPE that had nothing to do with the change.
const BANDWIDTH_KEYS = () => [
  `${DAILY_PREFIX}${utcDay()}`,
  `bandwidth:hourly:${utcHour()}`,
];

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeProvider implements LyricsProvider {
  public searchCalls = 0;
  public fetchCalls = 0;
  public searchResult: LyricsSearchResult[] | null = [{ trackId: 't1', title: 'T', artist: 'A' }];
  public lyricsResult: string | null = 'la la la';

  constructor(public readonly name: string = TEST_PROVIDER) {}

  async search(): Promise<LyricsSearchResult[] | null> {
    this.searchCalls += 1;
    return this.searchResult;
  }

  async fetchLyrics(): Promise<string | null> {
    this.fetchCalls += 1;
    return this.lyricsResult;
  }
}

class FakeSyncedProvider {
  public readonly name = `${TEST_PROVIDER}-synced`;
  public calls = 0;
  public result: { plain: string | null; synced: string | null } = { plain: 'p', synced: 's' };

  async fetchLyricsWithSync(): Promise<{ plain: string | null; synced: string | null }> {
    this.calls += 1;
    return this.result;
  }
}

// ---------------------------------------------------------------------------
// Bandwidth counter snapshot / restore — leaves the real counters untouched.
// ---------------------------------------------------------------------------

let bandwidthSnapshot: Array<[string, string | null]> = [];

const snapshotBandwidthCounters = async () => {
  bandwidthSnapshot = [];
  for (const key of BANDWIDTH_KEYS()) {
    bandwidthSnapshot.push([key, await redis.get(key)]);
  }
  const groupKey = `bandwidth:group:${utcDay()}`;
  const groups = await redis.hgetall(groupKey);
  bandwidthSnapshot.push([`H:${groupKey}`, JSON.stringify(groups)]);
};

const restoreBandwidthCounters = async () => {
  for (const [key, value] of bandwidthSnapshot) {
    try {
      if (key.startsWith('H:')) {
        const hashKey = key.slice(2);
        const original = JSON.parse(value ?? '{}') as Record<string, string>;
        const current = await redis.hgetall(hashKey);
        for (const field of Object.keys(current)) {
          if (!(field in original)) await redis.hdel(hashKey, field);
        }
        for (const [field, val] of Object.entries(original)) {
          await redis.hset(hashKey, field, val);
        }
      } else if (value === null) {
        await redis.del(key);
      } else {
        await redis.set(key, value, 'EX', 60 * 60 * 24 * 3);
      }
    } catch {
      // best effort restore
    }
  }
  bandwidthSnapshot = [];
};

// ---------------------------------------------------------------------------

before(async () => {
  await snapshotBandwidthCounters();
  // Clear any residue from an interrupted prior run of this same suite.
  for (const pattern of TEST_PROVIDER_KEYS) {
    const keys = await scanKeys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
});

after(async () => {
  for (const pattern of TEST_PROVIDER_KEYS) {
    const keys = await scanKeys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
  await restoreBandwidthCounters();
  try {
    await redis.quit();
  } catch {
    // already closed
  }
});

// ===========================================================================
// 7.2.4 — Request deduplication
// ===========================================================================

describe('7.2.4 request deduplication (src/lib/requestDedup.ts)', () => {
  test('collapses concurrent identical calls into a single upstream fetch', async () => {
    const before = dedupFetchCount();
    let upstream = 0;
    const key = `${TEST_PROVIDER}:dedup:collapse`;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const fetcher = async () => {
      upstream += 1;
      await gate;
      return 'value';
    };

    const all = Promise.all([
      dedupFetch(key, fetcher),
      dedupFetch(key, fetcher),
      dedupFetch(key, fetcher),
      dedupFetch(key, fetcher),
    ]);

    release();
    const results = await all;

    assert.equal(upstream, 1, `4 concurrent dedupFetch calls must hit upstream once, got ${upstream}`);
    assert.deepEqual(results, ['value', 'value', 'value', 'value']);
    assert.equal(dedupFetchCount(), before, 'in-flight entry must be evicted after settling');
  });

  test('a settled key is re-issued on the next call (no stale memoisation)', async () => {
    const key = `${TEST_PROVIDER}:dedup:sequential`;
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return calls;
    };

    assert.equal(await dedupFetch(key, fetcher), 1);
    assert.equal(await dedupFetch(key, fetcher), 2, 'a completed promise must not be served again');
    assert.equal(calls, 2);
    assert.equal(dedupFetchCount(), 0);
  });

  test('a rejected fetch is evicted so the next caller retries', async () => {
    const key = `${TEST_PROVIDER}:dedup:reject`;
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      if (calls === 1) throw new Error('upstream boom');
      return 'recovered';
    };

    await assert.rejects(() => dedupFetch(key, fetcher), /upstream boom/);
    assert.equal(dedupFetchCount(), 0, 'a rejected entry must not be retained');

    assert.equal(await dedupFetch(key, fetcher), 'recovered');
    assert.equal(calls, 2);
  });

  test('distinct keys never share an in-flight slot', async () => {
    const before = dedupFetchCount();
    const [a, b] = await Promise.all([
      dedupFetch(`${TEST_PROVIDER}:dedup:a`, async () => 'a'),
      dedupFetch(`${TEST_PROVIDER}:dedup:b`, async () => 'b'),
    ]);
    assert.equal(a, 'a');
    assert.equal(b, 'b');
    assert.equal(dedupFetchCount(), before);
  });
});

// ===========================================================================
// 7.1.2 — Redis caching for lyrics providers
// ===========================================================================

describe('7.1.2 lyrics provider Redis caching (src/services/lyricsProviders/lyricsCache.ts)', () => {
  test('search: second call is served from cache without hitting the provider', async () => {
    const provider = new FakeProvider();
    const first = await cachedSearch(provider, 'Artist A', 'Title A');
    const afterFirst = provider.searchCalls;
    const second = await cachedSearch(provider, 'artist a', '  TITLE a  ');

    assert.equal(afterFirst, 1);
    assert.equal(provider.searchCalls, 1, 'cache hit must not call the provider again');
    assert.deepEqual(first, second);
  });

  test('search: cache key is case- and whitespace-normalised', async () => {
    // Scoped to this test: other tests in this block create their own search
    // keys, so a global scan would see them too.
    const stale = await scanKeys(`lyrics:search:${TEST_PROVIDER}:*`);
    if (stale.length > 0) await redis.del(...stale);

    const provider = new FakeProvider();
    await cachedSearch(provider, 'Kofi', 'Blaze');
    const keys = await scanKeys(`lyrics:search:${TEST_PROVIDER}:*`);
    assert.equal(keys.length, 1, `expected exactly 1 search key, got ${JSON.stringify(keys)}`);
    assert.ok(keys[0].endsWith('kofi::blaze'), `key should normalise to "kofi::blaze", got ${keys[0]}`);

    // And a differently-cased/whitespaced query must reuse that same entry.
    const second = new FakeProvider();
    await cachedSearch(second, '  KOfI  ', ' BLAZE ');
    assert.equal(second.searchCalls, 0, 'normalised query must hit the cache, not the provider');
  });

  test('search: positive result cached with a 7-day TTL', async () => {
    const provider = new FakeProvider();
    await cachedSearch(provider, 'TTL Artist', 'TTL Title');
    const key = `lyrics:search:${TEST_PROVIDER}:ttl artist::ttl title`;
    const ttl = await redis.ttl(key);
    const sevenDays = 7 * 24 * 60 * 60;
    assert.ok(ttl > sevenDays - 120 && ttl <= sevenDays, `expected ~7d TTL, got ${ttl}s`);
  });

  test('search: empty result is negatively cached and short-circuits the provider', async () => {
    const provider = new FakeProvider();
    provider.searchResult = null;

    assert.equal(await cachedSearch(provider, 'Nobody', 'Nothing'), null);
    assert.equal(await cachedSearch(provider, 'Nobody', 'Nothing'), null);

    assert.equal(provider.searchCalls, 1, 'negative cache must prevent a second provider call');
    const negKeys = await scanKeys(`lyrics:neg:${TEST_PROVIDER}:*`);
    assert.ok(negKeys.some((k) => k.includes('nobody::nothing')), 'negative cache key must exist');
  });

  test('search: a negative-cache hit does not leak stale positives', async () => {
    const provider = new FakeProvider();
    provider.searchResult = null;
    await cachedSearch(provider, 'Flip', 'Case');

    provider.searchResult = [{ trackId: 't9', title: 'Now Found', artist: 'X' }];
    assert.equal(await cachedSearch(provider, 'Flip', 'Case'), null,
      'negative cache is authoritative for its 24h window — expected null');
  });

  test('search: corrupt cached JSON falls through to the provider instead of throwing', async () => {
    const provider = new FakeProvider();
    const key = `lyrics:search:${TEST_PROVIDER}:corrupt::song`;
    await redis.set(key, '{not-json', 'EX', 60);

    const result = await cachedSearch(provider, 'Corrupt', 'Song');
    assert.ok(result !== null, 'a corrupt cache entry must not break the lookup');
    assert.equal(provider.searchCalls, 1, 'corrupt entry must trigger a real provider call');
  });

  test('fetchLyrics: content cached with a 7-day TTL and provider called once', async () => {
    const provider = new FakeProvider();
    assert.equal(await cachedFetchLyrics(provider, 'ttl-track'), 'la la la');
    assert.equal(await cachedFetchLyrics(provider, 'ttl-track'), 'la la la');
    assert.equal(provider.fetchCalls, 1, 'second fetch must be served from cache');
  });

  test('fetchLyrics: null result stored as the __EMPTY__ sentinel', async () => {
    const provider = new FakeProvider();
    provider.lyricsResult = null;

    assert.equal(await cachedFetchLyrics(provider, 'empty-track'), null);
    const key = `lyrics:lyrics:${TEST_PROVIDER}:empty-track`;
    assert.equal(await redis.get(key), '__EMPTY__', 'sentinel must be stored verbatim');

    provider.lyricsResult = 'late arrival';
    assert.equal(await cachedFetchLyrics(provider, 'empty-track'), null,
      'the __EMPTY__ sentinel must be honoured rather than refetched');
    assert.equal(provider.fetchCalls, 1);
  });

  test('fetchLyrics: empty sentinel uses the 24h negative TTL, not 7 days', async () => {
    const provider = new FakeProvider();
    provider.lyricsResult = null;
    await cachedFetchLyrics(provider, 'ttl-empty-track');
    const ttl = await redis.ttl(`lyrics:lyrics:${TEST_PROVIDER}:ttl-empty-track`);
    assert.ok(ttl > 24 * 60 * 60 - 120 && ttl <= 24 * 60 * 60, `expected ~24h TTL, got ${ttl}s`);
  });

  test('fetchLyricsWithSync: caches both plain and synced payloads', async () => {
    const provider = new FakeSyncedProvider();
    const a = await cachedFetchLyricsWithSync(provider, 'synced-1');
    const b = await cachedFetchLyricsWithSync(provider, 'synced-1');
    assert.deepEqual(a, { plain: 'p', synced: 's' });
    assert.deepEqual(b, a);
    assert.equal(provider.calls, 1, 'synced payload must be cached');
  });

  test('fetchLyricsWithSync: both-null result uses the __EMPTY_SYNCED__ sentinel', async () => {
    const provider = new FakeSyncedProvider();
    provider.result = { plain: null, synced: null };
    const first = await cachedFetchLyricsWithSync(provider, 'synced-empty');
    const second = await cachedFetchLyricsWithSync(provider, 'synced-empty');
    assert.deepEqual(first, { plain: null, synced: null });
    assert.deepEqual(second, first);
    assert.equal(provider.calls, 1);
    const keys = await scanKeys(`lyrics:synced:${TEST_PROVIDER}-synced:*`);
    assert.ok(keys.length > 0, 'a synced cache key must be written');
  });

  test('the lyrics enrichment job actually routes through the cache layer', async () => {
    const src = await readBackendFile('src', 'jobs', 'lyricsEnrichmentJob.ts');
    assert.match(src, /from '\.\.\/services\/lyricsProviders\/lyricsCache'/,
      'lyricsEnrichmentJob must import the cache helpers');
    for (const fn of ['cachedSearch', 'cachedFetchLyrics', 'cachedFetchLyricsWithSync']) {
      assert.ok(src.includes(`${fn}(`), `lyricsEnrichmentJob must call ${fn}()`);
    }
  });
});

// ===========================================================================
// 7.1.1 — Genius scraping
// ===========================================================================

describe('7.1.1 Genius provider bandwidth reduction (src/services/lyricsProviders/geniusProvider.ts)', () => {
  test('search and song metadata go through the official API, not an HTML scrape', async () => {
    const src = await readBackendFile('src', 'services', 'lyricsProviders', 'geniusProvider.ts');
    assert.match(src, /GENIUS_API_BASE\s*=\s*'https:\/\/api\.genius\.com'/,
      'must target api.genius.com');
    assert.match(src, /Authorization:\s*`Bearer \$\{token\}`/,
      'must authenticate with a bearer token');
    assert.match(src, /callApi<GeniusSearchResponse>\('\/search'/, 'search must use the API');
    assert.match(src, /callApi<GeniusSongResponse>\(`\/songs\/\$\{trackId\}`\)/, 'metadata must use the API');
  });

  test('the remaining page fetch requests compressed encoding', async () => {
    const src = await readBackendFile('src', 'services', 'lyricsProviders', 'geniusProvider.ts');
    assert.match(src, /'Accept-Encoding':\s*'gzip, deflate, br'/,
      'the lyrics page fetch must request gzip/br to cut payload size');
  });

  test('every network call is bounded by a timeout', async () => {
    const src = await readBackendFile('src', 'services', 'lyricsProviders', 'geniusProvider.ts');
    const timeouts = src.match(/AbortSignal\.timeout\(/g) ?? [];
    assert.ok(timeouts.length >= 2, `expected a timeout on both API and page fetches, found ${timeouts.length}`);
    assert.match(src, /REQUEST_TIMEOUT_MS\s*=\s*\d+/, 'timeout must be a named constant');
  });

  test('an unconfigured token fails fast before any request is made', async () => {
    // Safe to run: getAccessToken() throws before fetch() and before logAICall(),
    // so no HTTP request is issued and no AICallLog row is written.
    const saved = { a: process.env.GENIUS_ACCESS_TOKEN, b: process.env.GENIUS_API_KEY };
    delete process.env.GENIUS_ACCESS_TOKEN;
    delete process.env.GENIUS_API_KEY;
    try {
      const { GeniusProvider } = await import('../src/services/lyricsProviders/geniusProvider.js');
      const provider = new GeniusProvider('p6test-song');
      await assert.rejects(() => provider.search('a', 'b'), /GENIUS_ACCESS_TOKEN is not configured/);
      assert.equal(await provider.fetchLyrics('1'), null,
        'fetchLyrics must swallow the token error and return null');
    } finally {
      if (saved.a !== undefined) process.env.GENIUS_ACCESS_TOKEN = saved.a;
      if (saved.b !== undefined) process.env.GENIUS_API_KEY = saved.b;
    }
  });

  test('seam: the audit-log port is injectable, so the happy path no longer hard-couples to the DB (2.13)', async () => {
    const genius = await readBackendFile('src', 'services', 'lyricsProviders', 'geniusProvider.ts');
    assert.match(genius, /constructor\([\s\S]{0,120}auditLog: AICallLogPort\s*=\s*logAICall/,
      'the audit-log port must default to logAICall but be replaceable');
    assert.match(genius, /this\.auditLog\(/, 'the provider must log through the injected port');
    assert.match(genius, /export function extractLyricsFromHtml\(html: string\): string \| null/,
      'a pure HTML entry point must exist for fixture tests');
  });

  test('wall guard must not reject genuine lyrics pages (5.7 live-page check)', async () => {
    // A real 2026-09-29 Genius page contains `recaptcha_v3_site_key` and a
    // footer "Sign In" link; the old `includes('captcha')`/`includes('Sign In')`
    // guard matched both and returned null for EVERY genuine page, killing the
    // provider. The guard must key on a bot wall's title / absence of markup.
    const src = await readBackendFile('src', 'services', 'lyricsProviders', 'geniusProvider.ts');
    assert.ok(!/html\.includes\('(captcha|Sign In)'\)/.test(src),
      'must not use naive substring checks that match every real page');
    assert.match(src, /pageTitle\s*=\s*html\.match\(\/<title>\(\[\^<\]\*\)<\\\/title>\/i\)/,
      'must read the page title to detect a bot wall');
    assert.match(src, /hasLyricMarkup\s*=\s*\/data-lyrics-container="true"\|Lyrics__Container\|__PRELOADED_STATE__\//,
      'must check for lyric markup to distinguish a wall from a real page');
  });

  test('extractor 1: data-lyrics-container div (current Genius embed)', () => {
    const html = [
      '<html><body>',
      '<div class="SongPageGrid">',
      '<div data-lyrics-container="true" class="Lyrics__Container">',
      'First line of the song',
      '<br>',
      'Second line &amp; an entity',
      '<br>',
      'Third line with <i>italic word</i> inside',
      '</div>',
      '</div>',
      '</body></html>',
    ].join('');
    const lyrics = extractLyricsFromHtml(html);
    assert.equal(lyrics, 'First line of the song\nSecond line & an entity\nThird line with italic word inside');
  });

  test('extractor 2: legacy Lyrics__Container class', () => {
    const html = [
      '<div class="lyrics">',
      '<div class="Lyrics__Container-sc-1ynbvzw-5 gkMYcd">',
      'Legacy container lyrics',
      '<br><br>',
      'across several lines',
      '<br>',
      'with a little more length to clear the content floor',
      '</div>',
      '</div>',
    ].join('');
    const lyrics = extractLyricsFromHtml(html);
    assert.equal(lyrics, 'Legacy container lyrics\n\nacross several lines\nwith a little more length to clear the content floor');
  });

  test('extractor 3: window.__PRELOADED_STATE__ JSON', () => {
    const state = JSON.stringify({
      songPage: {
        lyrics: {
          plain: 'Lyrics from embedded JSON state\none more line',
        },
      },
    });
    const html = `<script>window.__PRELOADED_STATE__ = ${state};</script>`;
    const lyrics = extractLyricsFromHtml(html);
    assert.equal(lyrics, 'Lyrics from embedded JSON state\none more line');
  });

  test('extractors return null when no markup is present', () => {
    assert.equal(extractLyricsFromHtml('<html><body><p>no lyrics here</p></body></html>'), null);
    assert.equal(extractLyricsFromHtml(''), null);
  });

  test('extractor ignores a short contributors header block and takes the verse body (live-page shape)', () => {
    // A real Genius page (checked 2026-09-29) contains a "30 Contributors"
    // header that is ALSO inside a data-lyrics-container div — the first match.
    // The extractor must skip such short metadata blocks and return the real
    // verse, exactly as the previous first-match implementation failed to do.
    const html = [
      '<div data-lyrics-container="true" class="Lyrics__Container">',
      '<div data-exclude-from-selection="true" class="LyricsHeader__Container">',
      '<button class="ContributorsCreditSong__Container">30 Contributors</button>',
      '</div>',
      '</div>',
      '<div data-lyrics-container="true" class="Lyrics__Container">',
      '[Post-Chorus: Burna Boy]',
      '<br>',
      'O y\u1EB9 k\u1EB9 (Yeah), da m\u1ECD',
      '<br>',
      'O y\u1EB9 k\u1EB9, j\u1EB9 l\u1ECD',
      '</div>',
    ].join('');
    const lyrics = extractLyricsFromHtml(html);
    assert.equal(lyrics, '[Post-Chorus: Burna Boy]\nO y\u1EB9 k\u1EB9 (Yeah), da m\u1ECD\nO y\u1EB9 k\u1EB9, j\u1EB9 l\u1ECD');
  });

  test('extractors fall through in markup-evolution order (newest first)', () => {
    // A page carrying BOTH the embed container and the preloaded state must
    // prefer the container: it is run first and is the current markup.
    const state = JSON.stringify({ songPage: { lyrics: { plain: 'json lyrics pulled from embedded state' } } });
    const html = [
      '<div data-lyrics-container="true">container lyrics spanning a full verse with enough length</div>',
      `<script>window.__PRELOADED_STATE__ = ${state};</script>`,
    ].join('');
    assert.equal(extractLyricsFromHtml(html), 'container lyrics spanning a full verse with enough length');
  });
});

// ===========================================================================
// 7.2.1 / 7.2.3 — Sync schedules (Phase 4: surviving jobs only)
// ===========================================================================

describe('7.2.1 + 7.2.3 sync schedules + Phase 4 trim (src/jobs/syncCron.ts)', () => {
  let src = '';
  let cron = '';

  before(async () => {
    // The repeat registrations moved out of index.ts into syncCron.ts (2.6) so
    // they can be re-registered by the self-healer without a restart.
    src = await readBackendFile('src', 'index.ts');
    cron = await readBackendFile('src', 'jobs', 'syncCron.ts');
  });

  test('Phase 4: only backfill-lyrics (5am) and library-enrichment (Tue/Thu 3am) remain', () => {
    assert.match(cron, /jobId:\s*'backfill-lyrics-daily'/);
    assert.match(cron, /repeat:\s*\{\s*pattern:\s*'0 5 \* \* \*'\s*\}/);
    assert.match(cron, /jobId:\s*'library-enrichment-tue-thu'/);
    assert.match(cron, /repeat:\s*\{\s*pattern:\s*'0 3 \* \* 2,4'\s*\}/);
  });

  test('Phase 4: the Spotify catalog crons are gone', () => {
    for (const gone of [
      /sync-popular-tracks-monday/,
      /sync-new-releases-biweekly/,
      /sync-all-monthly/,
      /refresh-stale-daily/,
      /0 2 \* \* 1/,
      /0 3 1,15 \* \*/,
      /0 2 1 \* \*/,
      /0 4 \* \* \*/,
    ]) {
      assert.ok(!gone.test(cron), `removed cron must not be scheduled: ${gone}`);
    }
  });

  test('stale threshold raised from 72h to 7 days', async () => {
    const envSrc = await readBackendFile('src', 'lib', 'env.ts');
    assert.match(envSrc, /SYNC_STALE_THRESHOLD_HOURS[\s\S]{0,120}default\(168\)/,
      'default stale threshold must be 168h (7 days) per 7.2.1');
  });

  test('7.2.3 genre discovery cron removed', () => {
    const scheduled = cron.match(/repeat:\s*\{\s*pattern:\s*'([^']+)'\s*\}/g) ?? [];
    const patterns = scheduled.map((m) => m.match(/pattern:\s*'([^']+)'/)![1]);
    assert.ok(!patterns.includes('0 2 * * 5'),
      `the Friday 2am genre-discovery cron must be gone; found ${JSON.stringify(patterns)}`);
    assert.ok(!/jobId:\s*'[^']*genre[^']*'/i.test(cron),
      'no genre-discovery job may be registered with a repeat schedule');
  });

  test('7.2.3 + Phase 4: worker dispatches only non-Spotify job types, admin trigger preserved', async () => {
    const worker = await readBackendFile('src', 'jobs', 'syncWorker.ts');
    for (const kept of ['backfill-lyrics', 'backfill-artists-lastfm', 'enrich-artist-lastfm', 'library-enrichment']) {
      assert.ok(worker.includes(`'${kept}'`) || worker.includes(`"${kept}"`),
        `worker must still handle the '${kept}' job type`);
    }
    assert.ok(!/sync-genre-discovery/.test(worker), 'the Spotify genre-discovery worker case must be gone');
    assert.ok(!/sync-popular-tracks/.test(worker), 'the Spotify popular-tracks worker case must be gone');

    const route = await readBackendFile('src', 'routes', 'admin', 'sync.ts');
    assert.match(route, /adminSyncRouter|\* router|export.*router/,
      'the manual admin trigger must remain available');
  });

  test('repeat jobs are self-healed if Redis loses them (2.6)', async () => {
    const selfHeal = await readBackendFile('src', 'jobs', 'selfHeal.ts');

    // Startup wires both the initial schedule and the periodic verifier.
    assert.match(src, /scheduleSyncJobs\(\)/, 'startup must register the repeat jobs');
    assert.match(src, /startSelfHeal\(\)/, 'startup must also start the self-healer');

    // The self-healer must actually be able to REPAIR, not merely observe.
    assert.match(selfHeal, /export const verifyAndRepairRepeatJobs|export async function verifyAndRepairRepeatJobs/,
      'the self-healer must expose a repair entry point');
    assert.match(selfHeal, /setInterval/, 'verification must repeat, not run once per boot');
    assert.match(selfHeal, /getJob\(/, 'it must detect a missing repeat registration');
  });
});

// ===========================================================================
// 7.4 — Bandwidth monitoring & alerting
// ===========================================================================

describe('7.4 bandwidth monitoring (src/lib/bandwidthMonitor.ts)', () => {
  test('thresholds match the plan: 200GB warn / 500GB critical / 50GB hourly', () => {
    const GB = 1024 * 1024 * 1024;
    assert.equal(BANDWIDTH_THRESHOLDS.dailyWarningBytes, 200 * GB);
    assert.equal(BANDWIDTH_THRESHOLDS.dailyCriticalBytes, 500 * GB);
    assert.equal(BANDWIDTH_THRESHOLDS.hourlySpikeBytes, 50 * GB);
  });

  test('route classification buckets the highest-traffic families', () => {
    assert.equal(classifyRoute('/uploads/cover.jpg'), 'uploads');
    assert.equal(classifyRoute('/api/playback/source'), 'playback');
    assert.equal(classifyRoute('/api/songs/1'), 'songs');
    assert.equal(classifyRoute('/api/admin/economy/config'), 'admin');
    assert.equal(classifyRoute('/api/community/topics'), 'community');
    assert.equal(classifyRoute('/api/unknown-thing'), 'api-other');
    assert.equal(classifyRoute('/favicon.ico'), 'static-other');
  });

  test('recordBandwidth increments daily, hourly and per-group counters', async () => {
    const marker = `${TEST_PROVIDER}-bandwidth`;
    const payload = 4096;

    const dailyBefore = Number((await redis.get(`${DAILY_PREFIX}${utcDay()}`)) ?? '0');
    const hourlyBefore = Number((await redis.get(`bandwidth:hourly:${utcHour()}`)) ?? '0');
    const groupBefore = Number((await redis.hget(`bandwidth:group:${utcDay()}`, marker)) ?? '0');

    recordBandwidth(payload, marker);
    // Counter writes are buffered (2.10) — drain before asserting, which is the
    // same thing the interval flush does.
    await flushBandwidthCounters();

    const dailyAfter = Number((await redis.get(`${DAILY_PREFIX}${utcDay()}`)) ?? '0');
    const hourlyAfter = Number((await redis.get(`bandwidth:hourly:${utcHour()}`)) ?? '0');
    const groupAfter = Number((await redis.hget(`bandwidth:group:${utcDay()}`, marker)) ?? '0');

    assert.equal(dailyAfter - dailyBefore, payload, 'daily counter must increase by exactly the payload');
    assert.equal(hourlyAfter - hourlyBefore, payload, 'hourly counter must increase by exactly the payload');
    assert.equal(groupAfter - groupBefore, payload, 'group counter must increase by exactly the payload');
  });

  test('buffered writes are not lost when several records are coalesced', async () => {
    const marker = `${TEST_PROVIDER}-bandwidth-coalesce`;
    const before = Number((await redis.hget(`bandwidth:group:${utcDay()}`, marker)) ?? '0');

    for (let i = 1; i <= 5; i += 1) recordBandwidth(1000 * i, marker);
    await flushBandwidthCounters();

    const after = Number((await redis.hget(`bandwidth:group:${utcDay()}`, marker)) ?? '0');
    // 1000+2000+3000+4000+5000 — coalescing must sum, not overwrite.
    assert.equal(after - before, 15_000, 'a flush must sum every buffered value');
  });

  test('zero-byte responses are not recorded', async () => {
    const marker = `${TEST_PROVIDER}-bandwidth-zero`;
    const before = Number((await redis.hget(`bandwidth:group:${utcDay()}`, marker)) ?? '0');
    recordBandwidth(0, marker);
    await flushBandwidthCounters();
    const after = Number((await redis.hget(`bandwidth:group:${utcDay()}`, marker)) ?? '0');
    assert.equal(after, before, 'a 0-byte response must be a no-op');
    assert.equal(after, 0);
  });

  test('read endpoints are safe to call and return well-formed data', async () => {
    const daily = await getBandwidthDaily(30);
    assert.ok(Array.isArray(daily));
    for (const point of daily) {
      assert.match(point.day, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(typeof point.bytes, 'number');
    }
    const sorted = [...daily].map((p) => p.day).sort();
    assert.deepEqual(daily.map((p) => p.day), sorted, 'series must be chronological');

    const groups = await getBandwidthByGroup(7);
    assert.ok(Array.isArray(groups));
    for (const row of groups) {
      assert.equal(typeof row.bytes, 'number');
      assert.ok(row.pct >= 0 && row.pct <= 100, `pct must be 0-100, got ${row.pct}`);
    }
    const totalPct = groups.reduce((s, r) => s + r.pct, 0);
    if (groups.length > 1) {
      assert.ok(Math.abs(totalPct - 100) < 0.5, `group percentages should sum to ~100, got ${totalPct}`);
    }

    const alerts = await getBandwidthAlerts(50);
    assert.ok(Array.isArray(alerts));
    for (const alert of alerts) {
      assert.ok(typeof alert.kind === 'string' && typeof alert.bytes === 'number');
    }
  });

  test('counter TTL outlasts the widest query window (2.9)', async () => {
    // Was `60 * 60 * 24 * 3` while the daily endpoint defaults to a 30-day
    // window (and validates up to 90), so the chart could only ever contain the
    // last 3 days and silently rendered 27 days of zeroes.
    const src = await readBackendFile('src', 'lib', 'bandwidthMonitor.ts');
    const route = await readBackendFile('src', 'routes', 'admin', 'bandwidth.ts');
    assert.equal(BANDWIDTH_MAX_QUERY_DAYS, 90, 'the documented max query window');
    assert.match(route, /\?\? 30/, 'the daily endpoint still defaults to a 30-day window');
    assert.match(route, /isInt\(\{\s*min:\s*1,\s*max:\s*90\s*\}\)/, 'days must be bounded 1-90');

    // Retention must be derived from the max query window, not hardcoded.
    assert.match(
      src,
      /CACHE_TTL_SECONDS\s*=\s*60\s*\*\s*60\s*\*\s*24\s*\*\s*\(BANDWIDTH_MAX_QUERY_DAYS\s*\+\s*1\)/,
      'counter retention must be derived from BANDWIDTH_MAX_QUERY_DAYS + 1 so it can never fall below the query range',
    );
    assert.doesNotMatch(
      src,
      /CACHE_TTL_SECONDS\s*=\s*60\s*\*\s*60\s*\*\s*24\s*\*\s*3\b/,
      'the 3-day retention that truncated the 30-day chart must not come back',
    );
  });

  test('counter writes are buffered rather than issued per request (2.10)', async () => {
    const src = await readBackendFile('src', 'lib', 'bandwidthMonitor.ts');
    // recordBandwidth must be synchronous accumulation, not an async inline write.
    assert.match(src, /export function recordBandwidth\(bytes: number, group: string\): void/,
      'recordBandwidth should accumulate synchronously');
    assert.match(src, /export function flushBandwidthCounters\(\): Promise<void>/,
      'an explicit flush must exist for tests and shutdown');
    assert.match(src, /BANDWIDTH_FLUSH_INTERVAL_MS/,
      'counters must be flushed on an interval');

    // And the flush must actually sum a coalesced buffer (see the coalesce test).
    const index = await readBackendFile('src', 'index.ts');
    assert.match(index, /shutdownBandwidthMonitor\(\)/,
      'graceful shutdown must drain the buffer before closing Redis');
  });

  test('middleware is mounted ahead of the routes it measures', async () => {
    const app = await readBackendFile('src', 'app.ts');
    const middlewareAt = app.indexOf('bandwidthTrackingMiddleware');
    assert.ok(middlewareAt > 0, 'bandwidthTrackingMiddleware must be registered in app.ts');
    const routerUse = app.indexOf('app.use(');
    assert.ok(middlewareAt < routerUse + 400,
      'the tracker should be installed early so it wraps downstream responses');
  });
});

// ===========================================================================
// 7.3.2 — CDN / static asset caching
// ===========================================================================

describe('7.3.2 CDN caching for static assets', () => {
  test('/uploads responses carry a long-lived immutable Cache-Control', async () => {
    // Plan §7.3.2 requires `Cache-Control: public, max-age=31536000, immutable`
    // on uploads so a CDN can absorb image traffic. Previously no header was set
    // at all, so every view re-validated the file with the origin — the single
    // largest avoidable egress category the plan identified.
    const app = await readBackendFile('src', 'app.ts');
    assert.match(
      app,
      /Cache-Control',\s*'public, max-age=31536000, immutable'/,
      'FAILS: the /uploads static mount must set an immutable Cache-Control',
    );
    assert.match(
      app,
      /express\.static\([\s\S]{0,200}maxAge/,
      'maxAge must be set on the uploads mount',
    );

    // `immutable` is only safe because uploads are never written in place.
    const upload = await readBackendFile('src', 'middleware', 'upload.ts');
    assert.match(upload, /randomBytes/, 'filenames must be unique, else immutable caching is unsafe');
  });

  test('uploads are served as static files at all', async () => {
    const app = await readBackendFile('src', 'app.ts');
    assert.match(app, /express\.static\(/, 'uploads should be served via express.static');
  });
});

// ===========================================================================
// Wiring
// ===========================================================================

describe('Phase 6 wiring', () => {
  test('bandwidth router is mounted under /api/admin', async () => {
    const app = await readBackendFile('src', 'app.ts');
    assert.match(app, /import\s*\{\s*adminBandwidthRouter\s*\}/);
    assert.match(app, /app\.use\('\/api\/admin',\s*adminBandwidthRouter\)/);
  });

  test('all three bandwidth endpoints exist and are admin-only', async () => {
    const route = await readBackendFile('src', 'routes', 'admin', 'bandwidth.ts');
    assert.match(route, /adminBandwidthRouter\.use\(authenticate,\s*requireRole\('ADMIN'\)\)/,
      'auth + ADMIN role must guard the whole router');
    for (const p of ['/bandwidth/daily', '/bandwidth/by-worker', '/bandwidth/alerts']) {
      assert.ok(route.includes(`'${p}'`), `endpoint ${p} must exist`);
    }
  });

  test('bandwidth endpoints validate their query params', async () => {
    const route = await readBackendFile('src', 'routes', 'admin', 'bandwidth.ts');
    assert.match(route, /query\('days'\)[\s\S]{0,200}isInt\(\{\s*min:\s*1,\s*max:\s*90\s*\}\)/,
      'days must be bounded 1-90');
    assert.match(route, /query\('limit'\)[\s\S]{0,200}isInt\(\{\s*min:\s*1,\s*max:\s*100\s*\}\)/,
      'limit must be bounded 1-100');
    assert.match(route, /bandwidthReadLimiter/, 'read endpoints must be rate limited');
  });

  test('the sync worker still runs the surviving syncQueue, and the popular-tracks queue is gone (Phase 4)', async () => {
    const workers = await readBackendFile('src', 'jobs', 'workers.ts');
    assert.match(workers, /new Worker<SyncJobData>\(\s*'syncQueue'/, 'the surviving syncQueue worker must remain');
    assert.ok(!/syncPopularTracksQueue/.test(workers),
      'the Spotify popular-tracks queue worker must be gone (Phase 4)');
  });
});
