import type { Job } from 'bullmq';
import { languageCategorizationQueue } from '../lib/queue';
import { logger } from '../lib/logger';
import { categorizeSongLanguages, getLatestLyricsContent } from '../services/lyricsService';

export interface LanguageCategorizationJobData {
  songId: string;
  content?: string;
}

const jobOptions = {
  removeOnComplete: 1000,
  removeOnFail: 500,
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1000,
  },
};

export const enqueueLanguageCategorization = async (songId: string, content?: string) => {
  return languageCategorizationQueue.add(
    'categorizeSongLanguage',
    { songId, content },
    jobOptions,
  );
};

export const processLanguageCategorizationJob = async (
  job: Job<LanguageCategorizationJobData>,
): Promise<void> => {
  const songId = job.data.songId;
  const content = job.data.content ?? (await getLatestLyricsContent(songId));

  if (!content) {
    logger.info({ songId }, 'Skipping language categorization because no lyrics were found');
    return;
  }

  await categorizeSongLanguages(songId, content);
};
