import IORedis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

const redis = new IORedis(process.env.REDIS_URL);

const keys = await redis.keys('catalog:*');
console.log('Found catalog cache keys:', keys);

if (keys.length > 0) {
  const deleted = await redis.del(...keys);
  console.log('Deleted', deleted, 'keys');
}

// Also check for any songs-related cache
const songKeys = await redis.keys('song:*');
console.log('Found song cache keys:', songKeys);
if (songKeys.length > 0) {
  const deleted = await redis.del(...songKeys);
  console.log('Deleted', deleted, 'song keys');
}

await redis.quit();
console.log('Done');
