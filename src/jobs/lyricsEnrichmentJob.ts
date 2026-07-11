import type { Job } from 'bullmq';
import type { LyricSourceProvider } from '@prisma/client';
import { languageCategorizationQueue, lyricsEnrichmentQueue, searchIndexQueue } from '../lib/queue';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { MusicMatchProvider, MusicMatchRateLimitError } from '../services/lyricsProviders/musicMatchProvider';
import { LyricFindProvider } from '../services/lyricsProviders/lyricFindProvider';
import { GeniusProvider } from '../services/lyricsProviders/geniusProvider';
import { cachedSearch, cachedFetchLyrics } from '../services/lyricsProviders/lyricsCache';
import type { LyricsProvider } from '../services/lyricsProviders/lyricsProvider';
import { logAICall } from '../services/translationService';

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
  provider: LyricsProvider;
  providerLabel: LyricSourceProvider;
}

function buildProviderChain(songId: string): ProviderEntry[] {
  return [
    { provider: new MusicMatchProvider(songId), providerLabel: 'MUSICMATCH' },
    { provider: new LyricFindProvider(songId), providerLabel: 'LYRICFIND' },
    { provider: new GeniusProvider(songId), providerLabel: 'GENIUS' },
  ];
}

async function tryProvider(
  entry: ProviderEntry,
  artistName: string,
  title: string,
  songId: string,
): Promise<{ content: string; provider: LyricSourceProvider } | null> {
  const { provider, providerLabel } = entry;

  try {
    const results = await cachedSearch(provider, artistName, title);
    if (!results || results.length === 0) {
      logger.info({ songId, provider: providerLabel }, 'No search results from provider');
      return null;
    }

    const content = await cachedFetchLyrics(provider, results[0].trackId);
    if (!content) {
      logger.info({ songId, provider: providerLabel }, 'No lyrics content from provider');
      return null;
    }

    return { content, provider: providerLabel };
  } catch (error) {
    // Re-throw rate limit errors so the caller can reschedule
    if (error instanceof MusicMatchRateLimitError) {
      throw error;
    }

    logger.warn(
      { err: error, songId, provider: providerLabel },
      'Provider failed during enrichment',
    );
    return null;
  }
}

export async function processLyricsEnrichmentJob(job: Job<LyricsEnrichmentJobData>): Promise<void> {
  const { songId } = job.data;

  const song = await prisma.song.findUnique({
    where: { id: songId },
    include: {
      artist: { select: { name: true } },
      lyrics: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  if (!song || song.lyrics[0]?.content) {
    return;
  }

  const start = Date.now();
  const providerChain = buildProviderChain(songId);

  try {
    for (const entry of providerChain) {
      const result = await tryProvider(entry, song.artist.name, song.title, songId);

      if (result) {
        const elapsedMs = Date.now() - start;
        logger.info(
          { songId, provider: result.provider, elapsedMs },
          'Lyrics fetched successfully',
        );

        await prisma.lyric.create({
          data: {
            songId,
            content: result.content,
            sourceProvider: result.provider,
            licenseStatus: 'LICENSED',
          },
        });

        await logAICall({
          provider: result.provider,
          model: 'api',
          promptVersion: 'v1',
          tokensInput: 0,
          tokensOutput: 0,
          estimatedCostUsd: 0,
          songId,
        });

        await languageCategorizationQueue.add('categorize', { songId });
        await searchIndexQueue.add('indexSong', { songId });
        return;
      }
    }
  } catch (error) {
    if (error instanceof MusicMatchRateLimitError) {
      await lyricsEnrichmentQueue.add(
        'enrichLyrics',
        { songId },
        {
          ...DEFAULT_JOB_OPTIONS,
          delay: error.retryAfterMs,
          jobId: `lyrics-enrichment-${songId}`,
        },
      );

      logger.warn(
        { songId, retryAfterMs: error.retryAfterMs, elapsedMs: Date.now() - start },
        'MusicMatch limit reached, rescheduled enrichment job',
      );
      return;
    }

    logger.error({ err: error, songId }, 'Unexpected error during lyrics enrichment');
  }

  // All providers exhausted — create empty lyric record
  const existing = await prisma.lyric.findFirst({ where: { songId } });
  if (!existing) {
    await prisma.lyric.create({
      data: {
        songId,
        content: null,
        sourceProvider: 'MANUAL',
        licenseStatus: 'UNKNOWN',
      },
    });
  }

  logger.info({ songId, elapsedMs: Date.now() - start }, 'All lyrics providers exhausted');
}
