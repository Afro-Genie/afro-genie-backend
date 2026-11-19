import { prisma } from '../lib/prisma';

export async function getSongsNeedingLyrics() {
  return prisma.song.findMany({
    where: {
      softDeleted: false,
      youtubeVideoId: { not: null },
      OR: [
        { lyrics: { none: {} } },
        { lyrics: { some: { content: null, licenseStatus: { not: 'TAKEDOWN' } } } },
        { lyrics: { some: { content: '', licenseStatus: { not: 'TAKEDOWN' } } } },
      ],
    },
    select: {
      id: true,
      title: true,
      artist: { select: { name: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

export async function getLyricsBackfillCoverage(
  candidates?: Awaited<ReturnType<typeof getSongsNeedingLyrics>>,
) {
  const [youtubeLinked, populated, takedown] = await Promise.all([
    prisma.song.count({
      where: { softDeleted: false, youtubeVideoId: { not: null } },
    }),
    prisma.song.count({
      where: {
        softDeleted: false,
        youtubeVideoId: { not: null },
        lyrics: {
          some: {
            AND: [{ content: { not: null } }, { content: { not: '' } }],
          },
        },
      },
    }),
    prisma.song.count({
      where: {
        softDeleted: false,
        youtubeVideoId: { not: null },
        lyrics: { some: { licenseStatus: 'TAKEDOWN' } },
      },
    }),
  ]);
  const eligible = candidates || await getSongsNeedingLyrics();

  return {
    youtubeLinked,
    populated,
    eligible: eligible.length,
    takedownExcluded: takedown,
  };
}
