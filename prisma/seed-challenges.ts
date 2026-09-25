/**
 * Seed the current week's challenges.
 * Run: npx tsx prisma/seed-challenges.ts
 *
 * Idempotent — upserts by (type, weekStart) and deactivates expired weeks.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const TEMPLATES = [
  { type: 'TRANSLATE_N_SONGS', title: 'Translate 3 Songs', description: 'Translate 3 different songs this week.', targetValue: 3, gtReward: 30 },
  { type: 'EARN_N_GT', title: 'Earn 100 GT this week', description: 'Earn 100 GT from any activity this week.', targetValue: 100, gtReward: 50 },
  { type: 'STREAK_7_DAYS', title: '7-Day Streak', description: 'Log in for 7 consecutive days.', targetValue: 7, gtReward: 25 },
  { type: 'INVITE_3_FRIENDS', title: 'Invite 2 Friends', description: 'Invite 2 friends who join this week.', targetValue: 2, gtReward: 20 },
] as const;

function getWeekWindow(now = new Date()) {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (midnight.getUTCDay() + 6) % 7;
  const startsAt = new Date(midnight.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  return { startsAt, expiresAt: new Date(startsAt.getTime() + WEEK_MS) };
}

async function main() {
  const { startsAt, expiresAt } = getWeekWindow();
  console.log(`Challenge seed: week ${startsAt.toISOString()} → ${expiresAt.toISOString()}`);

  let upserted = 0;
  for (const template of TEMPLATES) {
    await prisma.challenge.upsert({
      where: { type_startsAt: { type: template.type, startsAt } },
      update: {
        title: template.title,
        description: template.description,
        targetValue: template.targetValue,
        gtReward: template.gtReward,
        expiresAt,
        active: true,
      },
      create: { ...template, startsAt, expiresAt, active: true },
    });
    upserted += 1;
    console.log(`  Upserted "${template.title}" (${template.targetValue} → ${template.gtReward} GT)`);
  }

  const { count } = await prisma.challenge.updateMany({
    where: { expiresAt: { lt: new Date() }, active: true },
    data: { active: false },
  });

  console.log(`\nDone: ${upserted} challenges upserted, ${count} expired deactivated.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());