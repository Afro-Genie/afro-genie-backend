import type { Job } from 'bullmq';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { estimateCostUsd } from '../services/aiProviders/geminiProvider';
import { logAICall, translateWithFallback } from '../services/translationService';
import { onAiTranslationCompleted } from '../services/rewardHooks';
import type { TranslationJobData } from '../types/translation';

export async function processTranslationJob(job: Job<TranslationJobData>): Promise<void> {
  const { songId, userId, sourceLang, targetLang, promptVersion } = job.data;
  const startTime = Date.now();

  const timings: Record<string, number> = {
    fetchingSongMs: 0,
    providerCallMs: 0,
    persistenceMs: 0,
  };

  logger.info({ jobId: job.id, songId, sourceLang, targetLang, attempt: job.attemptsMade }, 'Translation job started');

  // Report progress: fetching song data
  timings.fetchingSongMs = Date.now() - startTime;
  await job.updateProgress({ stage: 'fetching_song', percent: 10 });

  // Fetch song, artist name, and most recent lyrics in one query
  const songFetchEnd = Date.now();
  const song = await prisma.song.findUnique({
    where: { id: songId },
    include: {
      artist: { select: { name: true } },
      lyrics: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  if (!song) {
    throw new Error(`Song not found: ${songId}`);
  }

  timings.fetchingSongMs = songFetchEnd - startTime;
  const lyric = song.lyrics[0];
  if (!lyric || !lyric.content?.trim()) {
    const fallbackMessage = 'Lyrics are not available for this song yet.';

    await prisma.translation.upsert({
      where: {
        songId_userId_sourceLang_targetLang: { songId, userId, sourceLang, targetLang },
      },
      create: {
        songId,
        userId,
        originalLyrics: lyric?.content ?? '',
        translatedLyrics: '',
        culturalContext: fallbackMessage,
        sourceLang,
        targetLang,
        aiModel: null,
        promptVersion,
        status: 'APPROVED',
      },
      update: {
        originalLyrics: lyric?.content ?? '',
        translatedLyrics: '',
        culturalContext: fallbackMessage,
        aiModel: null,
        promptVersion,
        status: 'APPROVED',
        updatedAt: new Date(),
      },
    });

    logger.info(
      { jobId: job.id, songId, targetLang },
      'Translation job completed gracefully with empty lyrics',
    );

    return;
  }

  const lyricsLength = lyric.content.length;
  const estimatedTokens = Math.ceil(lyricsLength / 4);

  logger.info(
    { jobId: job.id, songId, lyricsLength, estimatedTokens },
    'Song lyrics loaded, proceeding with AI translation',
  );

  // Report progress: calling AI provider
  await job.updateProgress({ stage: 'translating', percent: 30 });

  let result;
  try {
    const translateStart = Date.now();
    result = await translateWithFallback({
      artist: song.artist.name,
      title: song.title,
      lyrics: lyric.content!,
      sourceLang,
      targetLang,
      promptVersion,
    });
    timings.providerCallMs = Date.now() - translateStart;
  } catch (translateError) {
    timings.providerCallMs = Date.now() - startTime;
    logger.error(
      { jobId: job.id, songId, targetLang, err: translateError },
      'Translation provider call failed',
    );
    throw translateError;
  }

  const elapsed = Date.now() - startTime;

  // Report progress: saving translation
  await job.updateProgress({ stage: 'saving', percent: 80 });

  // Upsert so retried jobs overwrite rather than violate the unique constraint
  // Auto-approve: translations are immediately available to all users
  await prisma.translation.upsert({
    where: {
      songId_userId_sourceLang_targetLang: { songId, userId, sourceLang, targetLang },
    },
    create: {
      songId,
      userId,
      originalLyrics: lyric.content!,
      translatedLyrics: result.result.translatedLyrics,
      culturalContext: result.result.culturalContext,
      sourceLang,
      targetLang,
      aiModel: result.result.model,
      promptVersion: result.result.promptVersion,
      status: 'APPROVED',
    },
    update: {
      translatedLyrics: result.result.translatedLyrics,
      culturalContext: result.result.culturalContext,
      aiModel: result.result.model,
      promptVersion: result.result.promptVersion,
      status: 'APPROVED',
      updatedAt: new Date(),
    },
  });

  timings.persistenceMs = Date.now() - startTime;

  await logAICall({
    provider: result.result.providerName,
    model: result.result.model,
    promptVersion: result.result.promptVersion,
    tokensInput: result.result.tokensInput,
    tokensOutput: result.result.tokensOutput,
    estimatedCostUsd: (await estimateCostUsd(result.result.tokensInput, result.result.tokensOutput)),
    songId,
    userId,
  });

  // Report progress: complete
  await job.updateProgress({ stage: 'completed', percent: 100 });

  // Reward the trigger only when the job actually generated real content
  // (idempotent per job id; never fires on the empty-lyrics fallback).
  await onAiTranslationCompleted({ jobId: String(job.id), userId });

  logger.info(
    {
      jobId: job.id,
      songId,
      targetLang,
      provider: result.result.providerName,
      model: result.result.model,
      tokensInput: result.result.tokensInput,
      tokensOutput: result.result.tokensOutput,
      tokensUsed: result.result.tokensUsed,
      costUsd: (await estimateCostUsd(result.result.tokensInput, result.result.tokensOutput)).toFixed(6),
      lyricsLength,
      elapsedMs: elapsed,
      ...timings,
    },
    'Translation job completed',
  );
}
