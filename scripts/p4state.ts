import { prisma } from '../src/lib/prisma';

async function main() {
  const out = {
    songs: await prisma.song.count(),
    p3testSongs: await prisma.song.count({ where: { title: { startsWith: 'P3TEST' } } }),
    matched: await prisma.song.count({ where: { youtubeVideoId: { not: null } } }),
    songPlays: await prisma.songPlay.count(),
    anonPlays: await prisma.songPlay.count({ where: { userId: null } }),
    anonPlayRows: await prisma.songPlay.findMany({
      where: { userId: null },
      select: { id: true, songId: true, playedAt: true, song: { select: { title: true } } },
      orderBy: { playedAt: 'asc' },
      take: 20,
    }),
    artists: await prisma.artist.count(),
    p3testArtists: await prisma.artist.count({ where: { name: { startsWith: 'P3TEST' } } }),
    users: await prisma.user.count(),
    p3testUsers: await prisma.user.count({ where: { email: { contains: 'p3test' } } }),
  };
  console.log(JSON.stringify(out, null, 2));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
