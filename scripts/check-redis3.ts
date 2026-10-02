/**
 * Ad-hoc Redis memory/connection inspection.
 *
 * The connection string was previously hard-coded, which put a live Redis Cloud
 * password in tracked source. It now comes from the environment like every
 * other client in this repo (`src/lib/redis.ts` reads `env.REDIS_URL`).
 *
 * Usage:
 *   $env:REDIS_URL="redis://default:password@host:port"; npx tsx scripts/check-redis3.ts
 */
import IORedis from 'ioredis';

const url = process.env.REDIS_URL || '';
if (!url) {
  console.error(
    '\nREFUSING TO RUN: REDIS_URL is not set.\n\n' +
      '  This script used to carry a live Redis Cloud credential in its source.\n' +
      '  That credential has been removed from the repository and should be\n' +
      '  rotated in the Redis Cloud console.\n\n' +
      '  Set REDIS_URL in .env.local (git-ignored) and re-run.\n\n',
  );
  process.exit(2);
}

const redis = new IORedis(url, {
  connectTimeout: 10000, commandTimeout: 5000, lazyConnect: true,
});
async function main() {
  await redis.connect();
  const info = await redis.info('memory');
  for (const line of info.split('\r\n')) {
    if (line.match(/(used_memory|maxmemory|evicted_keys|maxmemory_policy)/)) console.log(line);
  }
  const stats = await redis.info('stats');
  for (const line of stats.split('\r\n')) {
    if (line.match(/(total_connections_received|rejected_connections|instantaneous_ops_per_sec)/)) console.log(line);
  }
  console.log('DB keys:', await redis.dbsize());
  const clients = await redis.client('list');
  console.log('Connected clients:', clients ? clients.split('\n').length : 0);
  await redis.quit();
}
main().catch(console.error);