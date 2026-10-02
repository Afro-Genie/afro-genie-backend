/**
 * Seed the current week's challenges.
 * Run: npx tsx prisma/seed-challenges.ts  (or npm run seed:challenges)
 *
 * Idempotent — upserts by (type, weekStart) and deactivates expired weeks.
 * Also invoked from the main prisma/seed.ts.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { CHALLENGE_TEMPLATES, getWeekWindow } from '../src/jobs/challengeRotationJob';

/**
 * The template list and week window are imported from
 * `src/jobs/challengeRotationJob` rather than duplicated here. This file used to
 * carry its own 4-entry copy of the list, which is how
 * `ACHIEVE_N_APPROVALS` ended up supported by the schema and the progress
 * calculator but absent from both rotation paths (2.2). One list, one source.
 */

export interface ChallengeSeedResult {
  upserted: number;
  deactivated: number;
}

export async function seedChallenges(prisma: PrismaClient): Promise<ChallengeSeedResult> {
  const { startsAt, expiresAt } = getWeekWindow();
  console.log(`Challenge seed: week ${startsAt.toISOString()} → ${expiresAt.toISOString()}`);

  let upserted = 0;
  for (const template of CHALLENGE_TEMPLATES) {
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
  return { upserted, deactivated: count };
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    await seedChallenges(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}