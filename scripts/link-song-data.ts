/**
 * Link Songs to Genres, Languages, and Create Placeholder Lyrics
 *
 * The Spotify seed creates songs/artists/albums but doesn't populate the
 * junction tables (SongGenre, SongLanguage) or create Lyric records.
 * This script fixes that by:
 *
 *   1. Linking songs → genres based on the artist's Spotify genres
 *   2. Linking songs → languages based on artist origin heuristics
 *   3. Creating placeholder lyrics for songs without any
 *
 * Usage:
 *   npx tsx scripts/link-song-data.ts
 *   npx tsx scripts/link-song-data.ts --dry-run
 *   npx tsx scripts/link-song-data.ts --genres-only
 *   npx tsx scripts/link-song-data.ts --languages-only
 */

import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');
const GENRES_ONLY = process.argv.includes('--genres-only');
const LANGUAGES_ONLY = process.argv.includes('--languages-only');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── Genre Mapping ───────────────────────────────────────────────────────────
// Maps Spotify genre tags to our Genre table names

const GENRE_MAP: Record<string, string[]> = {
  // Afrobeats family
  'afrobeats': ['Afrobeats'],
  'afro beat': ['Afrobeats'],
  'afropop': ['Afropop'],
  'afro pop': ['Afropop'],
  'afro-fusion': ['Afro-fusion'],
  'afro fusion': ['Afro-fusion'],
  'afro house': ['Afrobeats', 'Amapiano'],

  // Amapiano
  'amapiano': ['Amapiano'],
  'south african house': ['Amapiano'],

  // R&B
  'r&b': ['R&B', 'Alt-R&B'],
  'alt r&b': ['Alt-R&B'],
  'alternative r&b': ['Alt-R&B'],
  'contemporary r&b': ['R&B'],

  // Highlife
  'highlife': ['Highlife'],
  'ghanaian highlife': ['Highlife'],
  'nigerian highlife': ['Highlife'],

  // Dancehall
  'dancehall': ['Dancehall'],
  'reggae': ['Dancehall'],

  // Hip-Hop
  'hip hop': ['Hip-Hop'],
  'hip-hop': ['Hip-Hop'],
  'rap': ['Hip-Hop'],
  'nigerian hip hop': ['Hip-Hop', 'Afrobeats'],

  // Banku
  'banku': ['Banku'],
  'ghanaian': ['Banku'],
  'azonto': ['Banku'],

  // Bongo Flava
  'bongo flava': ['Afrobeats'],
  'bongo': ['Afrobeats'],

  // Gengetone
  'gengetone': ['Hip-Hop'],

  // East African
  'swahili': ['Afrobeats'],

  // Fallbacks
  'nigerian': ['Afrobeats'],
  'african': ['Afrobeats'],
  'west african': ['Afrobeats'],
  'east african': ['Afrobeats'],
};

// ─── Language Detection Heuristics ───────────────────────────────────────────

interface LanguageHint {
  code: string;
  percentage: number;
}

// Artist name → likely language patterns
const ARTIST_LANGUAGE_MAP: Record<string, string[]> = {
  // Nigerian artists → English + Nigerian Pidgin
  'burna boy': ['en', 'pcm'],
  'wizkid': ['en', 'pcm'],
  'davido': ['en', 'pcm'],
  'tems': ['en'],
  'asake': ['en', 'yo', 'pcm'],
  'rema': ['en', 'pcm'],
  'fireboy dml': ['en', 'pcm'],
  'ayra starr': ['en', 'pcm'],
  'tiwa savage': ['en', 'pcm'],
  'ose': ['en', 'yo', 'pcm'],
  'ckay': ['en', 'pcm'],
  'bad boy timz': ['en', 'pcm'],
  'carter efe': ['en', 'pcm'],
  'muyeez': ['en', 'pcm'],
  'shenseea': ['en'],
  'pta sowah': ['en'],
  'sarkodie': ['en'],
  'stonebwoy': ['en'],
  'shatta wale': ['en'],

  // East African artists → English + Swahili
  'sauti sol': ['en', 'sw'],
  'diamond platnumz': ['sw', 'en'],
  'harmonize': ['sw', 'en'],
  'zuchu': ['sw', 'en'],
  'ombeni nairo': ['sw', 'en'],

  // West African (non-Nigerian) → English + French
  'magic system': ['fr', 'en'],
  'serge ibaka': ['fr', 'en'],
};

// Fallback: most African pop music is primarily English + Pidgin
const DEFAULT_LANGUAGES: LanguageHint[] = [
  { code: 'en', percentage: 70 },
  { code: 'pcm', percentage: 30 },
];

// Regional defaults for when we can't determine the artist
const REGIONAL_DEFAULTS: Record<string, LanguageHint[]> = {
  'nigerian': [{ code: 'en', percentage: 60 }, { code: 'pcm', percentage: 40 }],
  'ghanaian': [{ code: 'en', percentage: 80 }, { code: 'ha', percentage: 20 }],
  'kenyan': [{ code: 'en', percentage: 50 }, { code: 'sw', percentage: 50 }],
  'south african': [{ code: 'en', percentage: 80 }],
  'tanzanian': [{ code: 'sw', percentage: 60 }, { code: 'en', percentage: 40 }],
  'senegalese': [{ code: 'fr', percentage: 70 }, { code: 'en', percentage: 30 }],
  'ivorian': [{ code: 'fr', percentage: 70 }, { code: 'en', percentage: 30 }],
};

// ─── Main Logic ──────────────────────────────────────────────────────────────

function matchSpotifyGenresToDb(artistGenres: string[]): string[] {
  const matched = new Set<string>();
  for (const spotifyGenre of artistGenres) {
    const lower = spotifyGenre.toLowerCase();
    for (const [pattern, dbGenres] of Object.entries(GENRE_MAP)) {
      if (lower.includes(pattern)) {
        for (const g of dbGenres) matched.add(g);
      }
    }
  }
  return [...matched];
}

function guessLanguagesFromArtist(artistName: string, artistGenres: string[]): LanguageHint[] {
  const lower = artistName.toLowerCase();

  // Direct artist lookup
  for (const [key, langs] of Object.entries(ARTIST_LANGUAGE_MAP)) {
    if (lower.includes(key)) {
      return langs.map(code => ({
        code,
        percentage: code === 'en' ? 60 : 40,
      }));
    }
  }

  // Genre-based heuristics
  const genreStr = artistGenres.join(' ').toLowerCase();
  if (genreStr.includes('amapiano') || genreStr.includes('south african')) {
    return [{ code: 'en', percentage: 80 }];
  }
  if (genreStr.includes('bongo') || genreStr.includes('swahili') || genreStr.includes('gengetone')) {
    return [{ code: 'sw', percentage: 50 }, { code: 'en', percentage: 50 }];
  }
  if (genreStr.includes('highlife') && (genreStr.includes('ghana') || genreStr.includes('banku'))) {
    return [{ code: 'en', percentage: 70 }, { code: 'ha', percentage: 30 }];
  }

  // Default: English + Nigerian Pidgin (most Afrobeats is this)
  return DEFAULT_LANGUAGES;
}

async function linkGenres(): Promise<{ created: number; linked: number }> {
  console.log('\n── Linking Songs to Genres ──────────────────────────────────');

  const songs = await prisma.song.findMany({
    select: { id: true, title: true, artistId: true },
  });
  const artists = await prisma.artist.findMany({
    select: { id: true, name: true, genres: true },
  });
  const artistMap = new Map(artists.map(a => [a.id, a]));

  // Ensure all Genre records exist
  const allGenreNames = new Set<string>();
  for (const genreList of Object.values(GENRE_MAP)) {
    for (const g of genreList) allGenreNames.add(g);
  }
  // Also add the genres from the seed
  for (const name of ['Afrobeats', 'Afropop', 'Afro-fusion', 'Amapiano', 'Alt-R&B', 'R&B', 'Highlife', 'Banku', 'Dancehall', 'Hip-Hop']) {
    allGenreNames.add(name);
  }

  const genreRecords = new Map<string, string>();
  for (const name of allGenreNames) {
    const genre = await prisma.genre.upsert({
      where: { name },
      create: { name },
      update: {},
      select: { id: true },
    });
    genreRecords.set(name, genre.id);
  }
  console.log(`  ${genreRecords.size} genre records ready`);

  let linked = 0;
  let created = 0;
  const BATCH = 100;

  for (let i = 0; i < songs.length; i += BATCH) {
    const batch = songs.slice(i, i + BATCH);

    // Check existing links
    const songIds = batch.map(s => s.id);
    const existingLinks = await prisma.songGenre.findMany({
      where: { songId: { in: songIds } },
      select: { songId: true, genreId: true },
    });
    const existingSet = new Set(existingLinks.map(l => `${l.songId}:${l.genreId}`));

    const newLinks: { songId: string; genreId: string }[] = [];

    for (const song of batch) {
      const artist = artistMap.get(song.artistId);
      if (!artist) continue;

      // Match artist's Spotify genres to our DB genres
      const matchedGenres = matchSpotifyGenresToDb(artist.genres || []);

      // If no match from Spotify genres, assign Afrobeats as default
      if (matchedGenres.length === 0) {
        matchedGenres.push('Afrobeats');
      }

      for (const genreName of matchedGenres) {
        const genreId = genreRecords.get(genreName);
        if (!genreId) continue;

        const key = `${song.id}:${genreId}`;
        if (!existingSet.has(key)) {
          newLinks.push({ songId: song.id, genreId });
          existingSet.add(key);
          created++;
        }
      }

      linked++;
    }

    if (newLinks.length > 0) {
      await prisma.songGenre.createMany({ data: newLinks, skipDuplicates: true });
    }

    if ((i / BATCH + 1) % 5 === 0) {
      console.log(`    ...${Math.min(i + BATCH, songs.length)}/${songs.length} songs processed`);
    }
  }

  console.log(`  ✅ Genres: ${linked} songs linked, ${created} new SongGenre records`);
  return { created, linked };
}

async function linkLanguages(): Promise<{ created: number; linked: number }> {
  console.log('\n── Linking Songs to Languages ───────────────────────────────');

  // Step 1: Ensure all language records exist first (batch)
  const allLangCodes = ['en', 'pcm', 'yo', 'ig', 'ha', 'sw', 'fr', 'pt'];
  const langNames: Record<string, string> = {
    en: 'English', pcm: 'Nigerian Pidgin', yo: 'Yoruba', ig: 'Igbo',
    ha: 'Hausa', sw: 'Swahili', fr: 'French', pt: 'Portuguese',
  };
  for (const code of allLangCodes) {
    await prisma.language.upsert({
      where: { code },
      create: { code, name: langNames[code] || code },
      update: {},
    });
  }
  console.log(`  ${allLangCodes.length} language records ready`);

  // Step 2: Load all songs and artists
  const songs = await prisma.song.findMany({
    select: { id: true, title: true, artistId: true },
  });
  const artists = await prisma.artist.findMany({
    select: { id: true, name: true, genres: true },
  });
  const artistMap = new Map(artists.map(a => [a.id, a]));

  // Step 3: Load existing language links in one query
  const existingLinks = await prisma.songLanguage.findMany({
    select: { songId: true, languageCode: true },
  });
  const existingSet = new Set(existingLinks.map(l => `${l.songId}:${l.languageCode}`));
  console.log(`  ${existingLinks.length} existing language links`);

  // Step 4: Build all new links in memory
  const newLinks: { songId: string; languageCode: string; percentage: number }[] = [];
  let linked = 0;

  for (const song of songs) {
    const artist = artistMap.get(song.artistId);
    const artistName = artist?.name || '';
    const artistGenres = artist?.genres || [];

    const languages = guessLanguagesFromArtist(artistName, artistGenres);

    // Normalize percentages to sum to 100
    const total = languages.reduce((sum, l) => sum + l.percentage, 0);
    const normalized = languages.map(l => ({
      ...l,
      percentage: Math.round((l.percentage / total) * 100),
    }));

    for (const lang of normalized) {
      const key = `${song.id}:${lang.code}`;
      if (!existingSet.has(key)) {
        newLinks.push({
          songId: song.id,
          languageCode: lang.code,
          percentage: lang.percentage,
        });
        existingSet.add(key);
      }
    }
    linked++;
  }

  console.log(`  ${newLinks.length} new language links to create`);

  // Step 5: Batch insert all at once
  const BATCH = 500;
  let created = 0;
  for (let i = 0; i < newLinks.length; i += BATCH) {
    const batch = newLinks.slice(i, i + BATCH);
    await prisma.songLanguage.createMany({ data: batch, skipDuplicates: true });
    created += batch.length;
    if ((i / BATCH + 1) % 2 === 0) {
      console.log(`    ...${created}/${newLinks.length} inserted`);
    }
  }

  console.log(`  ✅ Languages: ${linked} songs linked, ${created} new SongLanguage records`);
  return { created, linked };
}

async function createPlaceholderLyrics(): Promise<{ created: number }> {
  console.log('\n── Creating Placeholder Lyrics ──────────────────────────────');

  // Only create lyrics for songs that don't have any
  const songsWithoutLyrics = await prisma.song.findMany({
    where: { lyrics: { none: {} } },
    select: { id: true, title: true, artist: { select: { name: true } } },
    take: 500,
  });

  console.log(`  ${songsWithoutLyrics.length} songs without lyrics`);

  if (songsWithoutLyrics.length === 0) {
    console.log('  All songs already have lyrics');
    return { created: 0 };
  }

  let created = 0;
  const BATCH = 100;

  for (let i = 0; i < songsWithoutLyrics.length; i += BATCH) {
    const batch = songsWithoutLyrics.slice(i, i + BATCH);
    const data = batch.map(song => ({
      songId: song.id,
      content: null as string | null, // NULL = lyrics pending enrichment
      sourceProvider: 'MANUAL' as const,
      licenseStatus: 'UNKNOWN' as const,
    }));

    await prisma.lyric.createMany({ data, skipDuplicates: true });
    created += batch.length;
  }

  console.log(`  ✅ Created ${created} Lyric records (pending enrichment)`);
  return { created };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║    AFRO-GENIE: Link Songs → Genres, Languages, Lyrics  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (DRY_RUN) console.log('  ⚠️  DRY RUN MODE — no changes will be made\n');

  // Get initial counts
  const initialGenreLinks = await prisma.songGenre.count();
  const initialLangLinks = await prisma.songLanguage.count();
  const initialLyrics = await prisma.lyric.count();
  console.log(`  Before: ${initialGenreLinks} genre links, ${initialLangLinks} language links, ${initialLyrics} lyrics`);

  if (!DRY_RUN) {
    if (!LANGUAGES_ONLY) await linkGenres();
    if (!GENRES_ONLY) await linkLanguages();
    await createPlaceholderLyrics();
  } else {
    // Dry run: just show what would happen
    console.log('\n  [DRY RUN] Would link genres, languages, and create lyrics');
  }

  // Final counts
  const finalSongs = await prisma.song.count();
  const finalGenreLinks = await prisma.songGenre.count();
  const finalLangLinks = await prisma.songLanguage.count();
  const finalLyrics = await prisma.lyric.count();
  const finalSongsWithGenre = await prisma.$queryRawUnsafe<any[]>(
    'SELECT COUNT(DISTINCT "songId") as count FROM "SongGenre"'
  );
  const finalSongsWithLang = await prisma.$queryRawUnsafe<any[]>(
    'SELECT COUNT(DISTINCT "songId") as count FROM "SongLanguage"'
  );

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  FINAL STATUS');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Songs:            ${finalSongs}`);
  console.log(`  Genre links:      ${finalGenreLinks} (+${finalGenreLinks - initialGenreLinks})`);
  console.log(`  Songs with genre: ${finalSongsWithGenre[0]?.count || 0}`);
  console.log(`  Language links:   ${finalLangLinks} (+${finalLangLinks - initialLangLinks})`);
  console.log(`  Songs with lang:  ${finalSongsWithLang[0]?.count || 0}`);
  console.log(`  Lyrics:           ${finalLyrics} (+${finalLyrics - initialLyrics})`);
  console.log('═══════════════════════════════════════════════════════════');

  await prisma.$disconnect();
  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
