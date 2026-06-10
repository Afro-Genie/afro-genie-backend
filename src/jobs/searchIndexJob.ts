import type { Job } from 'bullmq';
import { searchIndexQueue } from '../lib/queue';
import { logger } from '../lib/logger';
import {
  bulkIndex,
  deleteSong,
  indexArtist,
  indexSong,
  refreshGenre
} from '../services/searchService';

type IndexSongData = { songId: string };
type IndexArtistData = { artistId: string };
type DeleteSongData = { songId: string };
type RefreshGenreData = { genreId: string };

export type SearchIndexJobName = 'indexSong' | 'indexArtist' | 'deleteSong' | 'bulkIndex' | 'refreshGenre';

type SearchIndexJobData = IndexSongData | IndexArtistData | DeleteSongData | RefreshGenreData | Record<string, never>;

const defaultJobOptions = {
  removeOnComplete: 1000,
  removeOnFail: 500,
  timeout: 5000,
  attempts: 5,
  backoff: {
    type: 'exponential' as const,
    delay: 500
  }
};

export const enqueueIndexSong = async (songId: string) => {
  return searchIndexQueue.add('indexSong', { songId }, defaultJobOptions);
};

export const enqueueIndexArtist = async (artistId: string) => {
  return searchIndexQueue.add('indexArtist', { artistId }, defaultJobOptions);
};

export const enqueueDeleteSong = async (songId: string) => {
  return searchIndexQueue.add('deleteSong', { songId }, defaultJobOptions);
};

export const enqueueBulkIndex = async () => {
  return searchIndexQueue.add('bulkIndex', {}, { ...defaultJobOptions, priority: 1 });
};

export const enqueueRefreshGenre = async (genreId: string) => {
  return searchIndexQueue.add('refreshGenre', { genreId }, defaultJobOptions);
};

export const processSearchIndexJob = async (job: Job<SearchIndexJobData, unknown, string>) => {
  switch (job.name as SearchIndexJobName) {
    case 'indexSong': {
      const data = job.data as IndexSongData;
      await indexSong(data.songId);
      return;
    }
    case 'indexArtist': {
      const data = job.data as IndexArtistData;
      await indexArtist(data.artistId);
      return;
    }
    case 'deleteSong': {
      const data = job.data as DeleteSongData;
      await deleteSong(data.songId);
      return;
    }
    case 'bulkIndex': {
      await bulkIndex();
      return;
    }
    case 'refreshGenre': {
      const data = job.data as RefreshGenreData;
      await refreshGenre(data.genreId);
      return;
    }
    default: {
      logger.warn({ jobName: job.name }, 'Unknown search index job name received');
    }
  }
};
