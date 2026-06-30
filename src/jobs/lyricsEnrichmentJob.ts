import type { Job } from 'bullmq';
import { languageCategorizationQueue, lyricsEnrichmentQueue, searchIndexQueue } from '../lib/queue';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { MusicMatchProvider, MusicMatchRateLimitError } from '../services/lyricsProviders/musicMatchProvider';
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

  const provider = new MusicMatchProvider(songId);
  const start = Date.now();
  let content: string | null = null;

  try {
    const results = await provider.search(song.artist.name, song.title);
    if (results?.length) {
      content = await provider.fetchLyrics(results[0].trackId);
    }
  } catch (e) {
    if (e instanceof MusicMatchRateLimitError) {
      await lyricsEnrichmentQueue.add(
        'enrichLyrics',
        { songId },
        {
          ...DEFAULT_JOB_OPTIONS,
          delay: e.retryAfterMs,
          jobId: `lyrics-enrichment-${songId}`,
        },
      );

      logger.warn(
        { songId, retryAfterMs: e.retryAfterMs, elapsedMs: Date.now() - start },
        'MusicMatch limit reached, rescheduled enrichment job',
      );
      return;
    }

    logger.error({ e, songId }, 'MusicMatch failed');
  }

  await logAICall({
    provider: 'MUSICMATCH',
    model: 'api',
    promptVersion: 'v1',
    tokensInput: 0,
    tokensOutput: 0,
    estimatedCostUsd: 0,
    songId,
  });

  if (content) {
    await prisma.lyric.create({
      data: {
        songId,
        content,
        sourceProvider: 'MUSICMATCH',
        licenseStatus: 'LICENSED',
      },
    });

    await languageCategorizationQueue.add('categorize', { songId });
    await searchIndexQueue.add('indexSong', { songId });
    return;
  }

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
}
