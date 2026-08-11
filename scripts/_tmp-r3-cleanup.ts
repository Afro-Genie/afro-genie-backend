import { prisma } from '../src/lib/prisma';

const main = async () => {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@afrogenie.local' } },
    select: { id: true, email: true },
  });
  const userIds = users.map((u) => u.id);

  const artists = await prisma.artist.findMany({ where: { name: { startsWith: 'R3 Artist' } }, select: { id: true } });
  const songs = await prisma.song.findMany({ where: { title: { startsWith: 'R3 Song' } }, select: { id: true } });
  const cats = await prisma.forumCategory.findMany({ where: { name: { startsWith: 'R3 Cat' } }, select: { id: true } });
  const topics = await prisma.topic.findMany({ where: { title: { startsWith: 'R3 Topic' } }, select: { id: true } });
  const items = await prisma.storeItem.findMany({ where: { name: { startsWith: 'R3 ' } }, select: { id: true } });

  console.log('users', userIds.length, 'artists', artists.length, 'songs', songs.length, 'cats', cats.length, 'topics', topics.length, 'items', items.length);

  await prisma.seasonalSnapshot.deleteMany({ where: { period: '1999-05' } }).catch(() => undefined);
  await prisma.tokenLedger.deleteMany({ where: { sourceType: 'SEASON_BONUS', sourceId: '1999-05' } }).catch(() => undefined);
  await prisma.tokenLedger.deleteMany({ where: { sourceType: 'SEASON_TEST' } }).catch(() => undefined);
  await prisma.moderationLog.deleteMany({ where: { targetType: 'MOD_POOL' } }).catch(() => undefined);
  await prisma.guideline.deleteMany({ where: { content: { startsWith: 'R3-smoke' } } }).catch(() => undefined);
  await prisma.contentReport.deleteMany({ where: { reason: { startsWith: 'R3 smoke' } } }).catch(() => undefined);

  const songIds = songs.map((s) => s.id);
  const translations = songIds.length
    ? await prisma.translation.findMany({ where: { songId: { in: songIds } }, select: { id: true } })
    : [];
  const translationIds = translations.map((t) => t.id);
  if (translationIds.length) {
    await prisma.translationCorrection.deleteMany({ where: { translationId: { in: translationIds } } }).catch(() => undefined);
    await prisma.translationVote.deleteMany({ where: { translationId: { in: translationIds } } }).catch(() => undefined);
  }
  await prisma.moderationLog.deleteMany({ where: { targetId: { in: translationIds } } }).catch(() => undefined);

  const itemIds = items.map((i) => i.id);
  if (itemIds.length) {
    await prisma.storePurchase.deleteMany({ where: { itemId: { in: itemIds } } }).catch(() => undefined);
  }
  if (userIds.length) {
    await prisma.storePurchase.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
    await prisma.userEntitlement.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  }
  if (itemIds.length) {
    await prisma.storeItem.deleteMany({ where: { id: { in: itemIds } } }).catch(() => undefined);
  }

  if (translationIds.length) {
    await prisma.translation.deleteMany({ where: { id: { in: translationIds } } }).catch(() => undefined);
  }
  if (songIds.length) {
    await prisma.song.deleteMany({ where: { id: { in: songIds } } }).catch(() => undefined);
  }
  const topicIds = topics.map((t) => t.id);
  if (topicIds.length) {
    await prisma.topic.deleteMany({ where: { id: { in: topicIds } } }).catch(() => undefined);
  }
  const catIds = cats.map((c) => c.id);
  if (catIds.length) {
    await prisma.forumCategory.deleteMany({ where: { id: { in: catIds } } }).catch(() => undefined);
  }
  const artistIds = artists.map((a) => a.id);
  if (artistIds.length) {
    await prisma.artist.deleteMany({ where: { id: { in: artistIds } } }).catch(() => undefined);
  }

  for (const id of userIds) {
    await prisma.user.delete({ where: { id } }).catch(() => undefined);
  }

  const left = await prisma.user.count({ where: { email: { endsWith: '@afrogenie.local' } } });
  console.log('remaining r3 users:', left);
};

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    prisma.$disconnect();
  });
