import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const songs = await prisma.song.count();
  const artists = await prisma.artist.count();
  const albums = await prisma.album.count();
  const genres = await prisma.genre.count();
  const languages = await prisma.language.count();
  const lyrics = await prisma.lyric.count();
  const translations = await prisma.translation.count();
  const users = await prisma.user.count();
  const forumCategories = await prisma.forumCategory.count();
  const topics = await prisma.topic.count();
  const topicComments = await prisma.topicComment.count();
  const songsWithPreview = await prisma.song.count({ where: { previewAvailable: true } });
  const songsWithAlbum = await prisma.song.count({ where: { albumId: { not: null } } });
  const songsWithSpotify = await prisma.song.count({ where: { spotifyId: { not: null } } });

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('       AFRO-GENIE DATABASE STATUS');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log(`  📊 CORE DATA`);
  console.log(`  Songs:            ${songs}        ${songs >= 78 ? '✅' : '❌ (need ≥78)'}`);
  console.log(`  Artists:          ${artists}        ${artists >= 20 ? '✅' : '⚠️'}`);
  console.log(`  Albums:           ${albums}        ${albums >= 20 ? '✅' : '⚠️'}`);
  console.log(`  Genres:           ${genres}         ${genres >= 10 ? '✅' : '❌ (need 10)'}`);
  console.log(`  Languages:        ${languages}         ${languages >= 8 ? '✅' : '❌ (need 8)'}`);
  console.log('');
  console.log(`  📚 CONTENT`);
  console.log(`  Lyrics:           ${lyrics}`);
  console.log(`  Translations:     ${translations}`);
  console.log(`  Users:            ${users}`);
  console.log(`  Forum Categories: ${forumCategories}`);
  console.log(`  Topics:           ${topics}`);
  console.log(`  Topic Comments:   ${topicComments}`);
  console.log('');
  console.log(`  🎵 SONG DETAILS`);
  console.log(`  With Spotify ID:  ${songsWithSpotify}`);
  console.log(`  With Preview:     ${songsWithPreview}`);
  console.log(`  With Album:       ${songsWithAlbum}`);
  console.log('');
  console.log('═══════════════════════════════════════════════════');

  const allPass = songs >= 78 && genres >= 10 && languages >= 8;
  console.log(allPass ? '  🎉 ALL SEED CRITERIA MET' : '  ⚠️  SOME CRITERIA NOT MET');
  console.log('═══════════════════════════════════════════════════');

  await prisma.$disconnect();
  await pool.end();
}
main();
