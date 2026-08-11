import { prisma } from '../lib/prisma';
import { resolveTier } from '../config/rewards';
import type { TierName } from '@prisma/client';

// ---------------------------------------------------------------------------
// Tier engine (Phase 1).
//
// LISTENER (0 approved, ×1.0) → SCRIBE (5, ×1.2) → MASTER_TRANSLATOR (50, ×1.5).
// Recomputed lazily on every translation approval event.
// ---------------------------------------------------------------------------

export async function recomputeTier(userId: string) {
  const approvedCount = await prisma.translation.count({
    where: { userId, status: { in: ['APPROVED', 'PUBLISHED'] } },
  });

  const config = resolveTier(approvedCount);

  return prisma.userTier.upsert({
    where: { userId },
    update: {
      tier: config.tier as TierName,
      multiplier: config.multiplier,
      approvedCount,
    },
    create: {
      userId,
      tier: config.tier as TierName,
      multiplier: config.multiplier,
      approvedCount,
    },
  });
}

export async function getMultiplier(userId: string): Promise<number> {
  const tier = await prisma.userTier.findUnique({ where: { userId } });
  return tier?.multiplier ?? 1.0;
}

export async function getTier(userId: string) {
  const tier = await prisma.userTier.findUnique({ where: { userId } });
  if (tier) return tier;
  return { userId, tier: 'LISTENER' as TierName, multiplier: 1.0, approvedCount: 0 };
}
