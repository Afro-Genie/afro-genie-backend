import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { REWARD_CONFIG } from '../config/rewards';
import { awardTokens } from './tokenService';
import { evaluateStreakBadge } from './badgeService';

// ---------------------------------------------------------------------------
// Streak service (Phase 1).
//
// Tracks consecutive daily logins on UserStreak. First login of a calendar day
// awards the daily base + a streak bonus. Day boundaries are UTC. Failures are
// logged but never break the underlying auth flow.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDayUtc = (date: Date): number =>
  Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

const dayKeyUtc = (date: Date): string => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return d.toISOString().slice(0, 10);
};

export async function recordLogin(userId: string) {
  try {
    const today = new Date();
    const todayMs = startOfDayUtc(today);
    const todayKey = dayKeyUtc(today);

    const existing = await prisma.userStreak.findUnique({ where: { userId } });
    const lastDayMs = existing?.lastLoginDate ? startOfDayUtc(existing.lastLoginDate) : null;

    // Already logged in today — no-op (idempotent per calendar day).
    if (lastDayMs === todayMs) {
      return existing;
    }

    const currentStreak = lastDayMs === todayMs - DAY_MS ? (existing?.currentStreak ?? 0) + 1 : 1;

    const updated = await prisma.userStreak.upsert({
      where: { userId },
      update: {
        currentStreak,
        longestStreak: Math.max(existing?.longestStreak ?? 0, currentStreak),
        lastLoginDate: today,
      },
      create: {
        userId,
        currentStreak,
        longestStreak: currentStreak,
        lastLoginDate: today,
      },
    });

    // Daily login base (+1), once per user per day.
    await awardTokens({
      userId,
      type: 'EARN',
      amount: REWARD_CONFIG.DAILY_LOGIN_AMOUNT,
      reason: 'Daily login',
      sourceType: 'LOGIN',
      sourceId: todayKey,
      idempotencyKey: `login:${userId}:${todayKey}`,
    });

    // Streak bonus: +5 × (streak − 1), capped at 50.
    const bonus = Math.min(
      REWARD_CONFIG.STREAK_BONUS_PER_DAY * (currentStreak - 1),
      REWARD_CONFIG.STREAK_BONUS_CAP,
    );
    if (bonus > 0) {
      await awardTokens({
        userId,
        type: 'EARN',
        amount: bonus,
        reason: `Login streak bonus (${currentStreak} days)`,
        sourceType: 'STREAK_BONUS',
        sourceId: todayKey,
        idempotencyKey: `login-bonus:${userId}:${todayKey}`,
      });
    }

    // Phase 4: DAILY_STREAK_7 badge when the streak crosses 7 days.
    await evaluateStreakBadge(userId);

    return updated;
  } catch (err) {
    logger.error({ err, userId }, 'recordLogin failed');
    return null;
  }
}
