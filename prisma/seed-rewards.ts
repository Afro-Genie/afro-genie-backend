/**
 * Seed script for token rewards and badges.
 * Run: npx tsx prisma/seed-rewards.ts
 *
 * Creates sample reward data for existing users.
 * Idempotent — skips users that already have rewards.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const REWARD_REASONS = [
  { reason: 'Translation approved', amount: 10 },
  { reason: 'Translation upvoted', amount: 2 },
  { reason: 'Translation request fulfilled', amount: 5 },
  { reason: 'Topic created', amount: 5 },
  { reason: 'Comment created', amount: 2 },
];

const REWARDS_PER_USER = 8;

async function main() {
  console.log('Reward seed: finding users...');

  const users = await prisma.user.findMany({
    select: { id: true, displayName: true },
    take: 10,
  });

  if (users.length === 0) {
    console.log('No users found. Run the main seed first.');
    return;
  }

  let totalRewards = 0;
  let totalBadges = 0;

  for (const user of users) {
    const existingCount = await prisma.tokenReward.count({ where: { userId: user.id } });
    if (existingCount > 0) {
      console.log(`  Skipping ${user.displayName || user.id} (${existingCount} existing rewards)`);
      continue;
    }

    // Create rewards spread over the last 30 days
    const now = Date.now();
    const rewards = Array.from({ length: REWARDS_PER_USER }, (_, i) => {
      const template = REWARD_REASONS[i % REWARD_REASONS.length];
      return {
        userId: user.id,
        amount: template.amount,
        reason: template.reason,
        createdAt: new Date(now - Math.random() * 30 * 24 * 60 * 60 * 1000),
      };
    });

    await prisma.tokenReward.createMany({ data: rewards });
    totalRewards += rewards.length;
    console.log(`  Created ${rewards.length} rewards for ${user.displayName || user.id}`);

    // Award badges based on reward count
    const badgeTypes: string[] = [];
    if (REWARDS_PER_USER >= 1) badgeTypes.push('EARLY_ADOPTER');
    if (REWARDS_PER_USER >= 6) badgeTypes.push('TOP_TRANSLATOR');
    if (REWARDS_PER_USER >= 4) badgeTypes.push('CULTURE_CURATOR');
    if (REWARDS_PER_USER >= 3) badgeTypes.push('COMMUNITY_HELPER');

    for (const badgeType of badgeTypes) {
      const exists = await prisma.userBadge.findFirst({
        where: { userId: user.id, badgeType: badgeType as any },
      });
      if (!exists) {
        await prisma.userBadge.create({
          data: { userId: user.id, badgeType: badgeType as any },
        });
        totalBadges++;
      }
    }
  }

  console.log(`\nDone: ${totalRewards} rewards, ${totalBadges} badges created.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
