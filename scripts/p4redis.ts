import { redis } from '../src/lib/redis';

async function main() {
  for (const pattern of ['song:views:*', 'playback:source:*', 'youtube:match:*']) {
    const keys = await redis.keys(pattern);
    console.log(`\n=== ${pattern} (${keys.length}) ===`);
    for (const k of keys) {
      const ttl = await redis.ttl(k);
      const val = await redis.get(k);
      console.log(`${k}\n   ttl=${ttl} val=${String(val).slice(0, 90)}`);
    }
  }
}

main()
  .then(() => redis.quit())
  .catch(async (e) => {
    console.error(e);
    await redis.quit();
    process.exit(1);
  });
