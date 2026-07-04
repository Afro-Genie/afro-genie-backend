import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { getSpotifyToken } from '../spotifyService';
import { logger } from '../../lib/logger';

const SPOTIFY_API = 'https://api.spotify.com/v1';

interface SeedResult {
  songsCreated: number;
  artistsCreated: number;
  albumsCreated: number;
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
    const result: SeedResult = { songsCreated: 0, artistsCreated: 0, albumsCreated: 0, errors: 0 };

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

        await prisma.song.upsert({
          where: { spotifyId: track.id },
          create: {
            title: track.name,
            artistId: artist.id,
            albumId: albumId || null,
            albumName: albumData?.name || null,
            imageUrl: albumData?.images?.[0]?.url || null,
            spotifyId: track.id,
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
      await redis.del('catalog:homepage');
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
    const requestedLimit = params.limit || 50;
    const pageSize = 10;
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

class ManualSeeder implements Seeder {
  name = 'manual';

  async seed(params: { songs: Array<{ artist: string; title: string; lyrics?: string; genre?: string }> }): Promise<SeedResult> {
    const result: SeedResult = { songsCreated: 0, artistsCreated: 0, albumsCreated: 0, errors: 0 };

    for (const item of params.songs) {
      try {
        let artist = await prisma.artist.findFirst({ where: { name: item.artist } });
        if (!artist) {
          artist = await prisma.artist.create({
            data: { name: item.artist, genres: item.genre ? [item.genre] : [], verified: false },
          });
          result.artistsCreated++;
        }

        const existingSong = await prisma.song.findFirst({
          where: { title: item.title, artistId: artist.id },
        });
        if (existingSong) continue;

        const song = await prisma.song.create({
          data: { title: item.title, artistId: artist.id },
        });

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
      await redis.del('catalog:homepage');
    } catch {
      // Cache invalidation is best-effort.
    }
    return result;
  }
}

export const catalogSeeder = new CatalogSeeder();
