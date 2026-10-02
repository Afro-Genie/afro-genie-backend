import { redis } from '../src/lib/redis';
import { prisma } from '../src/lib/prisma';

const LEAKED = 'cmuj0m2w7000d8s135hhzi8o8';

async function main() {
  const song = await prisma.song.findUnique({ where: { id: LEAKED }, select: { id: true, title: true } });
  console.log('leaked playback:source owner song =', JSON.stringify(song));
  const matchKeys = await redis.keys('youtube:match:p3test-*');
  const sourceKeys = await redis.keys(`playback:source:${LEAKED}`);
  const viewKeys = await redis.keys(`song:views:${LEAKED}`);
  const toDelete = [...matchKeys, ...sourceKeys, ...viewKeys];
  console.log('deleting', toDelete.length, 'sentinel key(s)');
  if (toDelete.length) await redis.del(...toDelete);
  console.log('remaining p3test match keys =', (await redis.keys('youtube:match:p3test-*')).length);
  console.log('remaining playback:source keys =', await redis.keys('playback:source:*'));
  console.log('remaining song:views keys =', await redis.keys('song:views:*'));
  await prisma.$disconnect();
}

main()
  .then(() => redis.quit())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    await redis.quit();
    process.exit(1);
  });
