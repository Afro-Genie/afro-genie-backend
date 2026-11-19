import type { Job } from 'bullmq';
import type { LyricSourceProvider } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { languageCategorizationQueue, lyricsEnrichmentQueue, searchIndexQueue } from '../lib/queue';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { LrcLibProvider } from '../services/lyricsProviders/lrclibProvider';
import { cachedSearch, cachedFetchLyricsWithSync } from '../services/lyricsProviders/lyricsCache';
import type { LyricsProvider } from '../services/lyricsProviders/lyricsProvider';
import { findBestLyricsMatch, plainLyricsFromSyncedLyrics } from '../services/lyricsProviders/lyricsMatch';
import { logAICall } from '../services/translationService';
import { parseLrcTimestamps } from '../services/lyricsService';

interface LyricsEnrichmentJobData {
  songId: string;
}

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 500,
};

interface ProviderEntry {
  provider: LyricsProvider & {
    fetchLyricsWithSync(trackId: string): Promise<{ plain: string | null; synced: string | null }>;
  };
  providerLabel: LyricSourceProvider;
}

function buildProviderChain(songId: string): ProviderEntry[] {
  return [
    { provider: new LrcLibProvider(songId), providerLabel: 'LRCLIB' },
  ];
}

export type LyricsEnrichmentOutcome = 'populated' | 'miss' | 'already-populated' | 'not-found' | 'takedown';

async function tryProvider(
  entry: ProviderEntry,
  artistName: string,
  title: string,
  songId: string,
): Promise<{ content: string; provider: LyricSourceProvider; syncedLyrics?: string | null } | null> {
  const { provider, providerLabel } = entry;

  const results = await cachedSearch(provider, artistName, title);
  if (!results || results.length === 0) {
    logger.info({ songId, provider: providerLabel }, 'No search results from provider');
    return null;
  }

  const match = findBestLyricsMatch(results, artistName, title);
  if (!match) {
    logger.info({ songId, provider: providerLabel, resultCount: results.length }, 'No sufficiently matching lyrics result');
    return null;
  }

  const { plain, synced } = await cachedFetchLyricsWithSync(provider, match.trackId);
  const content = plain?.trim() || (synced ? plainLyricsFromSyncedLyrics(synced) : '');
  if (!content) {
    logger.info({ songId, provider: providerLabel }, 'Matching provider result has no usable lyrics content');
    return null;
  }

  return { content, provider: providerLabel, syncedLyrics: synced };
}

export async function enrichSongLyrics(songId: string): Promise<LyricsEnrichmentOutcome> {
  const song = await prisma.song.findUnique({
    where: { id: songId },
    include: {
      artist: { select: { name: true } },
      lyrics: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  if (!song) return 'not-found';
  const existingLyrics = song.lyrics[0];
  if (existingLyrics?.content?.trim()) return 'already-populated';
  if (existingLyrics?.licenseStatus === 'TAKEDOWN') return 'takedown';

  const start = Date.now();
  const providerChain = buildProviderChain(songId);

  for (const entry of providerChain) {
    const result = await tryProvider(entry, song.artist.name, song.title, songId);

    if (result) {
      const elapsedMs = Date.now() - start;
      logger.info(
        { songId, provider: result.provider, elapsedMs },
        'Lyrics fetched successfully',
      );

      const lyricLines = result.syncedLyrics ? parseLrcTimestamps(result.syncedLyrics) : null;
      const lyricData = {
        content: result.content,
        syncedLyrics: result.syncedLyrics ?? null,
        lyricLines: lyricLines
          ? (lyricLines as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
        sourceProvider: result.provider,
      };

      if (existingLyrics) {
        const updated = await prisma.lyric.updateMany({
          where: {
            songId,
            licenseStatus: { not: 'TAKEDOWN' },
            OR: [{ content: null }, { content: '' }],
          },
          data: lyricData,
        });
        if (updated.count === 0) {
          const current = await prisma.lyric.findUnique({ where: { songId }, select: { content: true } });
          if (current?.content?.trim()) return 'already-populated';
          return 'takedown';
        }
      } else {
        try {
          await prisma.lyric.create({
            data: { songId, ...lyricData, licenseStatus: 'UNKNOWN' },
          });
        } catch (error) {
          if (
            typeof error !== 'object'
            || error === null
            || !('code' in error)
            || error.code !== 'P2002'
          ) {
            throw error;
          }
          const current = await prisma.lyric.findUnique({ where: { songId }, select: { content: true, licenseStatus: true } });
          if (current?.content?.trim()) return 'already-populated';
          if (current?.licenseStatus === 'TAKEDOWN') return 'takedown';
          const updated = await prisma.lyric.updateMany({
            where: {
              songId,
              licenseStatus: { not: 'TAKEDOWN' },
              OR: [{ content: null }, { content: '' }],
            },
            data: lyricData,
          });
          if (updated.count === 0) return 'already-populated';
        }
      }

      try {
        await logAICall({
          provider: result.provider,
          model: 'api',
          promptVersion: 'v1',
          tokensInput: 0,
          tokensOutput: 0,
          estimatedCostUsd: 0,
          songId,
        });
      } catch (error) {
        logger.error({ err: error, songId }, 'Lyrics were saved but provider usage could not be recorded');
      }

      for (const [queue, name, message] of [
        [languageCategorizationQueue, 'categorize', 'Language categorization could not be queued after lyrics were saved'],
        [searchIndexQueue, 'indexSong', 'Search indexing could not be queued after lyrics were saved'],
      ] as const) {
        try {
          await queue.add(name, { songId });
        } catch (error) {
          logger.error({ err: error, songId }, message);
        }
      }
      return 'populated';
    }
  }

  logger.info({ songId, elapsedMs: Date.now() - start }, 'All lyrics providers exhausted');
  return 'miss';
}

export async function processLyricsEnrichmentJob(job: Job<LyricsEnrichmentJobData>): Promise<LyricsEnrichmentOutcome> {
  return enrichSongLyrics(job.data.songId);
}
