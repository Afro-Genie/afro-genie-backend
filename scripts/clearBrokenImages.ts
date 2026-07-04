import { prisma } from '../src/lib/prisma';

async function clearBrokenImages() {
  console.log('Clearing broken image URLs from database...');

  const songUpdate = await prisma.song.updateMany({
    where: { imageUrl: { startsWith: 'https://images.afrogenie.dev' } },
    data: { imageUrl: '' },
  });
  console.log(`Songs updated: ${songUpdate.count}`);

  const artistUpdate = await prisma.artist.updateMany({
    where: { imageUrl: { startsWith: 'https://images.afrogenie.dev' } },
    data: { imageUrl: '' },
  });
  console.log(`Artists updated: ${artistUpdate.count}`);

  const genreUpdate = await prisma.genre.updateMany({
    where: { imageUrl: { startsWith: 'https://images.afrogenie.dev' } },
    data: { imageUrl: '' },
  });
  console.log(`Genres updated: ${genreUpdate.count}`);

  console.log('Done clearing broken image URLs.');
  await prisma.$disconnect();
}

clearBrokenImages().catch((err) => {
  console.error('Failed to clear broken images:', err);
  process.exit(1);
});
