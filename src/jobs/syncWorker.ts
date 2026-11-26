import type { Job } from 'bullmq';
import { logger } from '../lib/logger';
import {
  backfillMissingLyrics,
  backfillArtistLastFm,
  enrichArtistLastFm,
} from '../services/syncStatusService';
import { processLibraryEnrichmentJob } from './libraryEnrichmentJob';
import { enrichSongLyrics } from './lyricsEnrichmentJob';
import { getSongsNeedingLyrics } from '../services/lyricsBackfillService';
import {
  enrichArtistGenres,
  enrichSongGenres,
  getGenreBackfillTargets,
  type GenreBackfillScope,
  type GenreBackfillTarget,
} from '../services/genreBackfillService';

export type SyncJobType =
  | 'backfill-lyrics'
  | 'backfill-artists-lastfm'
  | 'enrich-artist-lastfm'
  | 'library-enrichment'
  | 'admin-lyrics-backfill'
  | 'admin-genre-backfill'
  | 'genre-enrichment';

export interface SyncJobData {
  type: SyncJobType;
  artistId?: string;
  songId?: string;
  adminId?: string;
  previewHash?: string;
  requestId?: string;
  songIds?: string[];
  scope?: 'new' | 'missed';
  genreScope?: GenreBackfillScope;
  targets?: GenreBackfillTarget[];
}

const GENRE_TARGET_TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Genre backfill target timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export const processSyncJob = async (job: Job<SyncJobData>): Promise<unknown> => {
  const { type, artistId } = job.data;

  logger.info({ jobId: job.id, type, artistId }, 'Processing sync job');

  switch (type) {
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
    case 'library-enrichment': {
      return processLibraryEnrichmentJob(job);
    }
    case 'admin-lyrics-backfill': {
      if (!job.data.adminId || !job.data.previewHash || !job.data.requestId || !Array.isArray(job.data.songIds)) {
        throw new Error('Admin lyrics backfill job is missing its attribution or reviewed candidate list');
      }

      const result = {
        total: job.data.songIds.length,
        completed: 0,
        providerHits: 0,
        providerMisses: 0,
        failed: 0,
        populated: 0,
        skipped: 0,
        remaining: 0,
        scope: job.data.scope ?? 'new',
        failures: [] as Array<{ songId: string; title: string; message: string }>,
      };

      const songTitles = new Map((await getSongsNeedingLyrics()).map((song) => [song.id, song.title]));
      for (const songId of job.data.songIds) {
        try {
          const outcome = await enrichSongLyrics(songId);
          if (outcome === 'populated') {
            result.providerHits += 1;
            result.populated += 1;
          } else if (outcome === 'miss') {
            result.providerMisses += 1;
          } else {
            result.skipped += 1;
          }
        } catch (error) {
          result.failed += 1;
          if (result.failures.length < 100) {
            result.failures.push({
              songId,
              title: songTitles.get(songId) || songId,
              message: error instanceof Error ? error.message : 'Lyrics provider or persistence failed.',
            });
          }
          logger.error({ err: error, songId, jobId: job.id }, 'Lyrics backfill candidate failed');
        }

        result.completed += 1;
        await job.updateProgress({
          stage: 'lyrics-backfill',
          ...result,
        });
      }

      result.remaining = (await getSongsNeedingLyrics(job.data.scope ?? 'new')).length;
      await job.updateProgress({
        stage: 'lyrics-backfill',
        ...result,
      });
      return result;
    }
    case 'genre-enrichment': {
      if (job.data.songId) {
        return enrichSongGenres(job.data.songId);
      }
      if (job.data.artistId) {
        return enrichArtistGenres(job.data.artistId);
      }
      throw new Error('genre-enrichment requires songId or artistId');
    }
    case 'admin-genre-backfill': {
      if (!job.data.adminId || !job.data.previewHash || !job.data.requestId || !Array.isArray(job.data.targets)) {
        throw new Error('Admin genre backfill job is missing its attribution or reviewed candidate list');
      }

      const scope = job.data.genreScope ?? 'missing';
      const result = {
        total: job.data.targets.length,
        completed: 0,
        providerHits: 0,
        providerMisses: 0,
        failed: 0,
        populated: 0,
        skipped: 0,
        remaining: 0,
        scope,
        failures: [] as Array<{ targetId: string; title: string; message: string }>,
      };
      const labels = new Map(job.data.targets.map((target) => [`${target.kind}:${target.id}`, `${target.label} (${target.secondaryLabel})`]));

      for (const target of job.data.targets) {
        const targetLabel = labels.get(`${target.kind}:${target.id}`) || target.label;
        await job.updateProgress({ stage: 'genre-backfill', currentTarget: targetLabel, ...result });
        try {
          const outcome = await withTimeout(
            target.kind === 'song'
              ? enrichSongGenres(target.id, scope === 'all')
              : enrichArtistGenres(target.id, scope === 'all'),
            GENRE_TARGET_TIMEOUT_MS,
          );
          if (outcome === 'populated') {
            result.providerHits += 1;
            result.populated += 1;
          } else if (outcome === 'miss') {
            result.providerMisses += 1;
          } else if (outcome === 'already-populated') {
            result.skipped += 1;
          }
        } catch (error) {
          result.failed += 1;
          if (result.failures.length < 100) {
            result.failures.push({
              targetId: target.id,
              title: targetLabel,
              message: error instanceof Error ? error.message : 'Genre provider or persistence failed.',
            });
          }
          logger.error({ err: error, targetId: target.id, jobId: job.id }, 'Genre backfill target failed');
        }

        result.completed += 1;
        await job.updateProgress({ stage: 'genre-backfill', currentTarget: null, ...result });
      }

      result.remaining = (await getGenreBackfillTargets(scope)).length;
      await job.updateProgress({ stage: 'genre-backfill', currentTarget: null, ...result });
      return result;
    }
    default: {
      throw new Error(`Unknown sync job type: ${String(type)}`);
    }
  }
};