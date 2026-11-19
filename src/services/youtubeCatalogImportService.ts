import { createHash } from 'node:crypto';
import type { YouTubePlaylistArtist, YouTubeCatalogChannel, YouTubeVideoCandidate } from './youtubeCatalogPolicy';
import {
  AFRICAN_GENRE_SEARCH_QUERIES,
  YOUTUBE_AFRICAN_CHANNELS,
  YOUTUBE_AFRICAN_PLAYLIST_ARTISTS,
  classifyAfricanGenres,
  isEligibleYouTubeMusicVideo,
  normalizeArtistIdentity,
  normalizeVideoTitle,
} from './youtubeCatalogPolicy';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const POLICY_VERSION = 'youtube-african-catalog-v4';

export type CatalogSearchMode = 'artist' | 'genre' | 'song';

export type CatalogImportSource =
  | { type: 'playlist'; value: string; maxPages: number }
  | { type: CatalogSearchMode; value: string; maxResults: number };

export interface CatalogQuotaEstimate {
  estimatedUnits: number;
  maxUnits: number;
  searchListCalls: number;
  playlistItemsListCalls: number;
  videosListCalls: number;
}

export interface CatalogArtist {
  channelId: string;
  artistName: string;
  genres: string[];
}

export interface CatalogCandidate {
  video: YouTubeVideoCandidate;
  channel: CatalogArtist;
  imageUrl: string | null;
  genres: string[];
}

export type CatalogCandidateAction = 'create' | 'link' | 'skip';

export interface CatalogPreviewItem {
  candidate: CatalogCandidate;
  normalizedTitle: string;
  action: CatalogCandidateAction;
  reason: string | null;
}

export interface CatalogPreview {
  version: 1;
  previewHash: string;
  policyFingerprint: string;
  source: {
    type: 'playlist' | 'artist-search' | 'genre-search' | 'song-search';
    value: string;
  };
  createdAt: string;
  complete: boolean;
  nextPageToken: string | null;
  discovery: {
    pagesRead: number;
    videosExamined: number;
    rejectedChannel: number;
    rejectedVideo: number;
    quotaEstimate: CatalogQuotaEstimate;
    unreviewedChannels: Array<{
      channelId: string;
      channelTitle: string;
      videos: number;
      sampleTitles: string[];
    }>;
  };
  summary: {
    candidates: number;
    toCreate: number;
    toLink: number;
    alreadyLinked: number;
    duplicatesSkipped: number;
    videoIdsAlreadyPresent: number;
    songsBefore: number;
    songsAfter: number;
  };
  items: CatalogPreviewItem[];
}

export interface CatalogPlaylistCheckpoint {
  candidates: CatalogCandidate[];
  complete: boolean;
  nextPageToken: string | null;
  discovery: CatalogPreview['discovery'];
}

export interface PlaylistDiscoveryProgress {
  pagesRead: number;
  maxPages: number;
  videosExamined: number;
  eligibleCandidates: number;
}

interface SearchItem {
  id?: { videoId?: string };
  snippet?: {
    channelId?: string;
    channelTitle?: string;
    title?: string;
    publishedAt?: string;
    thumbnails?: {
      high?: { url?: string };
      medium?: { url?: string };
      default?: { url?: string };
    };
  };
}

interface PlaylistItem {
  snippet?: {
    resourceId?: { videoId?: string };
    videoOwnerChannelId?: string;
    videoOwnerChannelTitle?: string;
    title?: string;
    publishedAt?: string;
    thumbnails?: SearchItem['snippet'] extends infer S
      ? S extends { thumbnails?: infer T } ? T : never
      : never;
  };
}

interface VideoDetail {
  id: string;
  snippet?: { title?: string; categoryId?: string; publishedAt?: string; channelId?: string };
  contentDetails?: { duration?: string };
  status?: { embeddable?: boolean };
}

interface PlaylistPage {
  items?: PlaylistItem[];
  nextPageToken?: string;
}

export class YouTubeQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YouTubeQuotaExceededError';
  }
}

export class StaleCatalogPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleCatalogPreviewError';
  }
}

export function parseYouTubePlaylistId(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Provide a valid YouTube playlist URL or ID');
  }

  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)) {
    throw new Error('Playlist URL must be from YouTube');
  }
  const playlistId = url.searchParams.get('list');
  if (!playlistId || !/^[A-Za-z0-9_-]{10,}$/.test(playlistId)) {
    throw new Error('Playlist URL must include a valid playlist ID');
  }
  return playlistId;
}

function policyFingerprint(): string {
  return createHash('sha256')
    .update(JSON.stringify({
      version: POLICY_VERSION,
      channels: YOUTUBE_AFRICAN_CHANNELS,
      playlistArtists: YOUTUBE_AFRICAN_PLAYLIST_ARTISTS,
      genreQueries: AFRICAN_GENRE_SEARCH_QUERIES,
    }))
    .digest('hex');
}

function channelAsCatalogArtist(
  channel: YouTubeCatalogChannel | YouTubePlaylistArtist,
): CatalogArtist {
  return {
    channelId: channel.channelId,
    artistName: channel.artistName,
    genres: [...channel.genres],
  };
}

function playlistChannelMap(): Map<string, CatalogArtist> {
  const reviewed: Array<YouTubeCatalogChannel | YouTubePlaylistArtist> = [
    ...YOUTUBE_AFRICAN_CHANNELS,
    ...YOUTUBE_AFRICAN_PLAYLIST_ARTISTS,
  ];
  return new Map(reviewed.map((channel) => {
    const artist = channelAsCatalogArtist(channel);
    return [artist.channelId, artist];
  }));
}

function searchChannels(mode: CatalogSearchMode, value: string): {
  query: string;
  channels: Map<string, CatalogArtist>;
  genres: string[] | null;
} {
  const allChannels = playlistChannelMap();
  if (mode === 'artist') {
    const identity = normalizeArtistIdentity(value);
    const matches = [...allChannels.values()].filter(
      (channel) => normalizeArtistIdentity(channel.artistName) === identity,
    );
    if (!matches.length) {
      throw new Error('Artist is not in the configured African artist channel manifest.');
    }
    const artistNames = new Set(matches.map((channel) => channel.artistName));
    if (artistNames.size !== 1) {
      throw new Error('Artist name is ambiguous in the reviewed allowlist; use an exact unambiguous artist name.');
    }
    return {
      query: matches[0].artistName,
      channels: new Map(matches.map((channel) => [channel.channelId, channel])),
      genres: null,
    };
  }

  if (mode === 'genre') {
    const [genre] = classifyAfricanGenres([value]);
    if (!genre) throw new Error('Genre is not an approved African music genre.');
    const matches = [...allChannels.values()].filter((channel) => channel.genres.includes(genre));
    if (!matches.length) {
      throw new Error('No configured African artist channels are available for this genre.');
    }
    return {
      query: AFRICAN_GENRE_SEARCH_QUERIES.find((entry) => entry.genre === genre)?.query || genre,
      channels: new Map(matches.map((channel) => [channel.channelId, channel])),
      genres: [genre],
    };
  }

  return { query: value, channels: allChannels, genres: null };
}

export function resolveYouTubeCatalogImportSource(
  mode: 'playlist' | CatalogSearchMode,
  value: string,
  maxPages = 80,
  maxResults = 50,
): CatalogImportSource {
  const trimmed = value.trim();
  if (mode === 'playlist') {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 80) {
      throw new Error('Playlist page cap must be an integer between 1 and 80.');
    }
    return { type: 'playlist', value: parseYouTubePlaylistId(trimmed), maxPages };
  }
  if (trimmed.length < 2 || trimmed.length > 100) {
    throw new Error('Search input must be between 2 and 100 characters.');
  }
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
    throw new Error('Search result limit must be an integer between 1 and 50.');
  }

  const search = searchChannels(mode, trimmed);
  const normalizedValue = mode === 'artist'
    ? search.query
    : mode === 'genre'
      ? classifyAfricanGenres([trimmed])[0]
      : trimmed;
  return { type: mode, value: normalizedValue, maxResults };
}

export function estimateYouTubeCatalogQuota(source: CatalogImportSource): CatalogQuotaEstimate {
  if (source.type === 'playlist') {
    return {
      estimatedUnits: source.maxPages * 2,
      maxUnits: source.maxPages * 2,
      searchListCalls: 0,
      playlistItemsListCalls: source.maxPages,
      videosListCalls: source.maxPages,
    };
  }
  return {
    estimatedUnits: 101,
    maxUnits: 101,
    searchListCalls: 1,
    playlistItemsListCalls: 0,
    videosListCalls: 1,
  };
}

function quotaEstimate(
  searchListCalls: number,
  playlistItemsListCalls: number,
  videosListCalls: number,
  maxUnits: number,
): CatalogQuotaEstimate {
  return {
    estimatedUnits: searchListCalls * 100 + playlistItemsListCalls + videosListCalls,
    maxUnits,
    searchListCalls,
    playlistItemsListCalls,
    videosListCalls,
  };
}

export function addYouTubeCatalogQuotaEstimates(
  first: CatalogQuotaEstimate | undefined,
  second: CatalogQuotaEstimate,
): CatalogQuotaEstimate {
  const searchListCalls = (first?.searchListCalls || 0) + second.searchListCalls;
  const playlistItemsListCalls = (first?.playlistItemsListCalls || 0) + second.playlistItemsListCalls;
  const videosListCalls = (first?.videosListCalls || 0) + second.videosListCalls;
  return quotaEstimate(
    searchListCalls,
    playlistItemsListCalls,
    videosListCalls,
    (first?.maxUnits || 0) + second.maxUnits,
  );
}

function parseDuration(duration: string | undefined): number | null {
  if (!duration) return null;
  const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

async function youtubeGet<T>(resource: string, params: Record<string, string>): Promise<T> {
  if (!env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not configured');
  const url = new URL(`${YOUTUBE_API}/${resource}`);
  for (const [key, value] of Object.entries({ ...params, key: env.YOUTUBE_API_KEY })) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url);
  if (!response.ok) {
    let reason = '';
    try {
      const body = await response.json() as { error?: { errors?: Array<{ reason?: string }> } };
      reason = body.error?.errors?.[0]?.reason || '';
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }

    const message = `YouTube ${resource} returned HTTP ${response.status}${reason ? ` (${reason})` : ''}`;
    if (response.status === 403 && /quotaExceeded|dailyLimitExceeded/i.test(reason)) {
      throw new YouTubeQuotaExceededError(message);
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

async function fetchPlaylistPage(playlistId: string, pageToken?: string): Promise<PlaylistPage> {
  return youtubeGet<PlaylistPage>('playlistItems', {
    part: 'snippet',
    playlistId,
    maxResults: '50',
    ...(pageToken && { pageToken }),
  });
}

function playlistItemAsSearchItem(item: PlaylistItem): SearchItem {
  return {
    id: { videoId: item.snippet?.resourceId?.videoId },
    snippet: {
      channelId: item.snippet?.videoOwnerChannelId,
      title: item.snippet?.title,
      publishedAt: item.snippet?.publishedAt,
      thumbnails: item.snippet?.thumbnails,
    },
  };
}

async function fetchVideoDetails(videoIds: string[]): Promise<Map<string, VideoDetail>> {
  const details = new Map<string, VideoDetail>();
  for (let index = 0; index < videoIds.length; index += 50) {
    const batch = videoIds.slice(index, index + 50);
    const response = await youtubeGet<{ items?: VideoDetail[] }>('videos', {
      part: 'snippet,contentDetails,status',
      id: batch.join(','),
      maxResults: String(batch.length),
    });
    for (const item of response.items || []) details.set(item.id, item);
  }
  return details;
}

function candidateFrom(
  item: SearchItem,
  detail: VideoDetail | undefined,
  channel: CatalogArtist,
  genres: string[] = channel.genres,
): CatalogCandidate | null {
  const videoId = item.id?.videoId;
  const channelId = detail?.snippet?.channelId || item.snippet?.channelId;
  const title = detail?.snippet?.title || item.snippet?.title || '';
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId) || !channelId || !detail || !title) return null;

  const video: YouTubeVideoCandidate = {
    videoId,
    channelId,
    title,
    categoryId: detail.snippet?.categoryId || null,
    embeddable: typeof detail.status?.embeddable === 'boolean' ? detail.status.embeddable : null,
    durationSeconds: parseDuration(detail.contentDetails?.duration),
    publishedAt: detail.snippet?.publishedAt || item.snippet?.publishedAt || null,
  };
  if (!isEligibleYouTubeMusicVideo(video, channel)) return null;

  return {
    video,
    channel,
    imageUrl:
      item.snippet?.thumbnails?.high?.url ||
      item.snippet?.thumbnails?.medium?.url ||
      item.snippet?.thumbnails?.default?.url ||
      null,
    genres: [...genres],
  };
}

function mergeCandidates(candidates: CatalogCandidate[]): CatalogCandidate[] {
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
  return [...unique.values()];
}

export async function discoverYouTubePlaylist(
  playlistId: string,
  maxPages: number,
  onProgress?: (progress: PlaylistDiscoveryProgress) => Promise<void> | void,
  startPageToken?: string,
  onCheckpoint?: (checkpoint: CatalogPlaylistCheckpoint) => Promise<void> | void,
): Promise<{
  candidates: CatalogCandidate[];
  complete: boolean;
  discovery: CatalogPreview['discovery'];
  nextPageToken: string | null;
}> {
  const channelById = playlistChannelMap();
  const candidates: CatalogCandidate[] = [];
  const unreviewedChannels = new Map<string, CatalogPreview['discovery']['unreviewedChannels'][number]>();
  let pageToken: string | undefined = startPageToken;
  let pagesRead = 0;
  let videosExamined = 0;
  let rejectedChannel = 0;
  let rejectedVideo = 0;
  let videosListCalls = 0;
  let complete = false;

  while (pagesRead < maxPages && !complete) {
    const page = await fetchPlaylistPage(playlistId, pageToken);
    const items = page.items || [];
    pagesRead++;
    videosExamined += items.length;

    const allowedItems: SearchItem[] = [];
    for (const item of items) {
      const snippet = item.snippet;
      const channelId = snippet?.videoOwnerChannelId;
      if (channelId && !channelById.has(channelId)) {
        const summary = unreviewedChannels.get(channelId) || {
          channelId,
          channelTitle: snippet?.videoOwnerChannelTitle || 'Unknown',
          videos: 0,
          sampleTitles: [],
        };
        summary.videos++;
        if (summary.sampleTitles.length < 3 && snippet?.title) summary.sampleTitles.push(snippet.title);
        unreviewedChannels.set(channelId, summary);
      }

      if (!channelId || !channelById.has(channelId)) {
        rejectedChannel++;
      } else {
        allowedItems.push(playlistItemAsSearchItem(item));
      }
    }

    const ids = [...new Set(allowedItems.map((item) => item.id?.videoId).filter((id): id is string => !!id))];
    if (ids.length) {
      videosListCalls += Math.ceil(ids.length / 50);
      const details = await fetchVideoDetails(ids);
      for (const item of allowedItems) {
        const channelId = item.snippet?.channelId;
        const videoId = item.id?.videoId;
        const channel = channelId ? channelById.get(channelId) : undefined;
        if (!channel || !videoId) continue;
        const candidate = candidateFrom(item, details.get(videoId), channel);
        if (candidate) candidates.push(candidate);
        else rejectedVideo++;
      }
    }

    pageToken = page.nextPageToken;
    complete = !pageToken;
    await onCheckpoint?.({
      candidates: mergeCandidates(candidates),
      complete,
      nextPageToken: pageToken || null,
      discovery: {
        pagesRead,
        videosExamined,
        rejectedChannel,
        rejectedVideo,
        quotaEstimate: quotaEstimate(0, pagesRead, videosListCalls, maxPages * 2),
        unreviewedChannels: [...unreviewedChannels.values()],
      },
    });
    await onProgress?.({
      pagesRead,
      maxPages,
      videosExamined,
      eligibleCandidates: mergeCandidates(candidates).length,
    });
  }

  return {
    candidates: mergeCandidates(candidates),
    complete,
    nextPageToken: pageToken || null,
    discovery: {
      pagesRead,
      videosExamined,
      rejectedChannel,
      rejectedVideo,
      quotaEstimate: quotaEstimate(0, pagesRead, videosListCalls, maxPages * 2),
      unreviewedChannels: [...unreviewedChannels.values()],
    },
  };
}

export async function discoverYouTubeSearch(
  mode: CatalogSearchMode,
  value: string,
  maxResults: number,
  onProgress?: (progress: { videosExamined: number; eligibleCandidates: number }) => Promise<void> | void,
): Promise<{
  source: CatalogPreview['source'];
  candidates: CatalogCandidate[];
  complete: true;
  discovery: CatalogPreview['discovery'];
}> {
  const sourceInput = resolveYouTubeCatalogImportSource(mode, value, 80, maxResults);
  if (sourceInput.type === 'playlist') throw new Error('Search mode is required for YouTube search discovery.');
  const search = searchChannels(sourceInput.type, sourceInput.value);
  const response = await youtubeGet<{ items?: SearchItem[] }>('search', {
    part: 'snippet',
    type: 'video',
    videoCategoryId: '10',
    maxResults: String(maxResults),
    q: search.query,
    order: 'relevance',
    safeSearch: 'none',
  });
  const items = response.items || [];
  const allChannels = playlistChannelMap();
  const unreviewedChannels = new Map<string, CatalogPreview['discovery']['unreviewedChannels'][number]>();
  const eligibleItems: SearchItem[] = [];
  let rejectedChannel = 0;

  for (const item of items) {
    const channelId = item.snippet?.channelId;
    if (!channelId || !search.channels.has(channelId)) {
      rejectedChannel++;
      if (channelId && !allChannels.has(channelId)) {
        const summary = unreviewedChannels.get(channelId) || {
          channelId,
          channelTitle: item.snippet?.channelTitle || 'Unknown',
          videos: 0,
          sampleTitles: [],
        };
        summary.videos++;
        if (summary.sampleTitles.length < 3 && item.snippet?.title) {
          summary.sampleTitles.push(item.snippet.title);
        }
        unreviewedChannels.set(channelId, summary);
      }
      continue;
    }
    eligibleItems.push(item);
  }

  const videoIds = [...new Set(eligibleItems.map((item) => item.id?.videoId).filter((id): id is string => !!id))];
  const videosListCalls = Math.ceil(videoIds.length / 50);
  const details = videoIds.length ? await fetchVideoDetails(videoIds) : new Map<string, VideoDetail>();
  let rejectedVideo = 0;
  const candidates: CatalogCandidate[] = [];
  for (const item of eligibleItems) {
    const channelId = item.snippet?.channelId;
    const channel = channelId ? search.channels.get(channelId) : undefined;
    const videoId = item.id?.videoId;
    if (!channel || !videoId) {
      rejectedVideo++;
      continue;
    }
    const candidate = candidateFrom(item, details.get(videoId), channel, search.genres || channel.genres);
    if (candidate) candidates.push(candidate);
    else rejectedVideo++;
  }
  const uniqueCandidates = mergeCandidates(candidates);
  await onProgress?.({ videosExamined: items.length, eligibleCandidates: uniqueCandidates.length });
  const sourceType = `${mode}-search` as const;
  return {
    source: { type: sourceType, value: sourceInput.value },
    candidates: uniqueCandidates,
    complete: true,
    discovery: {
      pagesRead: 1,
      videosExamined: items.length,
      rejectedChannel,
      rejectedVideo,
      quotaEstimate: quotaEstimate(1, 0, videosListCalls, 101),
      unreviewedChannels: [...unreviewedChannels.values()],
    },
  };
}

function titleYear(publishedAt: string | null): number | null {
  if (!publishedAt) return null;
  const year = new Date(publishedAt).getUTCFullYear();
  return Number.isInteger(year) && year >= 1900 ? year : null;
}

export async function buildYouTubeCatalogPreview(
  rawCandidates: CatalogCandidate[],
  source: CatalogPreview['source'],
  discovery?: CatalogPreview['discovery'],
  complete = true,
  nextPageToken: string | null = null,
): Promise<CatalogPreview> {
  const candidates = mergeCandidates(rawCandidates);
  const videoIds = candidates.map((candidate) => candidate.video.videoId);
  const artistNames = [...new Set(candidates.map((candidate) => candidate.channel.artistName))];
  const titles = [...new Set(candidates.map((candidate) =>
    normalizeVideoTitle(candidate.video.title, candidate.channel.artistName),
  ).filter(Boolean))];

  const [existingVideos, artists, songsBefore] = await Promise.all([
    videoIds.length
      ? prisma.song.findMany({
        where: { youtubeVideoId: { in: videoIds } },
        select: { youtubeVideoId: true },
      })
      : Promise.resolve([]),
    artistNames.length
      ? prisma.artist.findMany({
        where: { name: { in: artistNames } },
        select: { id: true, name: true },
      })
      : Promise.resolve([]),
    prisma.song.count(),
  ]);
  const existingVideoIds = new Set(existingVideos.map((song) => song.youtubeVideoId));
  const artistByName = new Map(artists.map((artist) => [artist.name, artist]));
  const artistIds = artists.map((artist) => artist.id);
  const existingSongs = artistIds.length && titles.length
    ? await prisma.song.findMany({
      where: { artistId: { in: artistIds }, title: { in: titles } },
      select: { title: true, artistId: true, youtubeVideoId: true },
    })
    : [];
  const artistNameById = new Map(artists.map((artist) => [artist.id, artist.name]));
  const existingByTitleArtist = new Map(existingSongs.map((song) => [
    `${(artistNameById.get(song.artistId) || '').toLocaleLowerCase()}\u0000${song.title.toLocaleLowerCase()}`,
    song,
  ]));

  let toCreate = 0;
  let toLink = 0;
  let alreadyLinked = 0;
  let duplicatesSkipped = 0;
  let videoIdsAlreadyPresent = 0;
  const seenTitleArtist = new Set<string>();
  const items: CatalogPreviewItem[] = candidates.map((candidate) => {
    const normalizedTitle = normalizeVideoTitle(candidate.video.title, candidate.channel.artistName);
    if (existingVideoIds.has(candidate.video.videoId)) {
      videoIdsAlreadyPresent++;
      alreadyLinked++;
      return { candidate, normalizedTitle, action: 'skip', reason: 'YouTube video ID is already in the catalog.' };
    }

    const key = `${candidate.channel.artistName.toLocaleLowerCase()}\u0000${normalizedTitle.toLocaleLowerCase()}`;
    if (seenTitleArtist.has(key)) {
      duplicatesSkipped++;
      return { candidate, normalizedTitle, action: 'skip', reason: 'Another candidate has the same normalized title and artist.' };
    }
    seenTitleArtist.add(key);
    const existingSong = existingByTitleArtist.get(key);
    if (existingSong?.youtubeVideoId) {
      alreadyLinked++;
      return { candidate, normalizedTitle, action: 'skip', reason: 'Matching song already has a YouTube video ID.' };
    }
    if (existingSong) {
      toLink++;
      return { candidate, normalizedTitle, action: 'link', reason: 'Link YouTube ID to the existing title and artist.' };
    }
    if (!artistByName.has(candidate.channel.artistName)) {
      toCreate++;
      return { candidate, normalizedTitle, action: 'create', reason: 'Create a song for a configured African artist channel.' };
    }
    toCreate++;
    return { candidate, normalizedTitle, action: 'create', reason: 'Create a new song for a configured African artist.' };
  });

  const policy = policyFingerprint();
  const hashPayload = {
    version: 1,
    policyFingerprint: policy,
    source,
    complete,
    nextPageToken,
    items,
  };
  const previewHash = createHash('sha256').update(JSON.stringify(hashPayload)).digest('hex');
  return {
    version: 1,
    previewHash,
    policyFingerprint: policy,
    source,
    createdAt: new Date().toISOString(),
    complete,
    nextPageToken,
    discovery: discovery || {
      pagesRead: 0,
      videosExamined: candidates.length,
      rejectedChannel: 0,
      rejectedVideo: 0,
      quotaEstimate: quotaEstimate(0, 0, 0, 0),
      unreviewedChannels: [],
    },
    summary: {
      candidates: candidates.length,
      toCreate,
      toLink,
      alreadyLinked,
      duplicatesSkipped,
      videoIdsAlreadyPresent,
      songsBefore,
      songsAfter: songsBefore + toCreate,
    },
    items,
  };
}

export function validateYouTubeCatalogPreview(
  preview: CatalogPreview,
  expectedHash: string,
  allowIncomplete = false,
): void {
  if (
    !preview ||
    typeof preview !== 'object' ||
    preview.version !== 1 ||
    typeof preview.previewHash !== 'string' ||
    preview.previewHash !== expectedHash ||
    !preview.source ||
    !['playlist', 'artist-search', 'genre-search', 'song-search'].includes(preview.source.type) ||
    typeof preview.source.value !== 'string' ||
    typeof preview.complete !== 'boolean' ||
    !(preview.nextPageToken === null || typeof preview.nextPageToken === 'string') ||
    !Array.isArray(preview.items)
  ) {
    throw new StaleCatalogPreviewError('Preview confirmation does not match the reviewed import.');
  }
  if (!allowIncomplete && !preview.complete) {
    throw new StaleCatalogPreviewError('The playlist preview is incomplete and cannot be applied.');
  }
  if (preview.policyFingerprint !== policyFingerprint()) {
    throw new StaleCatalogPreviewError('African-music policy changed after this preview. Create a new preview.');
  }
  const computedHash = createHash('sha256')
    .update(JSON.stringify({
      version: 1,
      policyFingerprint: preview.policyFingerprint,
      source: preview.source,
      complete: preview.complete,
      nextPageToken: preview.nextPageToken,
      items: preview.items,
    }))
    .digest('hex');
  if (computedHash !== preview.previewHash) {
    throw new StaleCatalogPreviewError('Preview data failed integrity validation. Create a new preview.');
  }
}

export type CatalogPersistResult = 'created' | 'linked' | 'duplicate';

export interface CatalogApplyFailure {
  videoId: string;
  title: string;
  message: string;
}

export async function persistYouTubeCatalogCandidate(
  candidate: CatalogCandidate,
): Promise<CatalogPersistResult> {
  const title = normalizeVideoTitle(candidate.video.title, candidate.channel.artistName);
  const durationSeconds = candidate.video.durationSeconds;
  if (!title || durationSeconds === null) return 'duplicate';

  try {
    return await prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT 1::int
        FROM (SELECT pg_advisory_xact_lock(hashtext(${candidate.video.videoId}))) AS video_lock
      `;

      const videoAlreadyLinked = await transaction.song.findFirst({
        where: { youtubeVideoId: candidate.video.videoId },
        select: { id: true },
      });
      if (videoAlreadyLinked) return 'duplicate';

      const artist = await transaction.artist.upsert({
        where: { name: candidate.channel.artistName },
        create: {
          name: candidate.channel.artistName,
          genres: candidate.channel.genres,
          verified: false,
        },
        update: {},
        select: { id: true },
      });
      const existingSong = await transaction.song.findUnique({
        where: { title_artistId: { title, artistId: artist.id } },
        select: { id: true, youtubeVideoId: true, durationMs: true },
      });
      let songId: string;
      let result: CatalogPersistResult;
      if (existingSong) {
        if (existingSong.youtubeVideoId) return 'duplicate';
        const updated = await transaction.song.updateMany({
          where: { id: existingSong.id, youtubeVideoId: null },
          data: {
            youtubeVideoId: candidate.video.videoId,
            youtubeMatchedAt: new Date(),
            youtubeMatchAttempts: 0,
            ...(existingSong.durationMs === null && {
              durationMs: durationSeconds * 1000,
            }),
          },
        });
        if (!updated.count) return 'duplicate';
        songId = existingSong.id;
        result = 'linked';
      } else {
        const song = await transaction.song.create({
          data: {
            title,
            artistId: artist.id,
            imageUrl: candidate.imageUrl,
            youtubeVideoId: candidate.video.videoId,
            youtubeMatchedAt: new Date(),
            youtubeMatchAttempts: 0,
            durationMs: durationSeconds * 1000,
            releaseYear: titleYear(candidate.video.publishedAt),
          },
          select: { id: true },
        });
        songId = song.id;
        result = 'created';
      }

      for (const name of candidate.genres) {
        const genre = await transaction.genre.upsert({
          where: { name },
          create: { name },
          update: {},
          select: { id: true },
        });
        await transaction.songGenre.createMany({
          data: [{ songId, genreId: genre.id }],
          skipDuplicates: true,
        });
      }
      return result;
    }, { maxWait: 15_000, timeout: 30_000 });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    ) {
      return 'duplicate';
    }
    throw error;
  }
}

export async function applyYouTubeCatalogPreview(
  preview: CatalogPreview,
  expectedHash: string,
  onProgress?: (progress: {
    created: number;
    linked: number;
    skipped: number;
    failed: number;
    completed: number;
    total: number;
    failures: CatalogApplyFailure[];
  }) => Promise<void> | void,
): Promise<{
  created: number;
  linked: number;
  skipped: number;
  failed: number;
  completed: number;
  total: number;
  failures: CatalogApplyFailure[];
}> {
  validateYouTubeCatalogPreview(preview, expectedHash);
  const applicable = preview.items.filter((item) => item.action !== 'skip');
  const results = {
    created: 0,
    linked: 0,
    skipped: preview.items.length - applicable.length,
    failed: 0,
    completed: 0,
    total: applicable.length,
    failures: [] as CatalogApplyFailure[],
  };
  for (const item of applicable) {
    let result: CatalogPersistResult;
    try {
      result = await persistYouTubeCatalogCandidate(item.candidate);
    } catch (error) {
      results.failed++;
      results.completed++;
      results.failures.push({
        videoId: item.candidate.video.videoId,
        title: item.normalizedTitle,
        message: error instanceof Error ? error.message : 'Unknown persistence error',
      });
      await onProgress?.({ ...results, failures: [...results.failures] });
      continue;
    }
    if (result === 'created') results.created++;
    else if (result === 'linked') results.linked++;
    else results.skipped++;
    results.completed++;
    await onProgress?.({ ...results, failures: [...results.failures] });
  }
  return results;
}
