import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { lyricsEnrichmentQueue } from '../src/lib/queue';
import { redis } from '../src/lib/redis';
import { backfillMissingLyrics } from '../src/services/syncStatusService';

async function main() {
  console.log('\n=== Starting YouTube-linked lyrics backfill ===\n');

  const lyricsResult = await backfillMissingLyrics((completed, total) => {
    process.stdout.write(`\r  Enqueuing lyrics enrichment: ${completed}/${total}`);
  });
  console.log(`\n  ${lyricsResult.enqueued} lyrics enrichment jobs enqueued\n`);

  const songsMissing = await prisma.song.count({
    where: {
      softDeleted: false,
      youtubeVideoId: { not: null },
      OR: [
        { lyrics: { none: {} } },
        { lyrics: { some: { content: null } } },
      ],
    },
  });

  console.log(`YouTube-linked songs still missing lyrics: ${songsMissing} (workers process queued jobs in background)`);
  console.log('Done.');
}

main()
  .catch(error => {
    console.error('Lyrics backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all([prisma.$disconnect(), lyricsEnrichmentQueue.close()]);
    if (process.env.DISABLE_REDIS !== 'true') redis.disconnect();
  });
