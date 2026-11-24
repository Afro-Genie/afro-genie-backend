import { randomUUID } from 'node:crypto';
import type { Translation } from '@prisma/client';
import { getRewardConfig } from '../config/rewards';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { translationQueue } from '../lib/queue';
import { ApiError } from '../middleware/errorHandler';
import { CURRENT_PROMPT_VERSION, GeminiProvider } from './aiProviders/geminiProvider';
import { spendTokens } from './tokenService';
import type { TranslationJobData, TranslationProvider, TranslationResult } from '../types/translation';

export interface TranslationTimings {
  /** Total request path duration (ms) */
  totalMs: number;
  /** Language detection duration (ms) */
  languageDetectionMs: number;
  /** Cache lookup duration (finding existing approved translation) (ms) */
  cacheLookupMs: number;
  /** Provider call duration across all attempts (ms) */
  providerCallMs: number;
  /** Chunking duration if lyrics split into multiple prompts (ms) */
  chunkingMs: number;
  /** Persistence duration (upsert to DB) (ms) */
  persistenceMs: number;
  /** Queue enqueue duration (ms) */
  enqueueMs: number;
}

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
// Provider list — Gemini only (no fallback providers configured)
// ---------------------------------------------------------------------------
function getProvidersWithFallback(): TranslationProvider[] {
  return [getActiveProvider()];
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
  const config = await getRewardConfig();
  const maxPerDay = Math.max(1, Number(config.AI_TRANSLATION_DAILY_CAP) || env.TRANSLATION_RATE_LIMIT_PER_DAY);

  let reserved = false;
  try {
    const count = await redis.incr(key);
    reserved = true;
    if (count === 1) {
      await redis.expire(key, RATE_LIMIT_TTL_SECONDS);
    }

    if (count > maxPerDay) {
      await redis.decr(key);
      reserved = false;
      const ttl = await redis.ttl(key);
      const resetAt = new Date(Date.now() + (ttl > 0 ? ttl : RATE_LIMIT_TTL_SECONDS) * 1000);
      return { allowed: false, remaining: 0, resetAt };
    }

    const ttl = await redis.ttl(key);
    const resetAt = new Date(Date.now() + (ttl > 0 ? ttl : RATE_LIMIT_TTL_SECONDS) * 1000);
    return { allowed: true, remaining: maxPerDay - count, resetAt };
  } catch (err) {
    if (reserved) await redis.decr(key).catch(() => 0);
    // The daily cap must not silently disappear when Redis is unavailable.
    logger.error({ err, userId }, 'Rate limit check failed, blocking translation request');
    return { allowed: false, remaining: 0, resetAt: new Date(Date.now() + RATE_LIMIT_TTL_SECONDS * 1000) };
  }
}

/** Release a reserved daily slot when the payment that reserved it fails. */
export async function releaseUserRateLimit(userId: string): Promise<void> {
  const key = `${RATE_LIMIT_PREFIX}${userId}`;
  try {
    await redis.decr(key);
  } catch (err) {
    logger.warn({ err, userId }, 'Could not release translation rate-limit slot');
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
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

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
    // The budget is a spending cap: an unreadable ledger must stop new AI work.
    logger.error({ err }, 'Budget check failed, blocking translation requests');
    return { withinBudget: false, spentTodayUsd: Number.POSITIVE_INFINITY, budgetUsd };
  }
}

export interface TranslationPayment {
  method: 'GT' | 'CREDIT';
  /** GT charged, or 0 when a prepaid translation credit was used. */
  gtCharged: number;
  /** Credits consumed, or 0 for a self-funded request. */
  creditsUsed: number;
}

/**
 * Charge for a translation at submission time.
 *
 * Self-funded requests cost the configured flat GT amount and are governed by
 * the per-user daily cap. A prepaid translation credit is consumed instead of
 * GT and bypasses that cap, but both paths still respect the global AI budget.
 */
export async function prepareTranslationPayment(params: {
  userId: string;
  songId: string;
  sourceLang: string;
  targetLang: string;
  requestId?: string;
}): Promise<TranslationPayment> {
  const { userId, songId, sourceLang, targetLang } = params;
  const requestId = params.requestId ?? randomUUID();
  const config = await getRewardConfig();
  const gtAmount = Math.max(0, Math.round(Number(config.AI_TRANSLATION_AMOUNT) || 0));

  const [user, budget] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { translationCredits: true },
    }),
    checkDailyBudget(),
  ]);

  if (!budget.withinBudget) {
    throw new ApiError(
      'AI translation is temporarily at capacity. Please try again later.',
      'BUDGET_EXCEEDED',
      429,
    );
  }

  if ((user?.translationCredits ?? 0) > 0) {
    const consumed = await prisma.user.updateMany({
      where: { id: userId, translationCredits: { gt: 0 } },
      data: { translationCredits: { decrement: 1 } },
    });
    if (consumed.count !== 1) {
      throw new ApiError('Translation credit is no longer available', 'CREDIT_UNAVAILABLE', 409);
    }

    logger.info({ userId, requestId, songId }, 'Translation credit consumed at request time');
    return { method: 'CREDIT', gtCharged: 0, creditsUsed: 1 };
  }

  const rateLimit = await checkUserRateLimit(userId);
  if (!rateLimit.allowed) {
    throw new ApiError(
      `Daily translation limit reached (${config.AI_TRANSLATION_DAILY_CAP} self-funded translations). Try again after ${rateLimit.resetAt.toISOString()}.`,
      'RATE_LIMITED',
      429,
    );
  }

  if (gtAmount > 0) {
    try {
      await spendTokens({
        userId,
        amount: -gtAmount,
        reason: 'AI translation generation',
        sourceType: 'AI_TRANSLATION',
        sourceId: requestId,
        idempotencyKey: `ai-translation:${requestId}`,
        metadata: { songId, sourceLang, targetLang },
      });
    } catch (err) {
      await releaseUserRateLimit(userId);
      throw err;
    }
  }

  logger.info({ userId, requestId, songId, gtAmount }, 'GT charged at translation request time');
  return { method: 'GT', gtCharged: gtAmount, creditsUsed: 0 };
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
}): Promise<{
  result: TranslationResultWithProvider;
  providerCallMs: number;
}> {
  const providers = getProvidersWithFallback();
  let lastError: unknown;
  let totalProviderCallMs = 0;

  logger.info(
    {
      providers: providers.map((p) => p.name),
      lyricsLength: params.lyrics.length,
      sourceLang: params.sourceLang,
      targetLang: params.targetLang,
    },
    'Starting translation with fallback chain',
  );

  for (const provider of providers) {
    const startTime = Date.now();
    try {
      const result: TranslationResult = await provider.translate(params);
      const elapsed = Date.now() - startTime;
      totalProviderCallMs += elapsed;
      logger.info(
        {
          provider: provider.name,
          elapsed,
          tokensUsed: result.tokensUsed,
          model: result.model,
        },
        'Translation provider succeeded',
      );
      return {
        result: {
          ...result,
          providerName: provider.name,
        },
        providerCallMs: totalProviderCallMs,
      };
    } catch (err) {
      const elapsed = Date.now() - startTime;
      totalProviderCallMs += elapsed;
      lastError = err;
      logger.warn(
        { provider: provider.name, elapsed, err },
        'Translation provider failed, trying fallback',
      );
    }
  }

  logger.error({ providers: providers.map((p) => p.name) }, 'All translation providers failed');
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
}): Promise<{
  status: 'existing' | 'queued' | 'completed';
  translation?: Translation;
  jobId?: string;
  timings: TranslationTimings;
  payment?: TranslationPayment;
}> {
  const { songId, userId, sourceLang, targetLang } = params;
  const requestStart = Date.now();

  // Initialize timings object
  const timings: TranslationTimings = {
    totalMs: 0,
    languageDetectionMs: 0,
    cacheLookupMs: 0,
    providerCallMs: 0,
    chunkingMs: 0,
    persistenceMs: 0,
    enqueueMs: 0,
  };

  // Return any already-approved translation for this song/lang pair
  // Cached/existing translations must not charge or reward as a new generation.
  const cacheStart = Date.now();
  const existing = await prisma.translation.findFirst({
    where: {
      songId,
      sourceLang,
      targetLang,
      status: 'APPROVED',
      translatedLyrics: { not: '' },
    },
  });
  timings.cacheLookupMs = Date.now() - cacheStart;

  if (existing?.translatedLyrics?.trim()) {
    timings.totalMs = Date.now() - requestStart;
    logger.info({ songId, sourceLang, targetLang, translationId: existing.id }, 'Returning existing approved translation');
    return { status: 'existing', translation: existing, timings };
  }

  // Verify the song exists before queuing
  const songCheckStart = Date.now();
  const song = await prisma.song.findUnique({ where: { id: songId }, select: { id: true } });
  if (!song) {
    const err = new Error('Song not found') as Error & { code: string; httpStatus: number };
    err.code = 'NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  timings.providerCallMs = Date.now() - songCheckStart; // reuse field for song lookup

  // Charge at submission (GT or one prepaid credit) before enqueuing work.
  const payment = await prepareTranslationPayment({ userId, songId, sourceLang, targetLang });

  const jobData: TranslationJobData = {
    songId,
    userId,
    sourceLang,
    targetLang,
    promptVersion: CURRENT_PROMPT_VERSION,
  };

  const enqueueStart = Date.now();
  const job = await translationQueue.add('translate', jobData, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 60 * 60 * 24 * 7 },   // retain 7 days
    removeOnFail: { age: 60 * 60 * 24 * 30 },       // retain failures 30 days
  });
  timings.enqueueMs = Date.now() - enqueueStart;

  logger.info({ jobId: job.id, songId, userId, sourceLang, targetLang }, 'Translation job enqueued');

  return { status: 'queued', jobId: job.id!, timings, payment };
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
