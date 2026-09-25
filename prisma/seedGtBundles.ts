import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// ---------------------------------------------------------------------------
// GT bundle seed (Phase 2). Idempotent: bundles are matched by name and
// updated in place, so re-running never duplicates them.
//
// Run standalone:  npx tsx prisma/seedGtBundles.ts
// Also invoked from the main prisma/seed.ts.
// ---------------------------------------------------------------------------

export const GT_BUNDLES = [
  { name: 'Starter', gtAmount: 100, priceKobo: 50000, badge: null, bonusPercent: 0, sortOrder: 1 },
  { name: 'Value', gtAmount: 500, priceKobo: 200000, badge: 'POPULAR', bonusPercent: 10, sortOrder: 2 },
  { name: 'Mega', gtAmount: 1200, priceKobo: 400000, badge: 'BEST VALUE', bonusPercent: 20, sortOrder: 3 },
  { name: 'Ultra', gtAmount: 3000, priceKobo: 900000, badge: null, bonusPercent: 25, sortOrder: 4 },
  { name: 'Whale', gtAmount: 10000, priceKobo: 2500000, badge: 'LEGENDARY', bonusPercent: 30, sortOrder: 5 },
] as const;

// Pass costs live in src/config/rewards.ts (PREMIUM_PASS_COSTS) since they are
// validated server-side; kept here as the canonical reference for seeding/docs.
export const PREMIUM_PASSES = [
  { type: 'SEVEN_DAY_PREMIUM', gtCost: 200, label: '7-Day Premium Pass' },
  { type: 'TRANSLATION_PACK_10', gtCost: 50, label: '10 Translation Credits' },
  { type: 'TRANSLATION_PACK_50', gtCost: 200, label: '50 Translation Credits' },
] as const;

export async function seedGtBundles(
  prisma: PrismaClient,
): Promise<{ created: number; updated: number }> {
  const existing = await prisma.gtBundle.findMany();
  const byName = new Map(existing.map((bundle) => [bundle.name, bundle]));

  let created = 0;
  let updated = 0;

  for (const bundle of GT_BUNDLES) {
    const previous = byName.get(bundle.name);
    if (previous) {
      await prisma.gtBundle.update({
        where: { id: previous.id },
        data: {
          gtAmount: bundle.gtAmount,
          priceKobo: bundle.priceKobo,
          currency: 'NGN',
          badge: bundle.badge,
          bonusPercent: bundle.bonusPercent,
          sortOrder: bundle.sortOrder,
          active: true,
        },
      });
      updated += 1;
    } else {
      await prisma.gtBundle.create({
        data: {
          name: bundle.name,
          gtAmount: bundle.gtAmount,
          priceKobo: bundle.priceKobo,
          currency: 'NGN',
          badge: bundle.badge,
          bonusPercent: bundle.bonusPercent,
          sortOrder: bundle.sortOrder,
          active: true,
        },
      });
      created += 1;
    }
  }

  return { created, updated };
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const { created, updated } = await seedGtBundles(prisma);
    console.log(`GT bundles seeded: ${created} created, ${updated} updated.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
