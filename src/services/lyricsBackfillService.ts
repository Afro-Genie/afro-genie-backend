import { prisma } from '../lib/prisma';

export type LyricsBackfillScope = 'new' | 'missed';

const missingLyricsWhere = {
  softDeleted: false,
  youtubeVideoId: { not: null },
  OR: [
    { lyrics: { none: {} } },
    { lyrics: { some: { content: null, licenseStatus: { not: 'TAKEDOWN' as any } } } },
    { lyrics: { some: { content: '', licenseStatus: { not: 'TAKEDOWN' as any } } } },
  ],
} ;

export async function getSongsNeedingLyrics(scope: LyricsBackfillScope = 'new') {
  return prisma.song.findMany({
    where: {
      ...missingLyricsWhere,
      lyricsBackfillMissedAt: scope === 'missed' ? { not: null } : null,
    },
    select: {
      id: true,
      title: true,
      artist: { select: { name: true } },
      lyricsBackfillMissedAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

export async function getMissedLyricsBackfillSongs(params: {
  limit: number;
  page: number;
  search?: string;
}) {
  const where = {
    ...missingLyricsWhere,
    lyricsBackfillMissedAt: { not: null },
    ...(params.search?.trim()
      ? {
          OR: [
            { title: { contains: params.search.trim(), mode: 'insensitive' as any } },
            { artist: { name: { contains: params.search.trim(), mode: 'insensitive' as any } } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.song.findMany({
      where,
      select: {
        id: true,
        title: true,
        artist: { select: { name: true } },
        lyricsBackfillMissedAt: true,
        youtubeVideoId: true,
      },
      orderBy: [{ lyricsBackfillMissedAt: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    }),
    prisma.song.count({ where }),
  ]);

  return { items, total, page: params.page, limit: params.limit };
}

export async function getLyricsBackfillCoverage(
  candidates?: Awaited<ReturnType<typeof getSongsNeedingLyrics>>,
  scope: LyricsBackfillScope = 'new',
) {
  const [youtubeLinked, populated, takedown, newEligible, missedEligible] = await Promise.all([
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
    prisma.song.count({ where: { ...missingLyricsWhere, lyricsBackfillMissedAt: null } }),
    prisma.song.count({ where: { ...missingLyricsWhere, lyricsBackfillMissedAt: { not: null } } }),
  ]);
  const eligible = candidates || await getSongsNeedingLyrics(scope);

  return {
    youtubeLinked,
    populated,
    eligible: eligible.length,
    takedownExcluded: takedown,
    newEligible,
    missedEligible,
    scope,
  };
}




