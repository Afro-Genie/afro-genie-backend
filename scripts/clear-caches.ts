/**
 * Phase 1.6: Clear all caches (Redis + in-memory).
 * 
 * Usage: tsx scripts/clear-caches.ts
 * 
 * Clears:
 *   - Redis keys matching catalog:homepage:*
 *   - Redis keys matching spotify:search:*
 *   - Redis keys matching spotify:token
 *   - Redis keys matching song:views:*
 *   - Reports what was cleared
 */
import 'dotenv/config';
import IORedis from 'ioredis';

const redisDisabled = process.env.DISABLE_REDIS === 'true';

async function main() {
  console.log('\n=== CACHE CLEAR ===\n');

  if (redisDisabled) {
    console.log('Redis is disabled (DISABLE_REDIS=true). Nothing to clear.');
    return;
  }

  const redis = new IORedis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
    commandTimeout: 5000,
  });

  try {
    const patterns = [
      'catalog:homepage:*',
      'spotify:search:*',
      'spotify:token',
      'song:views:*',
    ];

    let totalCleared = 0;

    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      if (keys.length === 0) {
        console.log(`  ${pattern}: 0 keys`);
        continue;
      }

      // Delete in batches of 100
      let cleared = 0;
      for (let i = 0; i < keys.length; i += 100) {
        const batch = keys.slice(i, i + 100);
        await redis.del(...batch);
        cleared += batch.length;
      }

      console.log(`  ${pattern}: ${cleared} keys cleared`);
      totalCleared += cleared;
    }

    console.log(`\n  Total keys cleared: ${totalCleared}`);
    console.log('\n  Note: In-memory cache is cleared on server restart.');
    console.log('  If the server is running, restart it to clear the in-memory cache.\n');
  } finally {
    await redis.quit();
  }
}

main().catch((error) => {
  console.error('Cache clear failed:', error);
  process.exit(1);
});
