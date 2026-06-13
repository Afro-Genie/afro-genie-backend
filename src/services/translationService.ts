import type { Translation } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { translationQueue } from '../lib/queue';
import { CURRENT_PROMPT_VERSION, GeminiProvider } from './providers/geminiProvider';
import type { TranslationJobData, TranslationProvider } from '../types/translation';

// ---------------------------------------------------------------------------
// Provider registry — switching providers requires only changing the
// AI_TRANSLATION_PROVIDER environment variable, no code changes needed.
// ---------------------------------------------------------------------------
const PROVIDER_REGISTRY: Record<string, () => TranslationProvider> = {
  gemini: () => new GeminiProvider(),
};

let _activeProvider: TranslationProvider | null = null;

export function registerTranslationProvider(
  name: string,
  factory: () => TranslationProvider,
): void {
  PROVIDER_REGISTRY[name] = factory;
}

export function resetActiveProvider(): void {
  _activeProvider = null;
}

export function getActiveProvider(): TranslationProvider {
  if (_activeProvider) return _activeProvider;

  const name = process.env.AI_PROVIDER ?? process.env.AI_TRANSLATION_PROVIDER ?? 'gemini';
  const factory = PROVIDER_REGISTRY[name];

  if (!factory) {
    throw new Error(
      `Unknown AI translation provider: "${name}". Valid options: ${Object.keys(PROVIDER_REGISTRY).join(', ')}`,
    );
  }

  _activeProvider = factory();
  logger.info({ provider: name }, 'AI translation provider initialized');
  return _activeProvider;
}

// ---------------------------------------------------------------------------
// AICallLog persistence
// ---------------------------------------------------------------------------
export async function logAICall(params: {
  provider: string;
  model: string;
  promptVersion: string;
  tokensInput: number;
  tokensOutput: number;
  estimatedCostUsd: number;
  songId?: string | null;
  userId?: string | null;
}): Promise<void> {
  try {
    const prismaWithAiLog = prisma as unknown as {
      aICallLog?: { create: (args: { data: typeof params }) => Promise<unknown> };
      aiCallLog?: { create: (args: { data: typeof params }) => Promise<unknown> };
    };

    const delegate = prismaWithAiLog.aICallLog ?? prismaWithAiLog.aiCallLog;
    if (delegate) {
      await delegate.create({ data: params });
      return;
    }

    // Fallback for environments where Prisma Client has not been regenerated yet.
    const id = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO "AICallLog"
      ("id", "provider", "model", "promptVersion", "tokensInput", "tokensOutput", "estimatedCostUsd", "songId", "userId", "createdAt")
      VALUES
      (${id}, ${params.provider}, ${params.model}, ${params.promptVersion}, ${params.tokensInput}, ${params.tokensOutput}, ${params.estimatedCostUsd}, ${params.songId ?? null}, ${params.userId ?? null}, NOW())
    `;
  } catch (err) {
    // Non-fatal: a failed log must never break the translation flow
    logger.error({ err, ...params }, 'Failed to write AICallLog entry');
  }
}

// ---------------------------------------------------------------------------
// requestTranslation
// ---------------------------------------------------------------------------
export async function requestTranslation(params: {
  songId: string;
  userId: string;
  sourceLang: string;
  targetLang: string;
}): Promise<{ status: 'existing'; translation: Translation } | { status: 'queued'; jobId: string }> {
  const { songId, userId, sourceLang, targetLang } = params;

  // Return any already-approved translation for this song/lang pair
  const existing = await prisma.translation.findFirst({
    where: { songId, sourceLang, targetLang, status: 'APPROVED' },
  });

  if (existing) {
    return { status: 'existing', translation: existing };
  }

  // Verify the song exists before queuing
  const song = await prisma.song.findUnique({ where: { id: songId }, select: { id: true } });
  if (!song) {
    const err = new Error('Song not found') as Error & { code: string; httpStatus: number };
    err.code = 'NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }

  const jobData: TranslationJobData = {
    songId,
    userId,
    sourceLang,
    targetLang,
    promptVersion: CURRENT_PROMPT_VERSION,
  };

  const job = await translationQueue.add('translate', jobData, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 60 * 60 * 24 * 7 },   // retain 7 days
    removeOnFail: { age: 60 * 60 * 24 * 30 },       // retain failures 30 days
  });

  return { status: 'queued', jobId: job.id! };
}

// ---------------------------------------------------------------------------
// getTranslationsBySong — grouped by targetLang
// ---------------------------------------------------------------------------
export async function getTranslationsBySong(
  songId: string,
): Promise<Record<string, Translation[]>> {
  const translations = await prisma.translation.findMany({
    where: { songId },
    orderBy: { createdAt: 'desc' },
  });

  return translations.reduce<Record<string, Translation[]>>((acc, t) => {
    const key = t.targetLang;
    if (!acc[key]) acc[key] = [];
    acc[key].push(t);
    return acc;
  }, {});
}
