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
    SELECT t."userId", COUNT(*)::int AS "count"
    FROM "Translation" t
    ${Prisma.raw('JOIN "User" u ON u."id" = t."userId" AND u."isTestAccount" = false')}
    WHERE LENGTH(t."translatedLyrics") < ${LOW_QUALITY_TRANSLATION_MIN_CHARS}
    GROUP BY t."userId"
    HAVING COUNT(*) >= ${LOW_QUALITY_TRANSLATION_THRESHOLD}
  `;
}

/**
 * Users who earned > 500 GT in the last 24h from non-purchase sources.
 *
 * GT bundle top-ups are the load-bearing exclusion: they credit with
 * `type: 'EARN'` AND `sourceType: 'GT_PURCHASE'` (see paymentService.ts), so
 * without the sourceType check every paying user would trip this detector.
 *
 * The two ADMIN_* sourceType exclusions are defence in depth, not load-bearing:
 * admin grants are written with `type: 'ADMIN_ADJUST'` (economy.ts ->
 * adjustTokens), so the `type = 'EARN'` filter already removes them. `type` and
 * `sourceType` are independent columns, so the check is kept to stay correct if
 * an admin path is ever changed to credit an EARN row.
 *
 * NULL-PROVENANCE HANDLING. Rows with a NULL `sourceType` must be KEPT: a NULL
 * means "we do not know where this grant came from", which is exactly the case
 * worth an admin's attention. `NOT IN ('GT_PURCHASE','ADMIN_ADJUST')` yields
 * NULL — i.e. "not matched" — for a NULL left operand and would silently drop
 * every one of them, which is why it is not used here. Pairwise
 * `IS DISTINCT FROM` is the NULL-safe form: NULL IS DISTINCT FROM 'x' is TRUE.
 *
 * The previous spelling, `sourceType IS DISTINCT FROM ALL (ARRAY[...])`, is not
 * valid PostgreSQL — `IS DISTINCT FROM` takes a single operand and has no array
 * `ALL` form. Every execution of this query failed with
 * `42601 syntax error at or near "ALL"`, so this detector has never reported a
 * single row. Found while verifying the Stage 6.2 join; see REMEDIATION-RESULTS.md
 * §6.R4. (Note this also means the plan's step 2.5 — "simplify to NOT IN" —
 * would have "fixed" the syntax while reintroducing the NULL-dropping bug the
 * original author was explicitly avoiding.)
 */
export async function detectAbnormalEarnRate(): Promise<RawDetectionRow[]> {
  return prisma.$queryRaw<RawDetectionRow[]>`
    SELECT t."userId", SUM(t."amount")::int AS "earned"
    FROM "TokenLedger" t
    ${Prisma.raw(NON_TEST_ACCOUNTS_LEDGER)}
    WHERE t."type" = 'EARN'
      AND t."createdAt" >= now() - interval '24 hours'
      AND t."sourceType" IS DISTINCT FROM 'GT_PURCHASE'
      AND t."sourceType" IS DISTINCT FROM 'ADMIN_ADJUST'
      AND t."sourceType" IS DISTINCT FROM 'ADMIN_ECONOMY_ADJUST'
    GROUP BY t."userId"
    HAVING SUM(t."amount") > ${ABNORMAL_EARN_RATE_DAILY_GT}
  `;
}

/** Users flagging >10 corrections in the previous hour. */
export async function detectRapidFireCorrections(): Promise<RawDetectionRow[]> {
  return prisma.$queryRaw<RawDetectionRow[]>`
    SELECT t."userId", COUNT(*)::int AS "count"
    FROM "TranslationCorrection" t
    ${Prisma.raw('JOIN "User" u ON u."id" = t."userId" AND u."isTestAccount" = false')}
    WHERE t."createdAt" >= now() - interval '1 hour'
    GROUP BY t."userId"
    HAVING COUNT(*) > ${RAPID_FIRE_CORRECTIONS_PER_HOUR}
  `;
}

/**
 * Mutual referral pairs: A refers B and B refers A. The commission must be
 * blocked for these accounts.
 */
export async function detectSelfReferrals(): Promise<RawDetectionRow[]> {
  // Stage 6.2 — an archived test account in a referral pair is not fraud, it is
  // fixture noise, and flagging it costs an admin a manual review. Both sides
  // of the pair must be eligible for the pair to be reported.
  const rows = await prisma.$queryRaw<Array<{ a: string; b: string }>>`
    SELECT r1."referrerId" AS "a", r1."referredUserId" AS "b"
    FROM "Referral" r1
    JOIN "Referral" r2
      ON r1."referrerId" = r2."referredUserId"
     AND r1."referredUserId" = r2."referrerId"
    ${Prisma.raw(
      'JOIN "User" u1 ON u1."id" = r1."referrerId" AND u1."isTestAccount" = false',
    )}
    ${Prisma.raw(
      'JOIN "User" u2 ON u2."id" = r1."referredUserId" AND u2."isTestAccount" = false',
    )}
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
      SELECT DISTINCT r."referredUserId" AS "userId", r."ip"
      FROM "Referral" r
      ${Prisma.raw('JOIN "User" u ON u."id" = r."referredUserId" AND u."isTestAccount" = false')}
      WHERE r."ip" IS NOT NULL AND r."ip" <> ''
        AND r."createdAt" >= now() - interval '24 hours'
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
 *
 * The review triad (`reviewed` / `reviewedById` / `reviewedAt`) is the admin's
 * decision and is NEVER cleared by re-detection. The sweep runs hourly, so a
 * blanket reset silently re-opened every case an admin had closed, destroyed the
 * audit trail (`reviewedById`/`reviewedAt` -> null) and re-queued the flag on the
 * pending-review dashboard — the admin's work was undone hourly, forever.
 * Re-detection still refreshes `severity` / `reason` / `metadata`, so an open
 * flag reflects the latest evidence while a closed one stays closed.
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
        // Preserve an admin's review; only an unreviewed flag is (re-)armed.
        ...(existing?.reviewed
          ? {}
          : { reviewed: false, reviewedById: null, reviewedAt: null }),
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
    SELECT t."userId", SUM(t."amount")::int AS "earned"
    FROM "TokenLedger" t
    ${Prisma.raw(NON_TEST_ACCOUNTS_LEDGER)}
    WHERE t."type" = 'EARN'
      AND t."createdAt" >= now() - (${days} * interval '1 day')
      AND (t."sourceType" IS DISTINCT FROM 'GT_PURCHASE')
    GROUP BY t."userId"
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

/**
 * Stage 6.2 — exclude archived test accounts from economy statistics.
 *
 * `JOIN "User" ON ... AND u."isTestAccount" = false` on every aggregation. This
 * is the harm §3.5 names explicitly: a test account's grant moves the mean and
 * the standard deviation of `getNonPurchaseEarnings()`, which is exactly the
 * input to the 3σ cutoff that decides who an admin is shown as "abnormal". A
 * single large test grant can drag the cutoff far enough up to hide a genuine
 * abuser, or far enough down to flag real users.
 *
 * Written as a raw join rather than a subquery on userId so the exclusion is
 * applied before aggregation, not after. The dashboard reads a computed
 * threshold, so there is no later stage at which to correct it.
 *
 * The alias `t` is the TokenLedger alias used by every query that embeds this.
 */
const NON_TEST_ACCOUNTS_LEDGER = 'JOIN "User" u ON u."id" = t."userId" AND u."isTestAccount" = false';