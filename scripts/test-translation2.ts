import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { translationQueue } from '../src/lib/queue';

async function main() {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) { console.log('No user found in DB'); return; }

  const song = await prisma.song.findFirst({
    where: { lyrics: { some: {} }, softDeleted: false, spotifyId: { not: null } },
    select: { id: true, title: true },
    orderBy: { views: 'desc' },
  });
  if (!song) { console.log('No song with lyrics found'); return; }

  console.log('Enqueuing translation for:', song.title, '(' + song.id + ')');
  console.log('Using userId:', user.id);

  const job = await translationQueue.add(
    'translate',
    { songId: song.id, userId: user.id, targetLang: 'en', sourceLang: 'en' },
    { jobId: 'test-translate-' + song.id + '-' + Date.now(), removeOnComplete: 10, removeOnFail: 10 }
  );
  console.log('Translation job enqueued:', job.id);
  await prisma.$disconnect();
}
main().catch(console.error);
