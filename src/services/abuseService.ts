import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

// ---------------------------------------------------------------------------
// Abuse detection service (Phase 5 / 6.2).
//
// Detection queries are shared by the hourly abuseDetectionJob (which persists
// AbuseFlag rows) and the live admin economy abuse dashboard. Every flag is
// idempotent per (userId, rule) so a re-run never duplicates rows.
// ---------------------------------------------------------------------------

export const ABUSE_RULES = {
  LOW_QUALITY_TRANSLATION: 'LOW_QUALITY_TRANSLATION',
  ABNORMAL_EARN_RATE: 'ABNORMAL_EARN_RATE',
  SHARED_IP_REFERRALS: 'SHARED_IP_REFERRALS',
  RAPID_FIRE_CORRECTIONS: 'RAPID_FIRE_CORRECTIONS',
  SELF_REFERRAL: 'SELF_REFERRAL',
} as const;

export type AbuseSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export const LOW_QUALITY_TRANSLATION_THRESHOLD = 3;
export const LOW_QUALITY_TRANSLATION_MIN_CHARS = 10;
export const ABNORMAL_EARN_RATE_DAILY_GT = 500;
export const RAPID_FIRE_CORRECTIONS_PER_HOUR = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

interface RawDetectionRow {
  userId: string;
  count?: number;
  earned?: number;
  targetIds?: string[];
}

// ---------------------------------------------------------------------------
// Detection queries (live)
// ---------------------------------------------------------------------------

/** Users with >= 3 translations whose body is under 10 characters. */
export async function detectLowQualityTranslations(): Promise<RawDetectionRow[]> {
  return prisma.$queryRaw<RawDetectionRow[]>`
    SELECT "userId", COUNT(*)::int AS "count"
    FROM "Translation"
    WHERE LENGTH("translatedLyrics") < ${LOW_QUALITY_TRANSLATION_MIN_CHARS}
    GROUP BY "userId"
    HAVING COUNT(*) >= ${LOW_QUALITY_TRANSLATION_THRESHOLD}
  `;
}

/**
 * Users who earned > 500 GT in the last 24h from non-purchase sources.
 * GT bundle top-ups credit with sourceType 'GT_PURCHASE' and are excluded.
 */
export async function detectAbnormalEarnRate(): Promise<RawDetectionRow[]> {
  return prisma.$queryRaw<RawDetectionRow[]>`
    SELECT "userId", SUM("amount")::int AS "earned"
    FROM "TokenLedger"
    WHERE "type" = 'EARN'
      AND "createdAt" >= now() - interval '24 hours'
      AND ("sourceType" IS DISTINCT FROM 'GT_PURCHASE')
      AND ("sourceType" IS NULL OR "sourceType" <> 'ADMIN_ADJUST')
    GROUP BY "userId"
    HAVING SUM("amount") > ${ABNORMAL_EARN_RATE_DAILY_GT}
  `;
}

/** Users flagging >10 corrections in the previous hour. */
export async function detectRapidFireCorrections(): Promise<RawDetectionRow[]> {
  return prisma.$queryRaw<RawDetectionRow[]>`
    SELECT "userId", COUNT(*)::int AS "count"
    FROM "TranslationCorrection"
    WHERE "createdAt" >= now() - interval '1 hour'
    GROUP BY "userId"
    HAVING COUNT(*) > ${RAPID_FIRE_CORRECTIONS_PER_HOUR}
  `;
}

/**
 * Mutual referral pairs: A refers B and B refers A. The commission must be
 * blocked for these accounts.
 */
export async function detectSelfReferrals(): Promise<RawDetectionRow[]> {
  const rows = await prisma.$queryRaw<Array<{ a: string; b: string }>>`
    SELECT r1."referrerId" AS "a", r1."referredUserId" AS "b"
    FROM "Referral" r1
    JOIN "Referral" r2
      ON r1."referrerId" = r2."referredUserId"
     AND r1."referredUserId" = r2."referrerId"
  `;

  const byUser = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!byUser.has(row.a)) byUser.set(row.a, new Set());
    byUser.get(row.a)!.add(row.b);
    if (!byUser.has(row.b)) byUser.set(row.b, new Set());
    byUser.get(row.b)!.add(row.a);
  }

  return [...byUser.entries()].map(([userId, partners]) => ({
    userId,
    targetIds: [...partners],
  }));
}

/**
 * Multiple accounts earning referral bonuses from the same IP on the same
 * day (referral farming). Requires Referral.ip to be captured at apply time.
 */
export async function detectSharedIpReferrals(): Promise<RawDetectionRow[]> {
  const rows = await prisma.$queryRaw<Array<{ userId: string; ip: string }>>`
    WITH earners AS (
      SELECT DISTINCT "referredUserId" AS "userId", "ip"
      FROM "Referral"
      WHERE "ip" IS NOT NULL AND "ip" <> ''
        AND "createdAt" >= now() - interval '24 hours'
    ),
    sharing AS (
      SELECT "ip", COUNT(*)::int AS "users"
      FROM earners
      GROUP BY "ip"
      HAVING COUNT(*) >= 2
    )
    SELECT e."userId", e."ip"
    FROM earners e
    JOIN sharing s USING ("ip")
  `;

  const byUser = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!byUser.has(row.userId)) byUser.set(row.userId, new Set());
    byUser.get(row.userId)!.add(row.ip);
  }

  return [...byUser.entries()].map(([userId, ips]) => ({ userId, targetIds: [...ips] }));
}

// ---------------------------------------------------------------------------
// Flag persistence (idempotent per userId + rule)
// ---------------------------------------------------------------------------

export interface AbuseDetectionInput {
  userId: string;
  rule: string;
  severity: AbuseSeverity;
  reason: string;
  metadata?: Record<string, unknown>;
}

/**
 * Upsert a detection flag. Re-pauses rewards only on a fresh HIGH detection or
 * when the previous flag was never reviewed by an admin; a reviewed + unpaused
 * flag is left alone so the hourly job can't override an admin decision.
 */
export async function recordAbuseDetection(input: AbuseDetectionInput): Promise<void> {
  const existing = await prisma.abuseFlag.findUnique({
    where: { userId_rule: { userId: input.userId, rule: input.rule } },
    select: { id: true, reviewed: true, pausedRewards: true },
  });

  const shouldPause = input.severity === 'HIGH' && (!existing || !existing.reviewed);

  try {
    await prisma.abuseFlag.upsert({
      where: { userId_rule: { userId: input.userId, rule: input.rule } },
      update: {
        severity: input.severity,
        reason: input.reason,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
        reviewed: false,
        reviewedById: null,
        reviewedAt: null,
        ...(shouldPause && !existing?.pausedRewards ? { pausedRewards: true } : {}),
      },
      create: {
        userId: input.userId,
        rule: input.rule,
        severity: input.severity,
        reason: input.reason,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
        pausedRewards: input.severity === 'HIGH',
      },
    });
  } catch (err) {
    logger.warn({ err, userId: input.userId, rule: input.rule }, 'Failed to record abuse detection flag');
  }
}

/** Rewards are auto-paused while a HIGH-severity flag is un-resolved. */
export async function isRewardPaused(userId: string): Promise<boolean> {
  const flag = await prisma.abuseFlag.findFirst({
    where: { userId, pausedRewards: true },
    select: { id: true },
  });
  return Boolean(flag);
}

export interface AbuseFlagsFilter {
  includeReviewed?: boolean;
  rule?: string;
  page?: number;
  limit?: number;
}

export async function listAbuseFlags(filter: AbuseFlagsFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const limit = Math.min(100, Math.max(1, filter.limit ?? 20));

  const where: Prisma.AbuseFlagWhereInput = {
    ...(filter.includeReviewed ? {} : { reviewed: false }),
    ...(filter.rule ? { rule: filter.rule } : {}),
  };

  const [flags, total] = await Promise.all([
    prisma.abuseFlag.findMany({
      where,
      orderBy: [{ pausedRewards: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: { select: { id: true, displayName: true, email: true, photoUrl: true } },
      },
    }),
    prisma.abuseFlag.count({ where }),
  ]);

  return {
    data: flags,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export interface AbuseFlagReviewInput {
  reviewed?: boolean;
  pausedRewards?: boolean;
}

/** Admin review: resolve the flag and/or resume (pausedRewards=false). */
export async function reviewAbuseFlag(
  flagId: string,
  adminId: string,
  input: AbuseFlagReviewInput,
) {
  const existing = await prisma.abuseFlag.findUnique({ where: { id: flagId } });
  if (!existing) {
    return null;
  }

  const data: Prisma.AbuseFlagUpdateInput = {};
  if (input.reviewed !== undefined) {
    data.reviewed = input.reviewed;
    data.reviewedById = input.reviewed ? adminId : null;
    data.reviewedAt = input.reviewed ? new Date() : null;
  }
  if (input.pausedRewards !== undefined) {
    data.pausedRewards = input.pausedRewards;
  }

  return prisma.abuseFlag.update({ where: { id: flagId }, data });
}

// ---------------------------------------------------------------------------
// Live dashboard aggregates
// ---------------------------------------------------------------------------

interface EarnStats {
  userId: string;
  earned: number;
}

/** Per-user non-purchase earnings over the last 30 days. */
export async function getNonPurchaseEarnings(days = 30): Promise<EarnStats[]> {
  return prisma.$queryRaw<EarnStats[]>`
    SELECT "userId", SUM("amount")::int AS "earned"
    FROM "TokenLedger"
    WHERE "type" = 'EARN'
      AND "createdAt" >= now() - (${days} * interval '1 day')
      AND ("sourceType" IS DISTINCT FROM 'GT_PURCHASE')
    GROUP BY "userId"
  `;
}

/**
 * Live abuse read-model for GET /api/admin/economy/abuse: earnings that sit
 * > 3σ above the mean, plus the current detection surfaces and open flags.
 */
export async function getAbuseDashboard() {
  const [totals, lowQuality, rapidFire, selfReferrals, sharedIp, flags] = await Promise.all([
    getNonPurchaseEarnings(),
    detectLowQualityTranslations(),
    detectRapidFireCorrections(),
    detectSelfReferrals(),
    detectSharedIpReferrals(),
    listAbuseFlags({ limit: 100 }),
  ]);

  const values = totals.map((t) => t.earned);
  const mean = values.length
    ? values.reduce((sum, v) => sum + v, 0) / values.length
    : 0;
  const variance = values.length
    ? values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length
    : 0;
  const stddev = Math.sqrt(variance);
  const cutoff = mean + 3 * stddev;

  const abnormal = totals
    .filter((t) => cutoff > 0 && t.earned > cutoff)
    .sort((a, b) => b.earned - a.earned)
    .slice(0, 100);

  return {
    threshold: {
      mean: Math.round(mean * 100) / 100,
      stddev: Math.round(stddev * 100) / 100,
      cutoff: Math.round(cutoff * 100) / 100,
      rule: 'EARN_RATE_3_SIGMA',
    },
    abnormalEarners: abnormal,
    lowQualityTranslations: lowQuality,
    rapidFireCorrections: rapidFire,
    selfReferrals,
    sharedIpReferrals: sharedIp,
    flaggedAccounts: flags,
  };
}

export { DAY_MS };