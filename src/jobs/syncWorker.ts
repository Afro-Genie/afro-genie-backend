import type { Job } from 'bullmq';
import { logger } from '../lib/logger';
import {
  syncArtistMetadata,
  syncArtistAlbums,
  syncArtistFull,
  syncAllArtists,
  refreshStaleArtists,
  syncGenres,
  syncPopularTracks,
  syncNewReleases,
  syncGenreDiscovery,
  backfillMissingLyrics,
  backfillArtistLastFm,
  enrichArtistLastFm,
} from '../services/syncEngine';

export type SyncJobType = 'artist' | 'artist-albums' | 'artist-full' | 'sync-all' | 'refresh-stale' | 'sync-genres' | 'sync-popular-tracks' | 'sync-new-releases' | 'sync-genre-discovery' | 'curated-playlists' | 'backfill-lyrics' | 'backfill-artists-lastfm' | 'enrich-artist-lastfm';

export interface SyncJobData {
  type: SyncJobType;
  artistId?: string;
}

export const processSyncJob = async (job: Job<SyncJobData>): Promise<unknown> => {
  const { type, artistId } = job.data;

  logger.info({ jobId: job.id, type, artistId }, 'Processing sync job');

  switch (type) {
    case 'artist': {
      if (!artistId) {
        throw new Error('artistId is required for artist sync job');
      }
      await job.updateProgress({ stage: 'metadata', current: 0, total: 1 });
      const result = await syncArtistMetadata(artistId);
      await job.updateProgress({ stage: 'metadata', current: 1, total: 1 });
      return result;
    }
    case 'artist-albums': {
      if (!artistId) {
        throw new Error('artistId is required for artist-albums sync job');
      }
      await job.updateProgress({ stage: 'albums', current: 0, total: 1 });
      const result = await syncArtistAlbums(artistId);
      await job.updateProgress({ stage: 'albums', current: 1, total: 1 });
      return result;
    }
    case 'artist-full': {
      if (!artistId) {
        throw new Error('artistId is required for artist-full sync job');
      }
      await job.updateProgress({ stage: 'full', current: 0, total: 1 });
      const result = await syncArtistFull(artistId);
      await job.updateProgress({ stage: 'full', current: 1, total: 1 });
      return result;
    }
    case 'sync-all': {
      return syncAllArtists((completed, total) => {
        void job.updateProgress({ stage: 'sync-all', current: completed, total });
      });
    }
    case 'refresh-stale': {
      return refreshStaleArtists((completed, total) => {
        void job.updateProgress({ stage: 'refresh-stale', current: completed, total });
      });
    }
    case 'sync-genres': {
      await job.updateProgress({ stage: 'sync-genres', current: 0, total: 1 });
      const result = await syncGenres();
      await job.updateProgress({ stage: 'sync-genres', current: 1, total: 1 });
      return result;
    }
    case 'sync-popular-tracks': {
      return syncPopularTracks((completed, total) => {
        void job.updateProgress({ stage: 'sync-popular-tracks', current: completed, total });
      });
    }
    case 'sync-new-releases': {
      return syncNewReleases();
    }
    case 'sync-genre-discovery': {
      return syncGenreDiscovery();
    }
    case 'curated-playlists': {
      const { catalogSeeder } = await import('../services/seeder/catalogSeeder.js');
      return catalogSeeder.run('curated-african', {
        skipPlaylists: false,
        skipGenres: true,
        limitPerPlaylist: 100,
      });
    }
    case 'backfill-lyrics': {
      return backfillMissingLyrics((completed, total) => {
        void job.updateProgress({ stage: 'backfill-lyrics', current: completed, total });
      });
    }
    case 'backfill-artists-lastfm': {
      return backfillArtistLastFm((completed, total) => {
        void job.updateProgress({ stage: 'backfill-artists-lastfm', current: completed, total });
      });
    }
    case 'enrich-artist-lastfm': {
      if (!artistId) {
        throw new Error('artistId is required for enrich-artist-lastfm job');
      }
      await job.updateProgress({ stage: 'enrich-artist-lastfm', current: 0, total: 1 });
      const result = await enrichArtistLastFm(artistId);
      await job.updateProgress({ stage: 'enrich-artist-lastfm', current: 1, total: 1 });
      return result;
    }
    default: {
      throw new Error(`Unknown sync job type: ${String(type)}`);
    }
  }
};
