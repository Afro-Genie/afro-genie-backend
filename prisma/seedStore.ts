import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Store item seed (Phase 2 / 3.3 promotions). Idempotent: items are matched by
// `name|category` and updated in place, so re-running never duplicates them.
//
// Run standalone:  npx tsx prisma/seedStore.ts   (npm run seed:store)
// Also invoked from the main prisma/seed.ts.
//
// Promotional windows (featured/limitedTime/discount/promo*) are applied ONLY
// on CREATE so a later `npm run seed:store` never re-arms a promo that an
// admin cleared through /api/admin/economy/store. Catalog fields (name, cost,
// sortOrder, stock, featured) are treated as the seed's source of truth and
// reapplied on update.
// ---------------------------------------------------------------------------

export interface StoreItemSeed {
  name: string;
  description: string;
  tokenCost: number;
  category: string;
  metadata: Record<string, string | number | boolean>;
  featured?: boolean;
  limitedTime?: boolean;
  originalPrice?: number;
  discountedPrice?: number;
  discountPercent?: number;
  promoStartsAt?: Date;
  promoEndsAt?: Date;
  sortOrder?: number;
  stock?: number;
}

// Example limited-time promo: Sapphire Border @ 25% off, already started (so it
// renders now) and ending in exactly 7 days. discountedPrice = floor(80*0.75).
const PROMO_STARTS_AT = new Date(Date.now() - 24 * 60 * 60 * 1000);
const PROMO_ENDS_AT = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

export const STORE_ITEMS: StoreItemSeed[] = [
  {
    name: 'Amber Border',
    description: 'A warm amber avatar border to show off on your profile.',
    tokenCost: 40,
    category: 'avatar',
    metadata: { digital: true, entitlementType: 'avatar:border:amber' },
    sortOrder: 1,
  },
  {
    name: 'Sapphire Border',
    description: 'A cool sapphire avatar border for your profile.',
    tokenCost: 80,
    category: 'avatar',
    metadata: { digital: true, entitlementType: 'avatar:border:sapphire' },
    featured: true,
    sortOrder: 2,
    limitedTime: true,
    originalPrice: 80,
    discountedPrice: 60,
    discountPercent: 25,
    promoStartsAt: PROMO_STARTS_AT,
    promoEndsAt: PROMO_ENDS_AT,
  },
  {
    name: 'Emerald Border',
    description: 'A vibrant emerald avatar border for your profile.',
    tokenCost: 120,
    category: 'avatar',
    metadata: { digital: true, entitlementType: 'avatar:border:emerald' },
    sortOrder: 3,
  },
  {
    name: 'Royal Gold Border',
    description: 'The premium gold avatar border. Reserved for true legends.',
    tokenCost: 250,
    category: 'avatar',
    metadata: { digital: true, entitlementType: 'avatar:border:gold' },
    featured: true,
    sortOrder: 4,
  },
  {
    name: 'Early Adopter Title',
    description: 'A display title marking you as one of the first on Afro Genie.',
    tokenCost: 150,
    category: 'title',
    metadata: { digital: true, entitlementType: 'title:early-adopter' },
    sortOrder: 5,
  },
  {
    name: 'Master Translator Title',
    description: 'A display title for the sharpest translators in the community.',
    tokenCost: 300,
    category: 'title',
    metadata: { digital: true, entitlementType: 'title:master-translator' },
    featured: true,
    sortOrder: 6,
  },
  {
    name: 'Golden Candle',
    description: 'A digital golden candle to light up your listener profile.',
    tokenCost: 30,
    category: 'digital',
    metadata: { digital: true, entitlementType: 'digital:candle' },
    sortOrder: 7,
  },
  {
    name: 'Signed Artist Poster',
    description: 'A physical signed poster from a featured Afrobeats artist. Ships to you!',
    tokenCost: 500,
    category: 'merch',
    metadata: { digital: false },
    sortOrder: 8,
    stock: 5,
  },
];

export async function seedStoreItems(
  prisma: PrismaClient,
): Promise<{ created: number; updated: number }> {
  const existing = await prisma.storeItem.findMany();
  const byKey = new Map(existing.map((item) => [`${item.name}|${item.category}`, item]));

  let created = 0;
  let updated = 0;

  for (const item of STORE_ITEMS) {
    const key = `${item.name}|${item.category}`;
    const previous = byKey.get(key);
    if (previous) {
      await prisma.storeItem.update({
        where: { id: previous.id },
        data: {
          name: item.name,
          description: item.description,
          tokenCost: item.tokenCost,
          category: item.category,
          metadata: item.metadata,
          active: true,
          featured: item.featured ?? false,
          sortOrder: item.sortOrder ?? 0,
          ...(item.stock !== undefined ? { stock: item.stock } : {}),
        },
      });
      updated += 1;
    } else {
      await prisma.storeItem.create({
        data: {
          name: item.name,
          description: item.description,
          tokenCost: item.tokenCost,
          category: item.category,
          metadata: item.metadata,
          active: true,
          featured: item.featured ?? false,
          limitedTime: item.limitedTime ?? false,
          originalPrice: item.originalPrice ?? null,
          discountedPrice: item.discountedPrice ?? null,
          discountPercent: item.discountPercent ?? null,
          promoStartsAt: item.promoStartsAt ?? null,
          promoEndsAt: item.promoEndsAt ?? null,
          sortOrder: item.sortOrder ?? 0,
          stock: item.stock ?? null,
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
    const { created, updated } = await seedStoreItems(prisma);
    console.log(`Store items seeded: ${created} created, ${updated} updated.`);
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