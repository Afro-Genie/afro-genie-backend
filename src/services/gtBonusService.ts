import { logger } from '../lib/logger';
import { getRewardConfig } from '../config/rewards';
import { awardTokens } from './tokenService';
import { createNotification } from './notificationService';
import { prisma } from '../lib/prisma';

// ---------------------------------------------------------------------------
// GT one-time bonuses (Phase 1, GT economy).
//
// WELCOME_BONUS lands on the very first session of a brand-new account;
// PROFILE_BONUS lands once when the user completes their profile. Both are
// idempotent via a stable idempotencyKey and defensive — a failure here must
// never break the signup/profile flow that triggered the award.
// ---------------------------------------------------------------------------

export async function awardWelcomeBonus(userId: string): Promise<void> {
  try {
    const config = await getRewardConfig();
    const { idempotencyKey } = await awardTokens({
      userId,
      type: 'EARN',
      amount: config.WELCOME_BONUS,
      reason: 'Welcome bonus',
      sourceType: 'WELCOME',
      sourceId: userId,
      idempotencyKey: `welcome:${userId}`,
    });

    await createNotification({
      userId,
      title: 'Welcome to Genie Tokens',
      message: `You earned +${config.WELCOME_BONUS} GT. Spend them on perks and unlockables!`,
      type: 'REWARD',
    });

    logger.info({ userId, idempotencyKey }, 'welcome bonus awarded');
  } catch (err) {
    logger.error({ err, userId }, 'welcome bonus failed');
  }
}

export async function awardProfileBonus(userId: string): Promise<void> {
  try {
    const config = await getRewardConfig();
    await awardTokens({
      userId,
      type: 'EARN',
      amount: config.PROFILE_BONUS,
      reason: 'Profile completed',
      sourceType: 'PROFILE_COMPLETE',
      sourceId: userId,
      idempotencyKey: `profile-complete:${userId}`,
    });

    await createNotification({
      userId,
      title: 'Profile complete',
      message: `You earned +${config.PROFILE_BONUS} GT for completing your profile.`,
      type: 'REWARD',
    });
  } catch (err) {
    logger.error({ err, userId }, 'profile bonus failed');
  }
}

export async function isProfileCompleted(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { profileCompleted: true },
  });
  return user?.profileCompleted ?? false;
}