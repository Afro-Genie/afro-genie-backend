/**
 * Production catalog seeder.
 *
 * Primary data source for populating the catalog via the Admin Spotify Seeder.
 * Workflow: Admin logs in → Spotify OAuth → imports playlist via
 *   /api/admin/seeder/spotify-playlist → lyrics auto-enrich → songs appear in catalog.
 *
 * After every import:
 *   - New songs are enqueued for lyrics enrichment (MusicMatch → LyricFind → Genius chain)
 *   - Songs without a spotifyId are backfilled via Spotify search
 *   - Duplicate detection uses both spotifyId (Spotify imports) and @@unique([title, artistId])
 *     (manual imports) to prevent re-inserting existing songs.
 */

import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { getSpotifyToken, searchSpotify } from '../spotifyService';
import { logger } from '../../lib/logger';
import { lyricsEnrichmentQueue } from '../../lib/queue';

const SPOTIFY_API = 'https://api.spotify.com/v1';

interface SeedResult {
  songsCreated: number;
  songsSkipped: number;
  artistsCreated: number;
  albumsCreated: number;
  lyricsQueued: number;
  errors: number;
}

interface Seeder {
  name: string;
  seed(params: Record<string, any>): Promise<SeedResult>;
}

class SpotifyPlaylistSeeder implements Seeder {
  name = 'spotify-playlist';

  async seed(params: { playlistId: string }): Promise<SeedResult> {
    const token = await getSpotifyToken();
    const res = await fetch(
      `${SPOTIFY_API}/playlists/${params.playlistId}/tracks?limit=100`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Spotify API error: ${res.status}`);
    const data = await res.json();
    return this.seedFromItems(data.items, token);
  }

  async seedFromItems(items: any[], token: string): Promise<SeedResult> {
    const result: SeedResult = { songsCreated: 0, songsSkipped: 0, artistsCreated: 0, albumsCreated: 0, lyricsQueued: 0, errors: 0 };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const track = item.track;
        if (!track || !track.artists?.[0]) continue;

        const artistData = track.artists[0];
        let artist = await prisma.artist.findFirst({ where: { spotifyId: artistData.id } });
        if (!artist) {
          const aRes = await fetch(`${SPOTIFY_API}/artists/${artistData.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const aData = aRes.ok ? await aRes.json() : {};
          artist = await prisma.artist.create({
            data: {
              name: artistData.name,
              spotifyId: artistData.id,
              imageUrl: aData.images?.[0]?.url || null,
              genres: aData.genres || [],
              popularity: aData.popularity || 0,
              followers: aData.followers?.total || 0,
              verified: false,
            },
          });
          result.artistsCreated++;
        }

        const albumData = track.album;
        let albumId: string | undefined;
        if (albumData) {
          let album = await prisma.album.findFirst({ where: { spotifyId: albumData.id } });
          if (!album) {
            album = await prisma.album.create({
              data: {
                name: albumData.name,
                artistId: artist.id,
                spotifyId: albumData.id,
                imageUrl: albumData.images?.[0]?.url || null,
                releaseYear: albumData.release_date
                  ? parseInt(albumData.release_date.substring(0, 4), 10)
                  : null,
                totalTracks: albumData.total_tracks || null,
                popularity: 0,
                genres: [],
              },
            });
            result.albumsCreated++;
          }
          albumId = album.id;
        }

        const existingSong = await prisma.song.findUnique({ where: { spotifyId: track.id } });

        const song = await prisma.song.upsert({
          where: { spotifyId: track.id },
          create: {
            title: track.name,
            artistId: artist.id,
            albumId: albumId || null,
            albumName: albumData?.name || null,
            imageUrl: albumData?.images?.[0]?.url || null,
            spotifyId: track.id,
            spotifyPreviewUrl: track.preview_url || null,
            previewAvailable: !!track.preview_url,
            durationMs: track.duration_ms || null,
            trackNumber: track.track_number || null,
            releaseYear: albumData?.release_date
              ? parseInt(albumData.release_date.substring(0, 4), 10)
              : null,
          },
          update: {},
        });
        if (!existingSong) {
          result.songsCreated++;

          // Auto-enqueue lyrics enrichment for newly created songs.
          // The enrichment pipeline (MusicMatch → LyricFind → Genius) runs async
          // via BullMQ and will populate lyrics, language categorization, and search index.
          try {
            const hasLyrics = await prisma.lyric.findFirst({
              where: { songId: song.id, content: { not: null } },
            });
            if (!hasLyrics) {
              await lyricsEnrichmentQueue.add('enrichLyrics', { songId: song.id }, {
                jobId: `lyrics-enrichment-${song.id}`,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: 1000,
                removeOnFail: 500,
              });
              result.lyricsQueued++;
            }
          } catch (err) {
            // Non-fatal: lyrics enrichment is best-effort during seeding.
            logger.debug({ err, songId: song.id }, 'Failed to enqueue lyrics enrichment');
          }
        } else {
          result.songsSkipped++;
        }

        if ((i + 1) % 10 === 0) {
          logger.info({ progress: `${i + 1}/${items.length}`, ...result }, 'Seeding progress');
        }
      } catch (err) {
        result.errors++;
        logger.error({ err, track: item?.track?.name, index: i }, 'Seeding error');
      }
    }

    logger.info({ ...result }, 'Seeding complete');
    try {
      await redis.del('catalog:homepage:v15');
    } catch {
      // Cache invalidation is best-effort.
    }
    return result;
  }
}

class SpotifyGenreSeeder implements Seeder {
  name = 'spotify-genre';

  async seed(params: { genre: string; limit?: number }): Promise<SeedResult> {
    const token = await getSpotifyToken();
    const requestedLimit = params.limit || 100;
    const pageSize = 50;
    const dedupedTracks = new Map<string, any>();

    for (let offset = 0; dedupedTracks.size < requestedLimit; offset += pageSize) {
      const batchLimit = Math.min(pageSize, requestedLimit - dedupedTracks.size);
      const res = await fetch(
        `${SPOTIFY_API}/search?q=genre:${encodeURIComponent(params.genre)}&type=track&limit=${batchLimit}&offset=${offset}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!res.ok) {
        throw new Error(`Spotify API error: ${res.status}`);
      }

      const data = await res.json();
      const tracks = data?.tracks?.items || [];
      if (!tracks.length) {
        break;
      }

      for (const track of tracks) {
        if (track?.id) {
          dedupedTracks.set(track.id, track);
        }
      }

      if (tracks.length < batchLimit) {
        break;
      }
    }

    if (!dedupedTracks.size) {
      throw new Error(`No tracks found for genre: ${params.genre}`);
    }

    const items = Array.from(dedupedTracks.values())
      .slice(0, requestedLimit)
      .map((t: any) => ({ track: t }));

    const playlistSeeder = new SpotifyPlaylistSeeder();
    return playlistSeeder.seedFromItems(items, token);
  }
}

// FirebaseImporter available when scripts/migrateFromFirebase is moved under src/
// import { migrateFromFirebase } from '../../scripts/migrateFromFirebase';

/**
 * Curated African Playlist Seeder.
 *
 * Imports tracks from a batch of curated African Spotify playlists.
 * Fetches up to 100 tracks per playlist with full pagination support.
 * Designed for one-time bulk catalog population.
 */
class CuratedAfricanPlaylistSeeder implements Seeder {
  name = 'curated-african';

  /**
   * Default curated African playlists spanning multiple genres and regions.
   * Each entry is a Spotify playlist ID.
   */
  static readonly DEFAULT_PLAYLISTS = [
    // Afrobeats
    '37i9dQZF1DX70RN3TfWWJh', // Afrobeats Hits
    '37i9dQZF1DX48TUlHJFJQy', // African Heat
    // Amapiano
    '37i9dQZF1DWYn5uZTUxl32', // Amapiano Grooves
    '37i9dQZF1DWZFmyF5TOM5K', // Amapiano Africa
    // Bongo Flava / East Africa
    '37i9dQZF1DX7Q6hK1gDMcS', // Bongo Flava
    '37i9dQZF1DX9tPFwDMEDy1', // Africa Rising
    // Highlife / West Africa
    '37i9dQZF1DX1lVhptIYRsa', // Highlife classics
    // Afro Fusion
    '37i9dQZF1DXcFwqoL3JWZR', // Afro Fusion
    // Dancehall / Caribbean-African
    '37i9dQZF1DX0SM0LYsmbmt', // Dancehall Official
    // R&B with African artists
    '37i9dQZF1DWVqJMsg4Crbp', // African R&B
    // Hip-Hop with African artists
    '37i9dQZF1DX4dyzvuaRJ0n', // African Hip-Hop
    // Alt / Alternative African
    '37i9dQZF1DWYn5uZTUxl32', // Alt Africa
  ];

  async seed(params: { playlistIds?: string[]; limitPerPlaylist?: number }): Promise<SeedResult> {
    const token = await getSpotifyToken();
    const playlistIds = params.playlistIds?.length
      ? params.playlistIds
      : CuratedAfricanPlaylistSeeder.DEFAULT_PLAYLISTS;
    const limitPerPlaylist = params.limitPerPlaylist || 100;

    const result: SeedResult = {
      songsCreated: 0,
      songsSkipped: 0,
      artistsCreated: 0,
      albumsCreated: 0,
      lyricsQueued: 0,
      errors: 0,
    };

    const playlistSeeder = new SpotifyPlaylistSeeder();

    for (let i = 0; i < playlistIds.length; i++) {
      const playlistId = playlistIds[i];
      logger.info({ playlistId, progress: `${i + 1}/${playlistIds.length}` }, 'Importing curated playlist');

      try {
        // Fetch playlist tracks with pagination
        const allTracks: any[] = [];
        let offset = 0;
        const pageSize = 100;

        while (allTracks.length < limitPerPlaylist) {
          const res = await fetch(
            `${SPOTIFY_API}/playlists/${playlistId}/tracks?limit=${Math.min(pageSize, limitPerPlaylist - allTracks.length)}&offset=${offset}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );

          if (!res.ok) {
            logger.warn({ playlistId, status: res.status }, 'Failed to fetch playlist — skipping');
            break;
          }

          const data = await res.json();
          const items = data.items || [];
          if (!items.length) break;

          allTracks.push(...items);
          offset += items.length;

          if (!data.next || allTracks.length >= limitPerPlaylist) break;

          // Respect rate limits
          await new Promise((r) => setTimeout(r, 200));
        }

        if (allTracks.length > 0) {
          const playlistResult = await playlistSeeder.seedFromItems(
            allTracks.slice(0, limitPerPlaylist),
            token,
          );
          result.songsCreated += playlistResult.songsCreated;
          result.songsSkipped += playlistResult.songsSkipped;
          result.artistsCreated += playlistResult.artistsCreated;
          result.albumsCreated += playlistResult.albumsCreated;
          result.lyricsQueued += playlistResult.lyricsQueued;
          result.errors += playlistResult.errors;
        }

        logger.info(
          { playlistId, tracksFound: allTracks.length, ...result },
          'Playlist import complete',
        );
      } catch (err) {
        result.errors++;
        logger.error({ err, playlistId }, 'Curated playlist import error');
      }

      // Rate limit between playlists
      if (i < playlistIds.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    logger.info({ ...result }, 'Curated African seeding complete');
    try {
      await redis.del('catalog:homepage:v15');
    } catch {
      // Cache invalidation is best-effort.
    }
    return result;
  }
}

/**
 * Genre Discovery Seeder.
 *
 * Searches Spotify for each target genre and imports the top tracks.
 * Each genre query returns up to `limit` unique tracks, deduplicated by Spotify ID.
 */
class GenreDiscoverySeeder implements Seeder {
  name = 'genre-discovery';

  /**
   * Target African genres for catalog population.
   */
  static readonly TARGET_GENRES = [
    'afrobeats',
    'amapiano',
    'afropop',
    'afro fusion',
    'highlife',
    'r&b',
    'hip-hop',
    'banku',
    'dancehall',
    'alternative',
  ];

  async seed(params: { genres?: string[]; limitPerGenre?: number }): Promise<SeedResult> {
    const genres = params.genres?.length ? params.genres : GenreDiscoverySeeder.TARGET_GENRES;
    const limitPerGenre = params.limitPerGenre || 50;

    const result: SeedResult = {
      songsCreated: 0,
      songsSkipped: 0,
      artistsCreated: 0,
      albumsCreated: 0,
      lyricsQueued: 0,
      errors: 0,
    };

    const genreSeeder = new SpotifyGenreSeeder();

    for (let i = 0; i < genres.length; i++) {
      const genre = genres[i];
      logger.info({ genre, progress: `${i + 1}/${genres.length}` }, 'Discovering genre tracks');

      try {
        const genreResult = await genreSeeder.seed({ genre, limit: limitPerGenre });
        result.songsCreated += genreResult.songsCreated;
        result.songsSkipped += genreResult.songsSkipped;
        result.artistsCreated += genreResult.artistsCreated;
        result.albumsCreated += genreResult.albumsCreated;
        result.lyricsQueued += genreResult.lyricsQueued;
        result.errors += genreResult.errors;

        logger.info({ genre, ...genreResult }, 'Genre discovery complete');
      } catch (err) {
        result.errors++;
        logger.error({ err, genre }, 'Genre discovery error');
      }

      // Rate limit between genres
      if (i < genres.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    logger.info({ ...result }, 'Genre discovery seeding complete');
    try {
      await redis.del('catalog:homepage:v15');
    } catch {
      // Cache invalidation is best-effort.
    }
    return result;
  }
}

class ManualSeeder implements Seeder {
  name = 'manual';

  /**
   * Seed songs manually. Duplicate detection uses the @@unique([title, artistId])
   * constraint to prevent re-inserting existing songs. After creation, Spotify IDs
   * are backfilled via Spotify search for songs missing a spotifyId, and lyrics
   * enrichment is auto-enqueued.
   */
  async seed(params: { songs: Array<{ artist: string; title: string; lyrics?: string; genre?: string }> }): Promise<SeedResult> {
    const result: SeedResult = { songsCreated: 0, songsSkipped: 0, artistsCreated: 0, albumsCreated: 0, lyricsQueued: 0, errors: 0 };

    for (const item of params.songs) {
      try {
        let artist = await prisma.artist.findFirst({ where: { name: item.artist } });
        if (!artist) {
          artist = await prisma.artist.create({
            data: { name: item.artist, genres: item.genre ? [item.genre] : [], verified: false },
          });
          result.artistsCreated++;
        }

        // Duplicate detection via @@unique([title, artistId])
        const existingSong = await prisma.song.findFirst({
          where: { title: item.title, artistId: artist.id },
        });
        if (existingSong) {
          result.songsSkipped++;
          continue;
        }

        const song = await prisma.song.create({
          data: { title: item.title, artistId: artist.id },
        });

        // Auto-provision lyrics if provided
        if (item.lyrics) {
          await prisma.lyric.create({
            data: {
              songId: song.id,
              content: item.lyrics,
              sourceProvider: 'MANUAL',
              licenseStatus: 'UNKNOWN',
            },
          });
        }

        // Spotify ID backfill for manual imports (best-effort).
        // Spotify imports already carry a spotifyId; this covers songs added
        // via manual entry or other non-Spotify pathways.
        try {
          const match = await searchSpotify(`${item.artist} ${item.title}`, 'track', 1);
          const track = match.tracks?.items?.[0];
          if (track) {
            await prisma.song.update({
              where: { id: song.id },
              data: {
                spotifyId: track.id,
                spotifyPreviewUrl: track.preview_url || null,
                previewAvailable: !!track.preview_url,
                durationMs: track.duration_ms || null,
                imageUrl: track.album?.images?.[0]?.url || null,
              },
            });
          }
        } catch {
          // Non-fatal: backfill is best-effort during seeding.
        }

        // Enqueue lyrics enrichment if no lyrics were provided
        if (!item.lyrics) {
          try {
            await lyricsEnrichmentQueue.add('enrichLyrics', { songId: song.id }, {
              jobId: `lyrics-enrichment-${song.id}`,
              attempts: 3,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: 1000,
              removeOnFail: 500,
            });
            result.lyricsQueued++;
          } catch {
            // Non-fatal: lyrics enrichment is best-effort during seeding.
          }
        }

        result.songsCreated++;
      } catch (err) {
        result.errors++;
        logger.error({ err, item }, 'Manual seeding error');
      }
    }

    logger.info({ ...result }, 'Manual seeding complete');
    return result;
  }
}

class CatalogSeeder {
  private seeders: Map<string, Seeder> = new Map();
  private lastSeedResult: SeedResult | null = null;
  private lastSeedAt: Date | null = null;

  constructor() {
    this.register(new SpotifyPlaylistSeeder());
    this.register(new SpotifyGenreSeeder());
    this.register(new CuratedAfricanPlaylistSeeder());
    this.register(new GenreDiscoverySeeder());
    this.register(new ManualSeeder());
  }

  private register(seeder: Seeder): void {
    this.seeders.set(seeder.name, seeder);
  }

  getAvailableSeeders(): string[] {
    return Array.from(this.seeders.keys());
  }

  getStatus(): { lastSeed: Date | null; lastResult: SeedResult | null; availableSeeders: string[] } {
    return {
      lastSeed: this.lastSeedAt,
      lastResult: this.lastSeedResult,
      availableSeeders: this.getAvailableSeeders(),
    };
  }

  async run(source: string, params: Record<string, any>): Promise<SeedResult> {
    const seeder = this.seeders.get(source);
    if (!seeder) throw new Error(`Unknown seeder: ${source}. Available: ${this.getAvailableSeeders().join(', ')}`);

    logger.info({ source, params }, 'Running seeder');
    const result = await seeder.seed(params);
    this.lastSeedResult = result;
    this.lastSeedAt = new Date();

    try {
      await redis.del('catalog:homepage:v15');
    } catch {
      // Cache invalidation is best-effort.
    }
    return result;
  }
}

export const catalogSeeder = new CatalogSeeder();
