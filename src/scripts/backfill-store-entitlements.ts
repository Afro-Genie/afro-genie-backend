import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

function readEntitlementType(metadata: unknown): string | null {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>).entitlementType;
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

async function backfillStoreEntitlements() {
  const dryRun = process.argv.includes('--dry-run');
  const fulfilled = await prisma.storePurchase.findMany({
    where: { status: 'FULFILLED' },
    include: {
      item: { select: { name: true, category: true, metadata: true } },
      user: { select: { id: true } },
    },
    orderBy: { fulfilledAt: 'desc' },
  });

  logger.info({ count: fulfilled.length, dryRun }, 'Backfilling store entitlements for fulfilled purchases');

  let granted = 0;
  let skipped = 0;
  for (const purchase of fulfilled) {
    const entitlementType = readEntitlementType(purchase.item.metadata);
    if (!entitlementType) {
      skipped++;
      continue;
    }

    if (dryRun) {
      granted++;
      logger.info(
        { purchaseId: purchase.id, userId: purchase.user.id, entitlementType },
        'Would grant entitlement',
      );
      continue;
    }

    await prisma.userEntitlement.upsert({
      where: { userId_type: { userId: purchase.user.id, type: entitlementType } },
      update: {},
      create: {
        userId: purchase.user.id,
        type: entitlementType,
        metadata: { itemName: purchase.item.name, itemCategory: purchase.item.category },
      },
    });
    granted++;
  }

  logger.info({ granted, skipped, dryRun }, 'Store entitlements backfill complete');
}

backfillStoreEntitlements()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'Store entitlements backfill failed');
    process.exit(1);
  });
