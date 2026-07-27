import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { backfillMissingLyrics, backfillArtistLastFm } from '../src/services/syncEngine';

async function main() {
  console.log('\n=== Starting backfills ===\n');

  console.log('--- Step 1: Backfill Lyrics ---');
  const lyricsResult = await backfillMissingLyrics((completed, total) => {
    process.stdout.write(`\r  Enqueuing lyrics enrichment: ${completed}/${total}`);
  });
  console.log(`\n  ${lyricsResult.enqueued} lyrics enrichment jobs enqueued\n`);

  console.log('--- Step 2: Backfill Artist LastFM Metadata ---');
  const artistResult = await backfillArtistLastFm((completed, total) => {
    process.stdout.write(`\r  Processing artists: ${completed}/${total}`);
  });
  console.log(`\n  ${artistResult.updated} artists updated, ${artistResult.skipped} skipped\n`);

  const songsMissing = await prisma.song.count({
    where: { softDeleted: false, spotifyId: { not: null }, lyrics: { none: {} } },
  });
  const artistsNeeding = await prisma.artist.count({
    where: {
      softDeleted: false,
      spotifyId: { not: null },
      OR: [{ popularity: 0 }, { followers: 0 }, { bio: null }],
    },
  });

  console.log('=== Final Status ===');
  console.log(`Songs still missing lyrics:    ${songsMissing} (enrichment workers processing in background)`);
  console.log(`Artists still needing LastFM:  ${artistsNeeding}`);
  console.log('Done.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
