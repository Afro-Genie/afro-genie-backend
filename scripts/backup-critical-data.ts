/**
 * Phase 1.1: Backup critical data before any cleanup operations.
 * 
 * Usage: tsx scripts/backup-critical-data.ts
 * 
 * Exports:
 *   - backups/artists-{timestamp}.json
 *   - backups/songs-{timestamp}.json
 *   - backups/genres-{timestamp}.json
 *   - backups/song-genres-{timestamp}.json
 *   - backups/summary-{timestamp}.json
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const dbUrl = new URL(process.env.DATABASE_URL!);
dbUrl.searchParams.delete('channel_binding');
const pool = new Pool({ connectionString: dbUrl.toString() });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(__dirname, '..', 'backups', timestamp);

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  console.log(`\n=== BACKUP STARTED ===`);
  console.log(`Backup directory: ${backupDir}\n`);

  // 1. Backup Artists
  console.log('Backing up Artists...');
  const artists = await prisma.artist.findMany({
    orderBy: { createdAt: 'asc' },
  });
  fs.writeFileSync(
    path.join(backupDir, 'artists.json'),
    JSON.stringify(artists, null, 2)
  );
  console.log(`  -> ${artists.length} artists backed up`);

  // 2. Backup Songs
  console.log('Backing up Songs...');
  const songs = await prisma.song.findMany({
    orderBy: { createdAt: 'asc' },
  });
  fs.writeFileSync(
    path.join(backupDir, 'songs.json'),
    JSON.stringify(songs, null, 2)
  );
  console.log(`  -> ${songs.length} songs backed up`);

  // 3. Backup Genres
  console.log('Backing up Genres...');
  const genres = await prisma.genre.findMany({
    orderBy: { name: 'asc' },
  });
  fs.writeFileSync(
    path.join(backupDir, 'genres.json'),
    JSON.stringify(genres, null, 2)
  );
  console.log(`  -> ${genres.length} genres backed up`);

  // 4. Backup SongGenre junction
  console.log('Backing up SongGenre junction records...');
  const songGenres = await prisma.songGenre.findMany();
  fs.writeFileSync(
    path.join(backupDir, 'song-genres.json'),
    JSON.stringify(songGenres, null, 2)
  );
  console.log(`  -> ${songGenres.length} SongGenre records backed up`);

  // 5. Backup Albums
  console.log('Backing up Albums...');
  const albums = await prisma.album.findMany({
    orderBy: { createdAt: 'asc' },
  });
  fs.writeFileSync(
    path.join(backupDir, 'albums.json'),
    JSON.stringify(albums, null, 2)
  );
  console.log(`  -> ${albums.length} albums backed up`);

  // 6. Summary
  const summary = {
    timestamp: new Date().toISOString(),
    backupDir,
    counts: {
      artists: artists.length,
      songs: songs.length,
      genres: genres.length,
      songGenres: songGenres.length,
      albums: albums.length,
    },
    featuredArtists: artists.filter((a) => a.isFeatured).map((a) => ({ id: a.id, name: a.name })),
    suspendedArtists: artists.filter((a) => a.suspended).map((a) => ({ id: a.id, name: a.name })),
    softDeletedArtists: artists.filter((a) => a.softDeleted).map((a) => ({ id: a.id, name: a.name })),
    softDeletedSongs: songs.filter((s) => s.softDeleted).map((s) => ({ id: s.id, title: s.title })),
  };

  fs.writeFileSync(
    path.join(backupDir, 'summary.json'),
    JSON.stringify(summary, null, 2)
  );

  console.log(`\n=== BACKUP COMPLETE ===`);
  console.log(`Summary:`);
  console.log(`  Artists:           ${summary.counts.artists}`);
  console.log(`  Songs:             ${summary.counts.songs}`);
  console.log(`  Genres:            ${summary.counts.genres}`);
  console.log(`  SongGenre links:   ${summary.counts.songGenres}`);
  console.log(`  Albums:            ${summary.counts.albums}`);
  console.log(`  Featured artists:  ${summary.featuredArtists.length}`);
  console.log(`  Suspended artists: ${summary.suspendedArtists.length}`);
  console.log(`  Soft-deleted art:  ${summary.softDeletedArtists.length}`);
  console.log(`  Soft-deleted songs:${summary.softDeletedSongs.length}`);
  console.log(`\nBackup saved to: ${backupDir}\n`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('Backup failed:', error);
  process.exit(1);
});
