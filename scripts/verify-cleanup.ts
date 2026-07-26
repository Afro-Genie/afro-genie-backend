import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const COUNTRY_NAMES = ['nigeria','nigerian','ghana','south africa','south african','benin','cameroon','kenya','kenyan','tanzania','tanzanian','eswatini','ivory coast','ecuatorial guinea','rwanda','african','africa','niger','swazilandia'];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  let pass = 0;
  let fail = 0;
  const check = (label: string, ok: boolean, detail?: string) => {
    if (ok) { pass++; console.log('  PASS: ' + label); }
    else { fail++; console.log('  FAIL: ' + label + (detail ? ' - ' + detail : '')); }
  };

  console.log('=== PHASE 6: VERIFICATION ===\n');

  // 1. Song-Genre coverage
  const totalSongs = await prisma.song.count({ where: { softDeleted: false } });
  const songsWithGenres = await prisma.songGenre.groupBy({ by: ['songId'] });
  const genreCoverage = (songsWithGenres.length / totalSongs * 100).toFixed(1);
  check('Song-genre coverage >= 90%', songsWithGenres.length / totalSongs >= 0.9, `${genreCoverage}% (${songsWithGenres.length}/${totalSongs})`);

  // 2. No country names in artist genres
  const artists = await prisma.artist.findMany({ select: { name: true, genres: true } });
  let countryProblems = 0;
  for (const a of artists) {
    for (const g of a.genres) {
      if (COUNTRY_NAMES.includes(g.toLowerCase().trim())) { countryProblems++; break; }
    }
  }
  check('No country names in artist genres', countryProblems === 0, `${countryProblems} artists still have country tags`);

  // 3. All genres have images
  const genres = await prisma.genre.findMany({ select: { name: true, imageUrl: true } });
  const genresWithImages = genres.filter(g => g.imageUrl && !g.imageUrl.startsWith('data:'));
  check('All genres have images', genresWithImages.length === genres.length, `${genresWithImages.length}/${genres.length} genres have images`);

  // 4. All featured artists have images
  const featured = await prisma.artist.findMany({ where: { isFeatured: true }, select: { name: true, imageUrl: true } });
  const featuredWithImages = featured.filter(a => a.imageUrl && a.imageUrl.length > 0);
  check('Featured artists have images', featuredWithImages.length === featured.length, `${featuredWithImages.length}/${featured.length} featured artists have images`);

  // 5. Top artists have valid afro genres
  const topArtists = await prisma.artist.findMany({
    where: { softDeleted: false, suspended: false },
    select: { name: true, genres: true, popularity: true },
    orderBy: { popularity: 'desc' },
    take: 12,
  });
  const AFRO_GENRES = ['afrobeats','afrobeat','afropop','afro fusion','afropiano','amapiano','highlife','banku','bongo flava','kwaito','gqom','makossa','gengetone','naija','afro pop','afro r&b','afro soul','afrohiphop','afro hip hop','hiplife','rnb','soul','neo-soul','hip-hop','rap','pop','dancehall','reggae'];
  const topWithAfro = topArtists.filter(a => a.genres.some(g => AFRO_GENRES.includes(g.toLowerCase())));
  check('Top 12 artists have afro genres', topWithAfro.length >= 8, `${topWithAfro.length}/12 top artists have afro genres`);

  // 6. Song counts per genre
  const songGenreCounts = await prisma.songGenre.groupBy({ by: ['genreId'], _count: true });
  const avgSongsPerGenre = (songGenreCounts.reduce((s, g) => s + g._count, 0) / songGenreCounts.length).toFixed(1);
  check('Avg songs per genre >= 20', songGenreCounts.length > 0 && parseInt(avgSongsPerGenre) >= 20, `avg=${avgSongsPerGenre}, ${songGenreCounts.length} genres`);

  // 7. No orphaned SongGenre records
  const orphanedSG = await prisma.$queryRawUnsafe<{count: bigint}[]>(
    'SELECT COUNT(*) as count FROM "SongGenre" sg LEFT JOIN "Song" s ON sg."songId" = s.id WHERE s.id IS NULL'
  );
  check('No orphaned SongGenre records', Number(orphanedSG[0].count) === 0, `${orphanedSG[0].count} orphaned records`);

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log('Passed: ' + pass);
  console.log('Failed: ' + fail);
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');

  process.exit(fail > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
