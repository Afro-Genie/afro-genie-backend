/**
 * Safe cleanup script for duplicate artists and songs.
 *
 * - Identifies artists with the same name (case-insensitive)
 * - Keeps the best record (most songs, highest popularity, has spotifyId/image)
 * - Soft-deletes duplicates (does NOT hard-delete, preserving all relations)
 * - Removes soft-deleted records from Typesense
 * - Identifies songs with duplicate title+artist combinations and soft-deletes extras
 *
 * Usage:
 *   npx tsx scripts/cleanup-duplicates.ts          # Dry run (preview only)
 *   npx tsx scripts/cleanup-duplicates.ts --apply   # Apply changes
 */

import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { deleteSong, deleteArtist } from '../src/services/searchService';

const APPLY = process.argv.includes('--apply');

interface DuplicateGroup {
  name: string;
  artists: Array<{
    id: string;
    name: string;
    spotifyId: string | null;
    imageUrl: string | null;
    popularity: number;
    followers: number;
    songCount: number;
    softDeleted: boolean;
  }>;
  keeper: string;
  toDelete: string[];
}

interface DuplicateSong {
  id: string;
  title: string;
  artistId: string;
  artistName: string;
  spotifyId: string | null;
  imageUrl: string | null;
  views: number;
  hasLyrics: boolean;
  hasTranslation: boolean;
  softDeleted: boolean;
}

async function findDuplicateArtists(): Promise<DuplicateGroup[]> {
  // Find all active artists grouped by lowercased name
  const allArtists = await prisma.artist.findMany({
    where: { softDeleted: false },
    select: {
      id: true,
      name: true,
      spotifyId: true,
      imageUrl: true,
      popularity: true,
      followers: true,
      softDeleted: true,
      _count: { select: { songs: { where: { softDeleted: false } } } },
    },
  });

  const groups = new Map<string, typeof allArtists>();
  for (const artist of allArtists) {
    const key = artist.name.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(artist);
  }

  const duplicates: DuplicateGroup[] = [];
  for (const [name, artists] of groups) {
    if (artists.length <= 1) continue;

    // Sort: most songs first, then highest popularity, then has spotifyId, then has image
    artists.sort((a, b) => {
      if (b._count.songs !== a._count.songs) return b._count.songs - a._count.songs;
      if (b.popularity !== a.popularity) return b.popularity - a.popularity;
      if (a.spotifyId && !b.spotifyId) return -1;
      if (!a.spotifyId && b.spotifyId) return 1;
      if (a.imageUrl && !b.imageUrl) return -1;
      if (!a.imageUrl && b.imageUrl) return 1;
      return 0;
    });

    const keeper = artists[0];
    const toDelete = artists.slice(1).map((a) => a.id);

    duplicates.push({
      name: keeper.name,
      artists: artists.map((a) => ({
        id: a.id,
        name: a.name,
        spotifyId: a.spotifyId,
        imageUrl: a.imageUrl,
        popularity: a.popularity,
        followers: a.followers,
        songCount: a._count.songs,
        softDeleted: a.softDeleted,
      })),
      keeper: keeper.id,
      toDelete,
    });
  }

  return duplicates;
}

async function findDuplicateSongs(): Promise<DuplicateSong[]> {
  // Find songs with duplicate title+artistId combinations (active only)
  const duplicates = await prisma.$queryRaw<Array<{ title: string; artistId: string; count: bigint }>>`
    SELECT "title", "artistId", COUNT(*) as count
    FROM "Song"
    WHERE "softDeleted" = false
    GROUP BY "title", "artistId"
    HAVING COUNT(*) > 1
  `;

  const result: DuplicateSong[] = [];

  for (const dup of duplicates) {
    const songs = await prisma.song.findMany({
      where: {
        title: dup.title,
        artistId: dup.artistId,
        softDeleted: false,
      },
      select: {
        id: true,
        title: true,
        artistId: true,
        spotifyId: true,
        imageUrl: true,
        views: true,
        softDeleted: true,
        artist: { select: { name: true } },
        _count: { select: { lyrics: true, translations: true } },
      },
      orderBy: { views: 'desc' },
    });

    // Keep the first (highest views), mark rest for deletion
    result.push(
      ...songs.slice(1).map((s) => ({
        id: s.id,
        title: s.title,
        artistId: s.artistId,
        artistName: s.artist.name,
        spotifyId: s.spotifyId,
        imageUrl: s.imageUrl,
        views: s.views,
        hasLyrics: s._count.lyrics > 0,
        hasTranslation: s._count.translations > 0,
        softDeleted: s.softDeleted,
      }))
    );
  }

  return result;
}

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       DUPLICATE CLEANUP SCRIPT');
  console.log(`       Mode: ${APPLY ? 'APPLY (dry run disabled)' : 'DRY RUN (preview only)'}`);
  console.log('═══════════════════════════════════════════════════════════════');

  // --- Artist duplicates ---
  console.log('\n📋 Scanning for duplicate artists...');
  const artistGroups = await findDuplicateArtists();

  if (artistGroups.length === 0) {
    console.log('  ✅ No duplicate artists found');
  } else {
    console.log(`  ⚠️  Found ${artistGroups.length} group(s) of duplicate artists:\n`);
    let totalArtistDeletes = 0;

    for (const group of artistGroups) {
      console.log(`  "${group.name}" (${group.artists.length} entries):`);
      for (const a of group.artists) {
        const isKeeper = a.id === group.keeper;
        const tag = isKeeper ? '✅ KEEP' : '❌ DELETE';
        console.log(`    ${tag}  ID: ${a.id}`);
        console.log(`         Songs: ${a.songCount} | Pop: ${a.popularity} | Followers: ${a.followers} | Spotify: ${a.spotifyId ? 'yes' : 'no'} | Image: ${a.imageUrl ? 'yes' : 'no'}`);
      }
      totalArtistDeletes += group.toDelete.length;
      console.log('');
    }

    console.log(`  Total artists to soft-delete: ${totalArtistDeletes}`);

    if (APPLY && totalArtistDeletes > 0) {
      console.log('\n  🔧 Soft-deleting duplicate artists...');
      for (const group of artistGroups) {
        for (const artistId of group.toDelete) {
          try {
            // Check if artist has active songs — if so, we need to handle them first
            const activeSongs = await prisma.song.findMany({
              where: { artistId, softDeleted: false },
              select: { id: true, title: true },
            });

            if (activeSongs.length > 0) {
              console.log(`    ⚠️  Artist ${artistId} has ${activeSongs.length} active songs — transferring to keeper...`);

              // Transfer songs to the keeper artist
              for (const song of activeSongs) {
                // Check if keeper already has a song with this title
                const existing = await prisma.song.findFirst({
                  where: {
                    title: song.title,
                    artistId: group.keeper,
                    softDeleted: false,
                  },
                });

                if (existing) {
                  // Keeper already has this song — soft-delete the duplicate
                  console.log(`      🗑️  Song "${song.title}" already exists for keeper — soft-deleting duplicate ${song.id}`);
                  await prisma.song.update({
                    where: { id: song.id },
                    data: { softDeleted: true },
                  });
                  // Remove from Typesense
                  try {
                    await deleteSong(song.id);
                  } catch { /* ignore */ }
                } else {
                  // Transfer song to keeper
                  console.log(`      📦 Transferring "${song.title}" (${song.id}) to keeper ${group.keeper}`);
                  await prisma.song.update({
                    where: { id: song.id },
                    data: { artistId: group.keeper },
                  });
                }
              }
            }

            // Now soft-delete the artist
            await prisma.artist.update({
              where: { id: artistId },
              data: { softDeleted: true },
            });

            // Remove from Typesense
            try {
              await deleteArtist(artistId);
            } catch { /* ignore — may not exist in Typesense */ }

            console.log(`    ✅ Soft-deleted artist ${artistId}`);
          } catch (err: any) {
            console.error(`    ❌ Failed to soft-delete artist ${artistId}: ${err.message}`);
          }
        }
      }
    }
  }

  // --- Song duplicates ---
  console.log('\n📋 Scanning for duplicate songs...');
  const duplicateSongs = await findDuplicateSongs();

  if (duplicateSongs.length === 0) {
    console.log('  ✅ No duplicate songs found');
  } else {
    console.log(`  ⚠️  Found ${duplicateSongs.length} duplicate song(s):\n`);
    for (const s of duplicateSongs) {
      console.log(`  ❌ "${s.title}" by ${s.artistName} (ID: ${s.id})`);
      console.log(`     Views: ${s.views} | Lyrics: ${s.hasLyrics ? 'yes' : 'no'} | Translation: ${s.hasTranslation ? 'yes' : 'no'}`);
    }

    if (APPLY) {
      console.log('\n  🔧 Soft-deleting duplicate songs...');
      for (const song of duplicateSongs) {
        try {
          await prisma.song.update({
            where: { id: song.id },
            data: { softDeleted: true },
          });

          // Remove from Typesense
          try {
              await deleteSong(song.id);
          } catch { /* ignore */ }

          console.log(`    ✅ Soft-deleted "${song.title}" (${song.id})`);
        } catch (err: any) {
          console.error(`    ❌ Failed to soft-delete "${song.title}" (${song.id}): ${err.message}`);
        }
      }
    }
  }

  // --- Summary ---
  console.log('\n═══════════════════════════════════════════════════════════════');
  if (!APPLY) {
    console.log('  DRY RUN COMPLETE — No changes were made');
    console.log('  Run with --apply to execute the cleanup');
  } else {
    console.log('  ✅ CLEANUP COMPLETE');
    console.log('  Run `npx tsx scripts/indexExistingSongs.ts` to re-index Typesense');
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exitCode = 1;
});
