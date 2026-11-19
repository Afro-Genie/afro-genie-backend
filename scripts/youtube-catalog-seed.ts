import 'dotenv/config';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { prisma } from '../src/lib/prisma';
import {
  addYouTubeCatalogQuotaEstimates,
  buildYouTubeCatalogPreview,
  discoverYouTubeSearch,
  discoverYouTubePlaylist,
  parseYouTubePlaylistId,
  persistYouTubeCatalogCandidate,
  YouTubeQuotaExceededError,
  type CatalogArtist,
  type CatalogCandidate,
} from '../src/services/youtubeCatalogImportService';
import {
  AFRICAN_GENRE_SEARCH_QUERIES,
  YOUTUBE_AFRICAN_CHANNELS,
  YOUTUBE_AFRICAN_PLAYLIST_ARTISTS,
  type YouTubePlaylistArtist,
} from './youtubeCatalogPolicy';

const PROGRESS_FILE = path.join(__dirname, '..', '.youtube-catalog-seed-progress.json');
const SCOPE_VERSION = 'youtube-african-catalog-v4';

function readNumberFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function readNonNegativeNumberFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return value;
}

function readPlaylistId(): string | null {
  const index = process.argv.indexOf('--playlist');
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value) throw new Error('--playlist requires a YouTube playlist URL or ID');
  try {
    return parseYouTubePlaylistId(value);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Invalid YouTube playlist');
  }
}

const args = {
  apply: process.argv.includes('--apply'),
  dryRun: process.argv.includes('--dry-run') || !process.argv.includes('--apply'),
  resume: process.argv.includes('--resume'),
  status: process.argv.includes('--status'),
  queryLimit: readNumberFlag('queries', AFRICAN_GENRE_SEARCH_QUERIES.length),
  maxSearchCalls: readNumberFlag('max-search', 80),
  maxPlaylistPages: readNumberFlag('max-pages', 80),
  maxResults: Math.min(readNumberFlag('max-results', 50), 50),
  delayMs: readNonNegativeNumberFlag('delay-ms', 150),
  playlistId: readPlaylistId(),
};
if (args.apply && process.argv.includes('--dry-run')) {
  throw new Error('Choose either --dry-run or --apply, not both');
}
if (args.resume && !args.apply) {
  throw new Error('--resume requires --apply');
}

const queries = AFRICAN_GENRE_SEARCH_QUERIES.slice(0, args.queryLimit);

const playlistArtistChannels: CatalogArtist[] = YOUTUBE_AFRICAN_PLAYLIST_ARTISTS.map(
  (artist: YouTubePlaylistArtist) => ({
    channelId: artist.channelId,
    artistName: artist.artistName,
    genres: artist.genres,
  }),
);
const reviewedChannels: CatalogArtist[] = YOUTUBE_AFRICAN_CHANNELS.map(channel => ({
  channelId: channel.channelId,
  artistName: channel.artistName,
  genres: channel.genres,
}));
const allReviewedChannels = [...new Map(
  [...reviewedChannels, ...playlistArtistChannels].map(channel => [channel.channelId, channel]),
).values()];
const eligibleChannels: CatalogArtist[] = args.playlistId
  ? allReviewedChannels
  : allReviewedChannels.filter(channel =>
    queries.some(query => channel.genres.includes(query.genre)),
  );
const fingerprint = createHash('sha256')
  .update(JSON.stringify({
    scope: SCOPE_VERSION,
    queryLimit: args.queryLimit,
    maxResults: args.maxResults,
    maxSearchCalls: args.maxSearchCalls,
    maxPlaylistPages: args.maxPlaylistPages,
    playlistId: args.playlistId,
    channels: YOUTUBE_AFRICAN_CHANNELS,
    playlistArtists: YOUTUBE_AFRICAN_PLAYLIST_ARTISTS,
  }))
  .digest('hex');

interface SeedProgress {
  version: 2;
  scopeVersion: string;
  fingerprint: string;
  playlistId: string | null;
  playlistPageToken: string | null;
  playlistComplete: boolean;
  startedAt: string;
  updatedAt: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  queryIndex: number;
  completedQueries: string[];
  failedQueries: string[];
  stats: {
    searchCalls: number;
    playlistPages: number;
    videosExamined: number;
    rejectedChannel: number;
    rejectedVideo: number;
    songsCreated: number;
    existingSongsLinked: number;
    duplicatesSkipped: number;
    errors: number;
  };
}

function readProgressFile(): SeedProgress | null {
  if (!fs.existsSync(PROGRESS_FILE)) return null;
  return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')) as SeedProgress;
}

function loadProgress(): SeedProgress | null {
  const progress = readProgressFile();
  if (!progress) return null;
  if (
    progress.version !== 2 ||
    progress.scopeVersion !== SCOPE_VERSION ||
    progress.fingerprint !== fingerprint
  ) {
    throw new Error(
      'Saved YouTube seed progress does not match the current queries, limits, or reviewed channel allowlist. It was left unchanged.',
    );
  }
  return progress;
}

function saveProgress(progress: SeedProgress): void {
  progress.updatedAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function newProgress(): SeedProgress {
  const now = new Date().toISOString();
  return {
    version: 2,
    scopeVersion: SCOPE_VERSION,
    fingerprint,
    playlistId: args.playlistId,
    playlistPageToken: null,
    playlistComplete: false,
    startedAt: now,
    updatedAt: now,
    status: 'running',
    queryIndex: 0,
    completedQueries: [],
    failedQueries: [],
    stats: {
      searchCalls: 0,
      playlistPages: 0,
      videosExamined: 0,
      rejectedChannel: 0,
      rejectedVideo: 0,
      songsCreated: 0,
      existingSongsLinked: 0,
      duplicatesSkipped: 0,
      errors: 0,
    },
  };
}

interface UnreviewedChannelSummary {
  channelId: string;
  channelTitle: string;
  videos: number;
  sampleTitles: string[];
}

async function inspectPlaylistWithoutAllowlist(playlistId: string): Promise<void> {
  const inspection = await discoverYouTubePlaylist(playlistId, args.maxPlaylistPages);
  console.log(
    `Playlist ${playlistId}: ${inspection.discovery.videosExamined} entries inspected across ` +
    `${inspection.discovery.pagesRead} page(s).`,
  );
  console.log(
    `Estimated YouTube quota: ${inspection.discovery.quotaEstimate.estimatedUnits} units ` +
    `(upper bound ${inspection.discovery.quotaEstimate.maxUnits}).`,
  );
  console.log('No songs were evaluated for import because the reviewed African channel allowlist is empty.');
  console.log(JSON.stringify(inspection.discovery.unreviewedChannels, null, 2));
  if (!inspection.complete) {
    console.warn(`Playlist inspection stopped at --max-pages ${args.maxPlaylistPages}; increase the cap to inspect the remainder.`);
  }
}

async function countCatalog() {
  const [songs, artists, albums] = await Promise.all([
    prisma.song.count(),
    prisma.artist.count(),
    prisma.album.count(),
  ]);
  return { songs, artists, albums };
}

async function updateStatsFromCandidates(
  candidates: CatalogCandidate[],
  stats: SeedProgress['stats'],
): Promise<void> {
  const unique = new Map<string, CatalogCandidate>();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.video.videoId);
    unique.set(
      candidate.video.videoId,
      existing
        ? { ...existing, genres: [...new Set([...existing.genres, ...candidate.genres])] }
        : candidate,
    );
  }
  for (const candidate of unique.values()) {
    const result = await persistYouTubeCatalogCandidate(candidate);
    if (result === 'created') stats.songsCreated++;
    else if (result === 'linked') stats.existingSongsLinked++;
    else stats.duplicatesSkipped++;
  }
}

function displayStatus(progress: SeedProgress): void {
  console.log(JSON.stringify(progress, null, 2));
}

function addDryRunCandidate(
  candidates: Map<string, CatalogCandidate>,
  candidate: CatalogCandidate,
): void {
  const existing = candidates.get(candidate.video.videoId);
  candidates.set(
    candidate.video.videoId,
    existing
      ? { ...existing, genres: [...new Set([...existing.genres, ...candidate.genres])] }
      : candidate,
  );
}

async function main(): Promise<void> {
  if (args.status) {
    const progress = readProgressFile();
    console.log(progress ? JSON.stringify(progress, null, 2) : 'No YouTube catalog seed progress found.');
    return;
  }

  if (!eligibleChannels.length) {
    console.log(`YouTube African catalog ${args.dryRun ? 'dry run' : 'apply'} (${SCOPE_VERSION})`);
    console.log(`Reviewed YouTube channels: ${allReviewedChannels.length}`);
    if (args.apply) throw new Error('Cannot apply the catalog seed without an evidence-backed channel allowlist.');
    if (args.playlistId) {
      if (!process.env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not configured');
      await inspectPlaylistWithoutAllowlist(args.playlistId);
      return;
    }
    console.log('Eligible channels for selected genre queries: 0');
    console.log('No candidates will be searched or written. Add reviewed official YouTube channels with evidence.');
    return;
  }
  if (!process.env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not configured');

  try {
    let progress = args.resume ? loadProgress() : null;
    if (args.resume && (!progress || progress.status === 'completed')) {
      throw new Error('No incomplete compatible YouTube catalog run is available to resume.');
    }
    progress ||= newProgress();
    progress.status = 'running';
    const startIndex = progress.queryIndex;
    const runSearchCalls = { count: 0 };
    const runPlaylistPages = { count: 0 };
    const dryRunCandidates = new Map<string, CatalogCandidate>();
    const unreviewedChannels = new Map<string, UnreviewedChannelSummary>();
    let runQuotaEstimate = {
      estimatedUnits: 0,
      maxUnits: 0,
      searchListCalls: 0,
      playlistItemsListCalls: 0,
      videosListCalls: 0,
    };

    console.log(
      `YouTube catalog ${args.dryRun ? 'dry-run' : 'apply'}: ` +
      `${eligibleChannels.length} reviewed channels, ` +
      (args.playlistId
        ? `playlist ${args.playlistId}, max ${args.maxPlaylistPages} pages this run`
        : `max ${args.maxSearchCalls} search.list calls this run`),
    );

    if (args.playlistId) {
      let pageToken = progress.playlistPageToken || undefined;
      while (runPlaylistPages.count < args.maxPlaylistPages && !progress.playlistComplete) {
        try {
          const discovery = await discoverYouTubePlaylist(args.playlistId, 1, undefined, pageToken);
          runQuotaEstimate = addYouTubeCatalogQuotaEstimates(
            runQuotaEstimate,
            discovery.discovery.quotaEstimate,
          );
          runPlaylistPages.count += discovery.discovery.pagesRead;
          progress.stats.playlistPages += discovery.discovery.pagesRead;
          progress.stats.videosExamined += discovery.discovery.videosExamined;
          progress.stats.rejectedChannel += discovery.discovery.rejectedChannel;
          progress.stats.rejectedVideo += discovery.discovery.rejectedVideo;
          for (const channel of discovery.discovery.unreviewedChannels) {
            const existing = unreviewedChannels.get(channel.channelId);
            unreviewedChannels.set(channel.channelId, existing
              ? {
                ...existing,
                videos: existing.videos + channel.videos,
                sampleTitles: [...existing.sampleTitles, ...channel.sampleTitles].slice(0, 3),
              }
              : channel);
          }
          const candidates = discovery.candidates;
          if (args.dryRun) {
            for (const candidate of candidates) addDryRunCandidate(dryRunCandidates, candidate);
          } else {
            await updateStatsFromCandidates(candidates, progress.stats);
          }
          pageToken = discovery.nextPageToken || undefined;
          progress.playlistPageToken = pageToken || null;
          progress.playlistComplete = discovery.complete;
          progress.status = progress.playlistComplete ? 'completed' : 'paused';
          if (args.apply) saveProgress(progress);
          if (args.delayMs) await new Promise(resolve => setTimeout(resolve, args.delayMs));
        } catch (error) {
          if (error instanceof YouTubeQuotaExceededError) {
            progress.status = 'paused';
            if (args.apply) saveProgress(progress);
            console.warn(`${error.message}. Run again with --resume --apply after the quota resets.`);
            break;
          }
          progress.stats.errors++;
          progress.status = 'failed';
          if (args.apply) saveProgress(progress);
          throw error;
        }
      }
      if (!progress.playlistComplete && runPlaylistPages.count >= args.maxPlaylistPages) {
        progress.status = 'paused';
        if (args.apply) saveProgress(progress);
        console.warn(`Playlist page cap reached (${args.maxPlaylistPages}); resume later with --resume --apply.`);
      }
    } else {
      for (let index = startIndex; index < queries.length; index++) {
        const query = queries[index];
        if (!eligibleChannels.some(channel => channel.genres.includes(query.genre))) {
          progress.queryIndex = index + 1;
          if (args.apply) saveProgress(progress);
          continue;
        }
        if (runSearchCalls.count >= args.maxSearchCalls) {
          progress.status = 'paused';
          if (args.apply) saveProgress(progress);
          console.warn(`Search-call cap reached (${args.maxSearchCalls}); resume later with --resume --apply.`);
          break;
        }
        try {
          console.log(`[${index + 1}/${queries.length}] YouTube search: ${query.query}`);
          runSearchCalls.count++;
          if (args.apply) progress.stats.searchCalls++;
          const discovery = await discoverYouTubeSearch('genre', query.genre, args.maxResults);
          runQuotaEstimate = addYouTubeCatalogQuotaEstimates(
            runQuotaEstimate,
            discovery.discovery.quotaEstimate,
          );
          progress.stats.videosExamined += discovery.discovery.videosExamined;
          progress.stats.rejectedChannel += discovery.discovery.rejectedChannel;
          progress.stats.rejectedVideo += discovery.discovery.rejectedVideo;
          for (const channel of discovery.discovery.unreviewedChannels) {
            const existing = unreviewedChannels.get(channel.channelId);
            unreviewedChannels.set(channel.channelId, existing
              ? {
                ...existing,
                videos: existing.videos + channel.videos,
                sampleTitles: [...existing.sampleTitles, ...channel.sampleTitles].slice(0, 3),
              }
              : channel);
          }
          const candidates = discovery.candidates;
          if (args.dryRun) {
            for (const candidate of candidates) addDryRunCandidate(dryRunCandidates, candidate);
          } else {
            await updateStatsFromCandidates(candidates, progress.stats);
          }
          progress.completedQueries.push(query.query);
          progress.queryIndex = index + 1;
          if (args.apply) saveProgress(progress);
        } catch (error) {
          if (error instanceof YouTubeQuotaExceededError) {
            progress.status = 'paused';
            if (args.apply) saveProgress(progress);
            console.warn(`${error.message}. Run again with --resume --apply after the quota resets.`);
            break;
          }
          progress.stats.errors++;
          progress.failedQueries.push(query.query);
          if (args.apply) {
            progress.status = 'failed';
            saveProgress(progress);
          }
          throw error;
        }
        if (args.delayMs) await new Promise(resolve => setTimeout(resolve, args.delayMs));
      }
    }

    const unreviewedChannelSuggestions = [...unreviewedChannels.values()];
    if (unreviewedChannelSuggestions.length) {
      console.log('\nUnreviewed channels excluded from this import (review suggestions only):');
      console.log(JSON.stringify(unreviewedChannelSuggestions, null, 2));
    }

    if (args.dryRun) {
      const candidates = [...dryRunCandidates.values()];
      const preview = await buildYouTubeCatalogPreview(
        candidates,
        args.playlistId
          ? { type: 'playlist', value: args.playlistId }
          : { type: 'genre-search', value: queries.map(query => query.genre).join(',') },
        {
          pagesRead: runPlaylistPages.count + runSearchCalls.count,
          videosExamined: progress.stats.videosExamined,
          rejectedChannel: progress.stats.rejectedChannel,
          rejectedVideo: progress.stats.rejectedVideo,
          quotaEstimate: runQuotaEstimate,
          unreviewedChannels: [...unreviewedChannels.values()],
        },
      );
      console.log('\nDry-run summary (no writes or progress-file changes):');
      console.log(`  Search API calls: ${runSearchCalls.count}`);
      console.log(`  Playlist pages: ${runPlaylistPages.count}`);
      console.log(
        `  Estimated YouTube quota: ${preview.discovery.quotaEstimate.estimatedUnits} units ` +
        `(upper bound ${preview.discovery.quotaEstimate.maxUnits})`,
      );
      console.log(`  Videos examined: ${progress.stats.videosExamined}`);
      console.log(`  Rejected channels: ${progress.stats.rejectedChannel}`);
      console.log(`  Rejected videos: ${progress.stats.rejectedVideo}`);
      console.log(`  Unique eligible YouTube videos: ${preview.summary.candidates}`);
      console.log(`  Existing video IDs: ${preview.summary.videoIdsAlreadyPresent}`);
      console.log(`  Existing songs to link with YouTube IDs: ${preview.summary.toLink}`);
      console.log(`  Existing title matches already linked: ${preview.summary.alreadyLinked - preview.summary.videoIdsAlreadyPresent}`);
      console.log(`  Proposed new songs: ${preview.summary.toCreate}`);
      console.log(`  Songs now / after: ${preview.summary.songsBefore} / ${preview.summary.songsAfter}`);
    } else {
      if (args.playlistId) {
        progress.status = progress.playlistComplete ? 'completed' : 'paused';
      } else if (progress.queryIndex >= queries.length) {
        progress.status = 'completed';
      }
      saveProgress(progress);
      console.log('YouTube catalog seed summary:');
      displayStatus(progress);
      console.log(`Current catalog counts: ${JSON.stringify(await countCatalog())}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error('YouTube catalog seed failed:', error);
  process.exitCode = 1;
});
