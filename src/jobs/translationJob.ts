import type { Job } from 'bullmq';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { estimateCostUsd } from '../services/providers/geminiProvider';
import { getActiveProvider, logAICall } from '../services/translationService';
import type { TranslationJobData } from '../types/translation';

export async function processTranslationJob(job: Job<TranslationJobData>): Promise<void> {
  const { songId, userId, sourceLang, targetLang, promptVersion } = job.data;

  logger.info({ jobId: job.id, songId, targetLang, attempt: job.attemptsMade }, 'Translation job started');

  // Fetch song, artist name, and most recent lyrics in one query
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
        status: 'PENDING',
      },
      update: {
        originalLyrics: lyric?.content ?? '',
        translatedLyrics: '',
        culturalContext: fallbackMessage,
        aiModel: null,
        promptVersion,
        updatedAt: new Date(),
      },
    });

    logger.info(
      { jobId: job.id, songId, targetLang },
      'Translation job completed gracefully with empty lyrics',
    );

    return;
  }

  const provider = getActiveProvider();

  const result = await provider.translate({
    artist: song.artist.name,
    title: song.title,
    lyrics: lyric.content!,
    sourceLang,
    targetLang,
    promptVersion,
  });

  const estimatedCostUsd = estimateCostUsd(result.tokensInput, result.tokensOutput);

  // Upsert so retried jobs overwrite rather than violate the unique constraint
  await prisma.translation.upsert({
    where: {
      songId_userId_sourceLang_targetLang: { songId, userId, sourceLang, targetLang },
    },
    create: {
      songId,
      userId,
      originalLyrics: lyric.content!,
      translatedLyrics: result.translatedLyrics,
      culturalContext: result.culturalContext,
      sourceLang,
      targetLang,
      aiModel: result.model,
      promptVersion: result.promptVersion,
      status: 'PENDING',
    },
    update: {
      translatedLyrics: result.translatedLyrics,
      culturalContext: result.culturalContext,
      aiModel: result.model,
      promptVersion: result.promptVersion,
      updatedAt: new Date(),
    },
  });

  await logAICall({
    provider: provider.name,
    model: result.model,
    promptVersion: result.promptVersion,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    estimatedCostUsd,
    songId,
    userId,
  });

  logger.info(
    {
      jobId: job.id,
      songId,
      targetLang,
      tokensUsed: result.tokensUsed,
      costUsd: estimatedCostUsd.toFixed(6),
    },
    'Translation job completed',
  );
}
