import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { getRewardConfig } from '../config/rewards';
import { queueReward } from './rewardService';

const REFERRED_REWARD = 10;

function generateCode(): string {
  return `AG${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
}

export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
  if (user?.referralCode) return user.referralCode;

  // Try a few times in case of collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      await prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
      return code;
    } catch {
      continue;
    }
  }

  // Fallback — use user ID prefix
  const fallbackCode = `AG${userId.substring(0, 8).toUpperCase()}`;
  await prisma.user.update({ where: { id: userId }, data: { referralCode: fallbackCode } });
  return fallbackCode;
}

export async function applyReferral(referralCode: string, newUserId: string, ip?: string | null): Promise<{ success: boolean; message: string }> {
  const referrer = await prisma.user.findFirst({ where: { referralCode }, select: { id: true, displayName: true } });
  if (!referrer) {
    return { success: false, message: 'Invalid referral code' };
  }

  if (referrer.id === newUserId) {
    return { success: false, message: 'Cannot refer yourself' };
  }

  const newUser = await prisma.user.findUnique({ where: { id: newUserId }, select: { referredByUserId: true } });
  if (newUser?.referredByUserId) {
    return { success: false, message: 'You have already been referred' };
  }

  await prisma.user.update({ where: { id: newUserId }, data: { referredByUserId: referrer.id } });

  // Record the referral edge (idempotent by referredUserId) so abuse detection
  // can spot shared-IP / mutual referral rings.
  await prisma.referral
    .upsert({
      where: { referredUserId: newUserId },
      update: {},
      create: {
        referrerId: referrer.id,
        referredUserId: newUserId,
        code: referralCode,
        ip: ip ?? null,
      },
    })
    .catch((err) => logger.warn({ err, newUserId }, 'Failed to record referral edge'));

  // Award tokens to both parties asynchronously via queue
  const referralReward = (await getRewardConfig()).REFERRAL_REWARD;
  await queueReward(referrer.id, referralReward, `Referral bonus: ${newUserId.substring(0, 8)}`, 'REFERRAL_REWARD', `referral:${referrer.id}:${newUserId}`);
  await queueReward(newUserId, REFERRED_REWARD, `Welcome bonus via referral`, 'REFERRAL_BONUS', `referral-welcome:${newUserId}`);

  logger.info({ referrerId: referrer.id, newUserId }, 'Referral completed');

  return { success: true, message: `Referral applied! You earned ${referralReward} tokens.` };
}

/**
 * True when the two users referred each other (A→B→A). Referral commissions
 * must be blocked for such rings.
 */
export async function hasMutualReferral(userId: string, referrerId: string): Promise<boolean> {
  const [userRefersReferrer, referrerRefersUser] = await Promise.all([
    prisma.referral.findFirst({
      where: { referrerId: userId, referredUserId: referrerId },
      select: { id: true },
    }),
    prisma.referral.findFirst({
      where: { referrerId, referredUserId: userId },
      select: { id: true },
    }),
  ]);
  return Boolean(userRefersReferrer && referrerRefersUser);
}

export async function getMyReferrals(userId: string) {
  const referrals = await prisma.user.findMany({
    where: { referredByUserId: userId },
    select: {
      id: true,
      displayName: true,
      photoUrl: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  return {
    referralCode: (await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } }))?.referralCode || null,
    totalReferrals: referrals.length,
    referrals,
  };
}
