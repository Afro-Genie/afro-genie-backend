import { prisma } from '../src/lib/prisma';

const run = async () => {
  await prisma.$executeRawUnsafe('ALTER TABLE "Artist" ADD COLUMN IF NOT EXISTS "softDeleted" BOOLEAN NOT NULL DEFAULT false;');
  await prisma.$executeRawUnsafe('ALTER TABLE "Song" ADD COLUMN IF NOT EXISTS "softDeleted" BOOLEAN NOT NULL DEFAULT false;');
  await prisma.$executeRawUnsafe('ALTER TABLE "Lyric" ALTER COLUMN "content" DROP NOT NULL;');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "Artist_softDeleted_idx" ON "Artist"("softDeleted");');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "Song_softDeleted_idx" ON "Song"("softDeleted");');
  console.log('manual migration applied');
};

void run()
  .catch((error) => {
    console.error('manual migration failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
