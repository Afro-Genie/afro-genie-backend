import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { translationQueue } from '../src/lib/queue';

async function main() {
  const song = await prisma.song.findFirst({
    where: { lyrics: { some: {} }, softDeleted: false, spotifyId: { not: null } },
    select: { id: true, title: true },
    orderBy: { views: 'desc' },
  });
  if (!song) { console.log('No song with lyrics found'); return; }
  console.log('Enqueuing translation for:', song.title, '(' + song.id + ')');
  const job = await translationQueue.add(
    'translate',
    { songId: song.id, targetLang: 'en', sourceLang: 'en' },
    { jobId: 'test-translate-' + song.id, removeOnComplete: 10, removeOnFail: 10 }
  );
  console.log('Translation job enqueued:', job.id);
  await prisma.$disconnect();
}
main().catch(console.error);
