/**
 * Backfill Song.youtubeVideoId from validated YouTube matches (Phase C).
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * The enrichment job is capped at `DAILY_CAP = 99` songs per run and spends one
 * `search.list` unit per song. At 923 songs that is roughly ten days to fill the
 * catalog, and the cap exists only because search is expensive.
 *
 * The fix is to stop searching. An artist's official uploads playlist contains
 * the artist's own tracks, so one `channels.list` (1 unit) plus a walk of
 * `playlistItems.list` (1 unit per 50 videos) covers every song by that artist.
 * Search is then only needed for the leftovers, which is a small fraction of the
 * catalog. The script counts those calls so the residual is visible — if it
 * exceeds the daily search quota, that is the signal to raise the limit rather
 * than a reason to loosen validation.
 *
 * ---------------------------------------------------------------------------
 * Safety
 * ---------------------------------------------------------------------------
 * - `--dry-run` is the default-safe mode and must be run first; it writes no rows.
 * - Nothing here is flag-gated. Matching and rollout are separate concerns: a
 *   `youtubeVideoId` in the database does not make anything playable until
 *   `FLAG_PLAYBACK_YOUTUBE` is on, so a bad run can be neutralised by the
 *   kill switch instead of a rollback.
 * - `youtubeMatchAttempts` only advances on a genuine `no_match`, and only on a
 *   real write. A search/API failure leaves the counter untouched, so a quota
 *   outage cannot dead-letter the catalog.
 * - Songs already carrying a `youtubeVideoId` are left alone unless
 *   `--rematch` is passed, so re-running is idempotent.
 *
 * ---------------------------------------------------------------------------
 * Usage
 * ---------------------------------------------------------------------------
 *   npx tsx scripts/backfill-youtube-ids.ts --dry-run
 *   npx tsx scripts/backfill-youtube-ids.ts --limit 200 --offset 0
 *   npx tsx scripts/backfill-youtube-ids.ts --strictness loose --dry-run
 *   npx tsx scripts/backfill-youtube-ids.ts --report backfill-report.json
 *
 * Flags:
 *   --dry-run           Score and report, write nothing. Default when no other
 *                       write flag is given.
 *   --limit N           Max songs to consider (default 500).
 *   --offset N          Skip N songs, for resumable runs.
 *   --only-unmatched    Consider only songs with youtubeVideoId = null (default).
 *   --rematch           Re-evaluate songs that already have a video id.
 *   --max-attempts N    Skip songs at/over this attempt count (default 5).
 *   --strictness s      strict | loose (default strict).
 *   --no-search         Enumeration only; never call search.list. Useful for
 *                       measuring how much coverage the cheap path alone gives.
 *   --max-search N      Hard cap on search.list calls; the run stops cleanly
 *                       when reached rather than blowing the daily quota.
 *   --report PATH       Write the JSON report here.
 *   --apply             Actually write to the database. Absent => dry run.
 */

// Loads .env before `src/lib/env` is imported below. Every other script in this
// directory does this, and the import order matters: without it the env module
// validates against an empty process.env and throws at import time.
import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { youtubeService } from '../src/services/youtubeService';
import {
  selectBestCandidate,
  STRICT_THRESHOLDS,
  LOOSE_THRESHOLDS,
  type MatchCandidate,
  type Strictness,
} from '../src/services/youtubeMatchValidation';

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};
const num = (name: string, fallback: number): number => {
  const v = value(name);
  const parsed = v !== undefined ? parseInt(v, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

const HELP = `
Backfill Song.youtubeVideoId from validated YouTube matches (Phase C).

Usage:
  npx tsx scripts/backfill-youtube-ids.ts --dry-run
  npx tsx scripts/backfill-youtube-ids.ts --limit 200 --offset 0
  npx tsx scripts/backfill-youtube-ids.ts --strictness loose --dry-run
  npx tsx scripts/backfill-youtube-ids.ts --report backfill-report.json

Flags:
  --dry-run           Score and report, write nothing. This is the default;
                      pass --apply to actually write.
  --apply             Write matches to the database.
  --limit N           Max songs to consider (default 500).
  --offset N          Skip N songs, for resumable runs.
  --rematch           Re-evaluate songs that already have a video id.
  --max-attempts N    Skip songs at/over this attempt count (default 5).
  --strictness s      strict | loose (default strict).
  --no-search         Enumeration only; never call search.list. Measures how
                      much coverage the cheap path alone provides.
  --max-search N      Hard cap on search.list calls (default 100).
  --uploads N         Uploads to inspect per artist (default 200).
  --report PATH       Write the JSON report here.
  --help              Show this message.
`;

if (flag('help') || flag('h')) {
  console.log(HELP);
  process.exit(0);
}

const APPLY = flag('apply');
const DRY_RUN = flag('dry-run') || !APPLY;
const LIMIT = num('limit', 500);
const OFFSET = num('offset', 0);
const REMATCH = flag('rematch');
const MAX_ATTEMPTS = num('max-attempts', 5);
const STRICTNESS: Strictness = value('strictness') === 'loose' ? 'loose' : 'strict';
const ALLOW_SEARCH = !flag('no-search');
const MAX_SEARCH = num('max-search', 100);
const REPORT_PATH = value('report');

const THRESHOLDS = STRICTNESS === 'loose' ? LOOSE_THRESHOLDS : STRICT_THRESHOLDS;

/**
 * Uploads to inspect per artist.
 *
 * 200 is roughly two years of releases for an active artist, and bounds both
 * `playlistItems.list` calls and the `videos.list` detail fetch that follows.
 * Raising it raises cost linearly.
 */
const UPLOADS_PER_ARTIST = num('uploads', 200);

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

interface SongReport {
  songId: string;
  title: string;
  artist: string;
  outcome: 'matched' | 'no_match' | 'skipped' | 'error';
  source: 'uploads' | 'search' | null;
  videoId: string | null;
  videoTitle: string | null;
  channelTitle: string | null;
  score: number | null;
  signals: Record<string, unknown> | null;
  reason: string | null;
  needsEmbeddableCheck: boolean;
}

interface Report {
  startedAt: string;
  finishedAt: string;
  mode: 'dry-run' | 'apply';
  strictness: Strictness;
  filters: { limit: number; offset: number; rematch: boolean; maxAttempts: number; allowSearch: boolean };
  quota: { channelsList: number; playlistItemsList: number; videosList: number; searchList: number };
  totals: {
    considered: number;
    matched: number;
    viaUploads: number;
    viaSearch: number;
    noMatch: number;
    skipped: number;
    errors: number;
    needsEmbeddableCheck: number;
  };
  rejectionReasons: Record<string, number>;
  songs: SongReport[];
}

const quota = { channelsList: 0, playlistItemsList: 0, videosList: 0, searchList: 0 };

const songs: SongReport[] = [];
const rejectionReasons = new Map<string, number>();
const bump = (reason: string) => rejectionReasons.set(reason, (rejectionReasons.get(reason) ?? 0) + 1);

let viaSearchBudgetSpent = false;

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

/**
 * Resolve one song against an already-fetched candidate pool.
 *
 * Splits the pool into accepted and rejected so the report can say *why*
 * something failed — a run that matches 40% is only actionable if you can see
 * that the other 60% was duration drift rather than a bad API key.
 */
const matchAgainstPool = (
  song: { id: string; title: string; durationMs: number | null },
  artistName: string,
  candidates: MatchCandidate[],
  source: 'uploads' | 'search',
): SongReport => {
  const { match, signals } = selectBestCandidate(
    { title: song.title, artist: artistName, durationMs: song.durationMs },
    candidates,
    THRESHOLDS,
  );

  // `signals` is index-aligned with `candidates`, so the winning candidate's
  // signals are found by index rather than by a field — CandidateSignals has no
  // videoId.
  const winnerIndex = match ? candidates.findIndex((c) => c.videoId === match.videoId) : -1;
  const winnerSignals = winnerIndex >= 0 ? signals[winnerIndex] : undefined;

  if (!match) {
    // One reason per song, taken from the highest-scoring candidate. Counting
    // every candidate would make a 200-upload pool report 200 rejections for a
    // single unmatched song and drown the real distribution.
    const best = [...signals].sort((a, b) => b.score - a.score)[0];
    if (best?.reason) bump(best.reason);
    return {
      songId: song.id,
      title: song.title,
      artist: artistName,
      outcome: 'no_match',
      source,
      videoId: null,
      videoTitle: null,
      channelTitle: null,
      score: best?.score ?? null,
      signals: best ? { ...best } : null,
      reason: best?.reason ?? (candidates.length === 0 ? 'no_candidates' : 'all_rejected'),
      needsEmbeddableCheck: false,
    };
  }

  return {
    songId: song.id,
    title: song.title,
    artist: artistName,
    outcome: 'matched',
    source,
    videoId: match.videoId,
    videoTitle: match.title,
    channelTitle: match.channelTitle,
    score: winnerSignals?.score ?? null,
    signals: winnerSignals ? { ...winnerSignals } : null,
    reason: null,
    needsEmbeddableCheck: match.embeddable === null,
  };
};

/**
 * Persist (or, in dry run, record) a match.
 *
 * The duration write is conditional on a real measurement so an unparseable
 * ISO-8601 value leaves the catalog duration alone instead of writing 0 and
 * rendering a broken `0:00` track.
 */
const persist = async (songId: string, report: SongReport, videoDurationSeconds: number | null) => {
  if (DRY_RUN) return;
  await prisma.song.update({
    where: { id: songId },
    data: {
      youtubeVideoId: report.videoId,
      youtubeMatchedAt: new Date(),
      youtubeMatchAttempts: 0,
      ...(videoDurationSeconds !== null && { durationMs: Math.round(videoDurationSeconds * 1000) }),
    },
  });
};

const recordNoMatch = async (songId: string) => {
  if (DRY_RUN) return;
  await prisma.song.update({
    where: { id: songId },
    data: { youtubeMatchAttempts: { increment: 1 } },
  });
};

/** Warm the shared match cache so the serving path does not re-search. */
const cacheMatch = async (title: string, artistName: string, report: SongReport, videoDurationSeconds: number | null) => {
  if (!report.videoId) return;
  // A dry run must not mutate anything, and Redis is state. Caching here would
  // also be premature: the cached entry becomes the serving path's answer, so a
  // rejected-then-fixed report would keep handing out a stale verdict.
  if (DRY_RUN) return;
  try {
    await redis.set(
      `youtube:match:v2:${title.toLowerCase()}:${artistName.toLowerCase()}`,
      JSON.stringify({
        videoId: report.videoId,
        title: report.videoTitle,
        channelTitle: report.channelTitle,
        thumbnailUrl: null,
        durationSeconds: videoDurationSeconds,
      }),
      'EX',
      60 * 60 * 24 * 30,
    );
  } catch {
    // A cache miss only costs a re-search later; never fail a run over it.
  }
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  youtubeService.setValidationThresholds(STRICTNESS);

  const where = {
    softDeleted: false,
    ...(REMATCH ? {} : { youtubeVideoId: null }),
    youtubeMatchAttempts: { lt: MAX_ATTEMPTS },
  };

  const rows = await prisma.song.findMany({
    where,
    include: { artist: { select: { name: true } } },
    orderBy: [{ artistId: 'asc' }, { title: 'asc' }],
    skip: OFFSET,
    take: LIMIT,
  });

  // Group by artist: one uploads walk serves every song that artist has. This is
  // the whole point of the cheap path.
  const byArtist = new Map<string, typeof rows>();
  for (const row of rows) {
    const name = row.artist?.name ?? '';
    const list = byArtist.get(name);
    if (list) list.push(row);
    else byArtist.set(name, [row]);
  }

  console.log(
    `[backfill] mode=${DRY_RUN ? 'dry-run' : 'apply'} strictness=${STRICTNESS} ` +
      `songs=${rows.length} artists=${byArtist.size} offset=${OFFSET} limit=${LIMIT}`,
  );
  let matched = 0;
  let viaUploads = 0;
  let viaSearch = 0;
  let noMatch = 0;
  let skipped = 0;
  let errors = 0;
  let needsEmbeddableCheck = 0;

  let artistIndex = 0;
  for (const [artistName, artistSongs] of byArtist) {
    artistIndex++;
    quota.channelsList += 1;

    let pool: MatchCandidate[] | null = null;
    // Searched lazily, at most once per artist, and shared by every song in
    // `artistSongs`. `undefined` = not attempted, `null` = attempt failed,
    // `[]` = artist absent from YouTube.
    let searchPool: MatchCandidate[] | null | undefined;
    try {
      pool = await youtubeService.listArtistUploads(artistName, UPLOADS_PER_ARTIST);
      // Counted, not estimated: resolving an artist probes every handle spelling
      // (up to 6 channels.list calls), not one.
      quota.channelsList += youtubeService.lastEnumerationChannelsListCalls;
      // One playlistItems.list call per 50 items walked, per channel walked.
      quota.playlistItemsList += youtubeService.lastEnumerationPlaylistItemsCalls;
    } catch (err) {
      console.error(`[${artistIndex}/${byArtist.size}] ${artistName}: uploads failed: ${err}`);
      errors += artistSongs.length;
      continue;
    }

    // Fill in duration + embeddable, which playlistItems.list does not carry.
    if (pool && pool.length > 0) {
      const details = await youtubeService.fetchCandidateDetails(pool.map((c) => c.videoId));
      quota.videosList += Math.ceil(pool.length / 50);
      for (const candidate of pool) {
        const detail = details.get(candidate.videoId);
        candidate.durationSeconds = detail?.durationSeconds ?? null;
        candidate.embeddable = detail?.embeddable ?? null;
      }
    }

    for (const song of artistSongs) {
      let report: SongReport | null = null;
      let source: 'uploads' | 'search' | null = null;

      if (pool && pool.length > 0) {
        report = matchAgainstPool(song, artistName, pool, 'uploads');
        source = 'uploads';
      }

      if (report?.outcome !== 'matched' && ALLOW_SEARCH && !viaSearchBudgetSpent) {
        // Per-artist, not per-song. `search.list` is 100 units against 1 for
        // `videos.list`, so one search answering every song by this artist is
        // ~14x cheaper than `lookupMatch()` per song — and it gives each song a
        // 50-video pool instead of an 8-item window, which is itself a source of
        // false `title_mismatch` rejections.
        //
        // `undefined` = not attempted yet, `null` = the search itself failed,
        // `[]` = YouTube genuinely offered nothing for this artist. Collapsing
        // those last two would either dead-letter a song over a network blip or
        // report "not on YouTube" when we simply could not ask.
        if (searchPool === undefined) {
          if (quota.searchList + 1 > MAX_SEARCH) {
            viaSearchBudgetSpent = true;
            console.warn(
              `[backfill] search budget reached (${MAX_SEARCH}); remaining songs will report no_match. ` +
                'Raise --max-search or accept reduced coverage.',
            );
          } else {
            quota.searchList += 1;
            searchPool = await youtubeService.searchArtistPool(artistName);
            if (searchPool && searchPool.length > 0) {
              // One `videos.list` for the pool (ids accepts up to 50).
              quota.videosList += 1;
            }
          }
        }

        if (searchPool === null) {
          // Song-independent failure (quota, network, bad key). Count it against
          // errors, not attempts, so a quota outage cannot dead-letter the
          // catalog, and defer the songs to a later run.
          //
          // Per-SONG only. An earlier version did `errors += artistSongs.length`
          // from inside the song loop, which is quadratic: 3,402 "errors" for a
          // 923-song catalog, and one report row pushed for every song once per
          // song in that artist. The catalog was never in danger — nothing is
          // written in a dry run — but the report became unreadable.
          errors += 1;
          songs.push({
            songId: song.id,
            title: song.title,
            artist: artistName,
            outcome: 'error',
            source: 'search',
            videoId: null,
            videoTitle: null,
            channelTitle: null,
            score: null,
            signals: null,
            reason: 'search_failed',
            needsEmbeddableCheck: false,
          });
          continue;
        }

        // `undefined` survives only when the budget was exhausted before this
        // artist's search could be attempted. Falling through leaves `report`
        // exactly as uploads left it, so the song is reported as `skipped` below
        // rather than being treated as a rejection or a genuine no-match.
        if (searchPool === undefined) {
          // budget spent
        } else if (searchPool.length === 0) {
          // The artist has nothing on YouTube at all. Its songs are permanently
          // unmatchable by search, but the uploads verdict still stands and is
          // more informative than "search returned nothing".
          bump('search:no_artist_results');
        } else {
          const searched = matchAgainstPool(song, artistName, searchPool, 'search');
          if (searched.outcome === 'matched') {
            report = searched;
            source = 'search';
          } else if (report === null) {
            report = { ...searched, reason: `search:${searched.reason}` };
            source = 'search';
          } else if (searched.reason) {
            // Uploads already produced a rejection. Record that search was also
            // tried so the report distinguishes "unmatched with search help"
            // from "unmatched and unsearched".
            bump(`search:${searched.reason}`);
          }
        }
      }

      if (!report) {
        // Enumeration found nothing and search is off. That is a coverage gap,
        // not a dead letter: the song is simply deferred to a later run.
        skipped += 1;
        songs.push({
          songId: song.id,
          title: song.title,
          artist: artistName,
          outcome: 'skipped',
          source: null,
          videoId: null,
          videoTitle: null,
          channelTitle: null,
          score: null,
          signals: null,
          reason: pool ? 'enumeration_no_match' : 'no_uploads_playlist',
          needsEmbeddableCheck: false,
        });
        continue;
      }

      if (report.outcome === 'matched' && report.videoId) {
        // The winner may have come from either pool, so look in both before
        // giving up on the duration.
        const durationSeconds =
          pool?.find((c) => c.videoId === report!.videoId)?.durationSeconds ??
          (Array.isArray(searchPool)
            ? searchPool.find((c) => c.videoId === report!.videoId)?.durationSeconds
            : null) ??
          null;
        await persist(song.id, report, durationSeconds);
        await cacheMatch(song.title, artistName, report, durationSeconds);
        matched += 1;
        if (source === 'search') viaSearch += 1;
        else viaUploads += 1;
        if (report.needsEmbeddableCheck) needsEmbeddableCheck += 1;
      } else {
        await recordNoMatch(song.id);
        noMatch += 1;
      }

      songs.push(report);
    }

    if (artistIndex % 10 === 0 || artistIndex === byArtist.size) {
      console.log(
        `[${artistIndex}/${byArtist.size}] matched=${matched} viaUploads=${viaUploads} ` +
          `viaSearch=${viaSearch} noMatch=${noMatch} skipped=${skipped} errors=${errors} ` +
          `searchUsed=${quota.searchList}/${MAX_SEARCH}`,
      );
    }
  }

  const report: Report = {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'apply',
    strictness: STRICTNESS,
    filters: { limit: LIMIT, offset: OFFSET, rematch: REMATCH, maxAttempts: MAX_ATTEMPTS, allowSearch: ALLOW_SEARCH },
    quota,
    totals: {
      considered: rows.length,
      matched,
      viaUploads,
      viaSearch,
      noMatch,
      skipped,
      errors,
      needsEmbeddableCheck,
    },
    rejectionReasons: Object.fromEntries([...rejectionReasons.entries()].sort((a, b) => b[1] - a[1])),
    songs,
  };

  console.log('\n=== backfill summary ===');
  console.log(`mode            ${report.mode}`);
  console.log(`considered      ${report.totals.considered}`);
  console.log(`matched         ${report.totals.matched} (uploads ${report.totals.viaUploads}, search ${report.totals.viaSearch})`);
  console.log(`no_match        ${report.totals.noMatch}`);
  console.log(`skipped         ${report.totals.skipped}`);
  console.log(`errors          ${report.totals.errors}`);
  console.log(`embeddable?     ${report.totals.needsEmbeddableCheck} accepted without a status check`);
  console.log(`quota used      channels ${quota.channelsList}, playlistItems ${quota.playlistItemsList}, videos ${quota.videosList}, search ${quota.searchList}`);
  if (report.rejectionReasons[Object.keys(report.rejectionReasons)[0]]) {
    console.log(`rejections      ${JSON.stringify(report.rejectionReasons)}`);
  }
  if (quota.searchList >= MAX_SEARCH) {
    console.log(
      `\nNOTE: search budget (${MAX_SEARCH}) was exhausted. Residual search calls above ` +
        'the daily quota require raising "Search Queries per day" in Google Cloud Console.',
    );
  }
  if (DRY_RUN) console.log('\nDry run: nothing was written. Re-run with --apply to persist.');

  if (REPORT_PATH) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`report written  ${REPORT_PATH}`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    await redis.quit?.();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('Fatal error:', err);
    await prisma.$disconnect();
    process.exit(1);
  });