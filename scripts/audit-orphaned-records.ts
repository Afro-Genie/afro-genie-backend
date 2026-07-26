/**
 * Phase 1.3: Audit orphaned database records.
 * 
 * Usage: tsx scripts/audit-orphaned-records.ts
 * 
 * Checks:
 *   - Songs with artistId pointing to non-existent or soft-deleted artist
 *   - Songs with albumId pointing to non-existent album
 *   - SongGenre records with dangling foreign keys
 *   - Albums with artistId pointing to non-existent artist
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const dbUrl = new URL(process.env.DATABASE_URL!);
dbUrl.searchParams.delete('channel_binding');
const pool = new Pool({ connectionString: dbUrl.toString() });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('\n=== ORPHANED RECORDS AUDIT ===\n');

  // 1. Songs with non-existent or soft-deleted artists
  console.log('Checking songs with orphaned artist references...');
  const songsWithBadArtists = await prisma.$queryRaw<
    Array<{ id: string; title: string; artistId: string }>
  >`
    SELECT s.id, s.title, s."artistId"
    FROM "Song" s
    LEFT JOIN "Artist" a ON s."artistId" = a.id
    WHERE a.id IS NULL OR a."softDeleted" = true
  `;
  console.log(`  Found: ${songsWithBadArtists.length} songs with orphaned artist refs`);
  if (songsWithBadArtists.length > 0) {
    songsWithBadArtists.slice(0, 10).forEach((s) =>
      console.log(`    - "${s.title}" (${s.id}) → artistId: ${s.artistId}`)
    );
    if (songsWithBadArtists.length > 10) console.log(`    ... and ${songsWithBadArtists.length - 10} more`);
  }

  // 2. Songs with non-existent albums
  console.log('\nChecking songs with orphaned album references...');
  const songsWithBadAlbums = await prisma.$queryRaw<
    Array<{ id: string; title: string; albumId: string }>
  >`
    SELECT s.id, s.title, s."albumId"
    FROM "Song" s
    LEFT JOIN "Album" al ON s."albumId" = al.id
    WHERE s."albumId" IS NOT NULL AND al.id IS NULL
  `;
  console.log(`  Found: ${songsWithBadAlbums.length} songs with orphaned album refs`);
  if (songsWithBadAlbums.length > 0) {
    songsWithBadAlbums.slice(0, 10).forEach((s) =>
      console.log(`    - "${s.title}" (${s.id}) → albumId: ${s.albumId}`)
    );
  }

  // 3. SongGenre with dangling foreign keys
  console.log('\nChecking SongGenre junction with dangling references...');
  const orphanedSongGenres = await prisma.$queryRaw<
    Array<{ songId: string; genreId: string }>
  >`
    SELECT sg."songId", sg."genreId"
    FROM "SongGenre" sg
    LEFT JOIN "Song" s ON sg."songId" = s.id
    LEFT JOIN "Genre" g ON sg."genreId" = g.id
    WHERE s.id IS NULL OR g.id IS NULL OR s."softDeleted" = true
  `;
  console.log(`  Found: ${orphanedSongGenres.length} orphaned SongGenre records`);
  if (orphanedSongGenres.length > 0) {
    orphanedSongGenres.slice(0, 10).forEach((sg) =>
      console.log(`    - songId: ${sg.songId}, genreId: ${sg.genreId}`)
    );
  }

  // 4. Albums with orphaned artist references
  console.log('\nChecking albums with orphaned artist references...');
  const orphanedAlbums = await prisma.$queryRaw<
    Array<{ id: string; name: string; artistId: string }>
  >`
    SELECT a.id, a.name, a."artistId"
    FROM "Album" a
    LEFT JOIN "Artist" ar ON a."artistId" = ar.id
    WHERE ar.id IS NULL OR ar."softDeleted" = true
  `;
  console.log(`  Found: ${orphanedAlbums.length} albums with orphaned artist refs`);

  // 5. Suspended artists that are still referenced by non-deleted songs
  console.log('\nChecking suspended artists still serving songs...');
  const suspendedWithSongs = await prisma.$queryRaw<
    Array<{ id: string; name: string; songCount: bigint }>
  >`
    SELECT a.id, a.name, COUNT(s.id) as "songCount"
    FROM "Artist" a
    INNER JOIN "Song" s ON s."artistId" = a.id
    WHERE a."suspended" = true AND s."softDeleted" = false
    GROUP BY a.id, a.name
  `;
  console.log(`  Found: ${suspendedWithSongs.length} suspended artists with active songs`);
  suspendedWithSongs.forEach((a) =>
    console.log(`    - ${a.name} (${a.id}): ${a.songCount} songs`)
  );

  // 6. Summary
  console.log('\n=== AUDIT SUMMARY ===\n');
  console.log(`  Songs with orphaned artist:  ${songsWithBadArtists.length}`);
  console.log(`  Songs with orphaned album:   ${songsWithBadAlbums.length}`);
  console.log(`  Orphaned SongGenre records:  ${orphanedSongGenres.length}`);
  console.log(`  Orphaned albums:             ${orphanedAlbums.length}`);
  console.log(`  Suspended artists w/ songs:  ${suspendedWithSongs.length}`);

  // 7. Overall counts
  const [totalArtists, totalSongs, totalGenres, totalAlbums] = await Promise.all([
    prisma.artist.count({ where: { softDeleted: false } }),
    prisma.song.count({ where: { softDeleted: false } }),
    prisma.genre.count(),
    prisma.album.count(),
  ]);

  console.log('\n=== DATABASE TOTALS (non-deleted) ===\n');
  console.log(`  Artists: ${totalArtists}`);
  console.log(`  Songs:   ${totalSongs}`);
  console.log(`  Genres:  ${totalGenres}`);
  console.log(`  Albums:  ${totalAlbums}`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('Audit failed:', error);
  process.exit(1);
});
