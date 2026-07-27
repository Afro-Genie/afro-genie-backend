import 'dotenv/config';
import { prisma } from '../src/lib/prisma';

async function main() {
  const [totalSongs, totalArtists] = await Promise.all([
    prisma.song.count({ where: { softDeleted: false } }),
    prisma.artist.count({ where: { softDeleted: false } }),
  ]);

  const songsWithoutLyrics = await prisma.song.count({
    where: {
      softDeleted: false,
      spotifyId: { not: null },
      lyrics: { none: {} },
    },
  });

  const artistsNeedingLastFm = await prisma.artist.count({
    where: {
      softDeleted: false,
      spotifyId: { not: null },
      OR: [
        { popularity: 0 },
        { followers: 0 },
        { bio: null },
      ],
    },
  });

  console.log(`\n=== Enrichment Status ===`);
  console.log(`Songs:   ${totalSongs} total, ${totalSongs - songsWithoutLyrics} have lyrics, ${songsWithoutLyrics} MISSING lyrics`);
  console.log(`Artists: ${totalArtists} total, ${totalArtists - artistsNeedingLastFm} complete, ${artistsNeedingLastFm} NEED LastFM`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
