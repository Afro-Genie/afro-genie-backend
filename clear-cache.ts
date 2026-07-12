import { redis } from './src/lib/redis';

async function clearCache() {
  try {
    console.log('Clearing Redis cache...');

    const patterns = ['catalog:homepage:v*', 'spotify:search:*', 'song:views:*'];
    let totalCleared = 0;

    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`  Cleared ${keys.length} keys matching "${pattern}"`);
        totalCleared += keys.length;
      }
    }

    console.log(`✓ Cache cleared successfully (${totalCleared} keys total)`);
    process.exit(0);
  } catch (error) {
    console.error('Error clearing cache:', error);
    process.exit(1);
  }
}

clearCache();
