import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { processTranslationJob } from '../src/jobs/translationJob';
import { CURRENT_PROMPT_VERSION } from '../src/services/providers/geminiProvider';

(async () => {
  // Find Balance by Wizkid
  const song = await prisma.song.findFirst({
    where: { title: { contains: 'Balance', mode: 'insensitive' } },
    include: {
      artist: { select: { name: true } },
      lyrics: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  if (!song || !song.lyrics[0]?.content) {
    console.log('Balance by Wizkid not found with lyrics');
    process.exit(1);
  }

  // Use a real user from the DB
  const user = await prisma.user.findFirst({
    where: { email: 'tidarkson@gmail.com' },
  });

  if (!user) {
    console.log('User not found');
    process.exit(1);
  }

  console.log(`Song: ${song.title} by ${song.artist.name} (${song.lyrics[0].content.length} chars)`);
  console.log(`User: ${user.email} (${user.id})`);
  console.log(`\nStarting translation: en -> fr (French)\n`);

  const startTime = Date.now();

  const mockJob = {
    id: 'test-e2e-' + Date.now(),
    data: {
      songId: song.id,
      userId: user.id,
      sourceLang: 'en',
      targetLang: 'fr',
      promptVersion: CURRENT_PROMPT_VERSION,
    },
    attemptsMade: 0,
    updateProgress: async (progress: any) => {
      console.log(`  Progress: ${JSON.stringify(progress)}`);
    },
  };

  try {
    await processTranslationJob(mockJob as any);
    const elapsed = Date.now() - startTime;
    console.log(`\nTranslation completed in ${(elapsed / 1000).toFixed(1)}s`);

    const translation = await prisma.translation.findFirst({
      where: { songId: song.id, targetLang: 'fr', userId: user.id },
      orderBy: { createdAt: 'desc' },
    });

    if (translation) {
      console.log(`\nSaved to DB (status: ${translation.status}, id: ${translation.id})`);
      console.log(`\n=== TRANSLATED LYRICS ===\n${translation.translatedLyrics}`);
      console.log(`\n=== CULTURAL CONTEXT ===\n${translation.culturalContext}`);
    }
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    console.error(`\nFAILED after ${(elapsed / 1000).toFixed(1)}s: ${err.message}`);
  }

  await prisma.$disconnect();
})();
