import type { RepeatOptions } from 'bullmq';
import { reconciliationQueue } from '../lib/queue';
import { logger } from '../lib/logger';
import {
  ABUSE_RULES,
  detectAbnormalEarnRate,
  detectLowQualityTranslations,
  detectRapidFireCorrections,
  detectSelfReferrals,
  detectSharedIpReferrals,
  recordAbuseDetection,
} from '../services/abuseService';

// ---------------------------------------------------------------------------
// Abuse detection job (Phase 5 / 6.2).
//
// Runs hourly on the reconciliation queue (reused — no extra worker). Detects
// reward farming / referral abuse patterns and persists idempotent AbuseFlag
// rows. HIGH-severity flags auto-pause reward earning until an admin reviews.
// ---------------------------------------------------------------------------

export interface AbuseDetectionResult {
  flagged: number;
  byRule: Record<string, number>;
}

export const runAbuseDetection = async (): Promise<AbuseDetectionResult> => {
  const [lowQuality, abnormal, rapidFire, selfReferrals, sharedIp] = await Promise.all([
    detectLowQualityTranslations(),
    detectAbnormalEarnRate(),
    detectRapidFireCorrections(),
    detectSelfReferrals(),
    detectSharedIpReferrals(),
  ]);

  const byRule: Record<string, number> = {
    [ABUSE_RULES.LOW_QUALITY_TRANSLATION]: 0,
    [ABUSE_RULES.ABNORMAL_EARN_RATE]: 0,
    [ABUSE_RULES.RAPID_FIRE_CORRECTIONS]: 0,
    [ABUSE_RULES.SELF_REFERRAL]: 0,
    [ABUSE_RULES.SHARED_IP_REFERRALS]: 0,
  };

  for (const row of lowQuality) {
    await recordAbuseDetection({
      userId: row.userId,
      rule: ABUSE_RULES.LOW_QUALITY_TRANSLATION,
      severity: 'MEDIUM',
      reason: `${row.count} translation(s) under 10 characters`,
      metadata: { count: row.count },
    });
    byRule[ABUSE_RULES.LOW_QUALITY_TRANSLATION] += 1;
  }

  for (const row of abnormal) {
    await recordAbuseDetection({
      userId: row.userId,
      rule: ABUSE_RULES.ABNORMAL_EARN_RATE,
      severity: 'HIGH',
      reason: `Earned ${row.earned} GT in 24h from non-purchase sources`,
      metadata: { earned: row.earned },
    });
    byRule[ABUSE_RULES.ABNORMAL_EARN_RATE] += 1;
  }

  for (const row of rapidFire) {
    await recordAbuseDetection({
      userId: row.userId,
      rule: ABUSE_RULES.RAPID_FIRE_CORRECTIONS,
      severity: 'MEDIUM',
      reason: `${row.count} corrections in the last hour`,
      metadata: { count: row.count },
    });
    byRule[ABUSE_RULES.RAPID_FIRE_CORRECTIONS] += 1;
  }

  for (const row of selfReferrals) {
    await recordAbuseDetection({
      userId: row.userId,
      rule: ABUSE_RULES.SELF_REFERRAL,
      severity: 'HIGH',
      reason: `Mutual referral with ${(row.targetIds ?? []).join(', ')}`,
      metadata: { partners: row.targetIds ?? [] },
    });
    byRule[ABUSE_RULES.SELF_REFERRAL] += 1;
  }

  for (const row of sharedIp) {
    await recordAbuseDetection({
      userId: row.userId,
      rule: ABUSE_RULES.SHARED_IP_REFERRALS,
      severity: 'HIGH',
      reason: `Referral activity shared with other accounts from IP ${(row.targetIds ?? []).join(', ')}`,
      metadata: { ips: row.targetIds ?? [] },
    });
    byRule[ABUSE_RULES.SHARED_IP_REFERRALS] += 1;
  }

  const flagged = Object.values(byRule).reduce((sum, n) => sum + n, 0);
  logger.info({ flagged, byRule }, 'Abuse detection sweep completed');

  return { flagged, byRule };
};

const ABUSE_DETECTION_JOB_OPTIONS = {
  removeOnComplete: 50,
  removeOnFail: 50,
  repeat: {
    // Hourly from process start; the sweep is idempotent per (userId, rule).
    every: 60 * 60 * 1000,
  } satisfies RepeatOptions,
};

export const scheduleAbuseDetection = async () => {
  await reconciliationQueue.add(
    'abuse-detect',
    {},
    { ...ABUSE_DETECTION_JOB_OPTIONS, jobId: 'abuse-detection-hourly' },
  );
};

export const processAbuseDetectionJob = async (): Promise<void> => {
  await runAbuseDetection();
};