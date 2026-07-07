import { redis } from './src/lib/redis';

async function clearCache() {
  try {
    console.log('Clearing Redis cache...');
    await redis.del('catalog:homepage:v3');
    await redis.del('catalog:homepage:v2');
    await redis.del('catalog:homepage:v1');
    console.log('✓ Cache cleared successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error clearing cache:', error);
    process.exit(1);
  }
}

clearCache();
