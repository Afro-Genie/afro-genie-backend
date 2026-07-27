import IORedis from 'ioredis';

const redis = new IORedis('redis://default:xpEjJKmd1mR80cjuwp1S0SLQGMOXIiwL@hair-macrofast-microfine-29120.db.redis.io:14995', {
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
