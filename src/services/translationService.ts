import type { Translation } from '@prisma/client';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { translationQueue } from '../lib/queue';
import { CURRENT_PROMPT_VERSION, GeminiProvider } from './providers/geminiProvider';
import { OpenAIProvider, estimateOpenAICostUsd } from './providers/openaiProvider';
import type { TranslationJobData, TranslationProvider } from '../types/translation';

// ---------------------------------------------------------------------------
// Provider registry — switching providers requires only changing the
// AI_TRANSLATION_PROVIDER environment variable, no code changes needed.
// ---------------------------------------------------------------------------
const PROVIDER_REGISTRY: Record<string, () => TranslationProvider> = {
  gemini: () => new GeminiProvider(),
};

// Register OpenAI only if the API key is present
if (env.OPENAI_API_KEY) {
  PROVIDER_REGISTRY.openai = () => new OpenAIProvider();
}

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
// Provider fallback — try the primary, fall back to secondary if available
// ---------------------------------------------------------------------------
function getProvidersWithFallback(): TranslationProvider[] {
  const primary = getActiveProvider();
  const fallbackName = primary.name === 'gemini' ? 'openai' : 'gemini';
  const fallbackFactory = PROVIDER_REGISTRY[fallbackName];

  if (!fallbackFactory) {
    return [primary];
  }

  try {
    const fallback = fallbackFactory();
    return [primary, fallback];
  } catch {
    // Fallback provider may fail to initialize (e.g. missing API key)
    return [primary];
  }
}

// ---------------------------------------------------------------------------
// Per-user daily rate limiting via Redis
// ---------------------------------------------------------------------------
const RATE_LIMIT_PREFIX = 'translation:rate:';
const RATE_LIMIT_TTL_SECONDS = 86400; // 24 hours

export async function checkUserRateLimit(userId: string): Promise<{
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}> {
  const key = `${RATE_LIMIT_PREFIX}${userId}`;
  const maxPerDay = env.TRANSLATION_RATE_LIMIT_PER_DAY;

  try {
    const current = await redis.get(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= maxPerDay) {
      const ttl = await redis.ttl(key);
      const resetAt = new Date(Date.now() + (ttl > 0 ? ttl : RATE_LIMIT_TTL_SECONDS) * 1000);
      return { allowed: false, remaining: 0, resetAt };
    }

    // Increment counter — first call sets TTL
    if (current === null) {
      await redis.set(key, '1', 'EX', RATE_LIMIT_TTL_SECONDS);
    } else {
      await redis.incr(key);
    }

    const remaining = maxPerDay - (count + 1);
    const ttl = await redis.ttl(key);
    const resetAt = new Date(Date.now() + (ttl > 0 ? ttl : RATE_LIMIT_TTL_SECONDS) * 1000);
    return { allowed: true, remaining, resetAt };
  } catch (err) {
    // If Redis is unavailable, allow the request (fail-open for rate limiting)
    logger.warn({ err, userId }, 'Rate limit check failed, allowing request');
    return { allowed: true, remaining: maxPerDay, resetAt: new Date(Date.now() + 86400_000) };
  }
}

// ---------------------------------------------------------------------------
// Daily budget control — check total AI spend for today before enqueuing
// ---------------------------------------------------------------------------
export async function checkDailyBudget(): Promise<{
  withinBudget: boolean;
  spentTodayUsd: number;
  budgetUsd: number;
}> {
  const budgetUsd = env.TRANSLATION_DAILY_BUDGET_USD;

  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const result = await prisma.aICallLog.aggregate({
      where: { createdAt: { gte: startOfDay } },
      _sum: { estimatedCostUsd: true },
    });

    const spentTodayUsd = result._sum.estimatedCostUsd ?? 0;

    return {
      withinBudget: spentTodayUsd < budgetUsd,
      spentTodayUsd,
      budgetUsd,
    };
  } catch (err) {
    // If the query fails, allow the request (fail-open for budget check)
    logger.warn({ err }, 'Budget check failed, allowing request');
    return { withinBudget: true, spentTodayUsd: 0, budgetUsd };
  }
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
    await prisma.aICallLog.create({ data: params });
  } catch (err) {
    // Non-fatal: a failed log must never break the translation flow
    logger.error({ err, ...params }, 'Failed to write AICallLog entry');
  }
}

// ---------------------------------------------------------------------------
// Provider translate with fallback
// ---------------------------------------------------------------------------
export interface TranslationResultWithProvider {
  translatedLyrics: string;
  culturalContext?: string;
  tokensInput: number;
  tokensOutput: number;
  tokensUsed: number;
  model: string;
  promptVersion: string;
  providerName: string;
}

export async function translateWithFallback(params: {
  artist: string;
  title: string;
  lyrics: string;
  sourceLang: string;
  targetLang: string;
  promptVersion: string;
}): Promise<TranslationResultWithProvider> {
  const providers = getProvidersWithFallback();
  let lastError: unknown;

  for (const provider of providers) {
    try {
      const result = await provider.translate(params);
      return { ...result, providerName: provider.name };
    } catch (err) {
      lastError = err;
      logger.warn(
        { provider: provider.name, err },
        'Translation provider failed, trying fallback',
      );
    }
  }

  throw lastError;
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
