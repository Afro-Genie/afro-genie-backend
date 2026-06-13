import { LicenseStatus, LyricSourceProvider } from '@prisma/client';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getActiveProvider } from './translationService';

export interface LyricsInput {
  rawText?: string;
  lineBreaks?: string[];
}

const CHUNK_SIZE = 600;
const MIN_LANGUAGE_PERCENTAGE = 30;

const normalizeLyricsContent = (lyrics: LyricsInput): string => {
  if (lyrics.rawText && lyrics.rawText.trim().length > 0) {
    return lyrics.rawText.trim();
  }

  if (Array.isArray(lyrics.lineBreaks) && lyrics.lineBreaks.length > 0) {
    return lyrics.lineBreaks.join('\n').trim();
  }

  return '';
};

const splitIntoChunks = (text: string, maxChars = CHUNK_SIZE): string[] => {
  if (!text.trim()) {
    return [];
  }

  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    const nextCandidate = current ? `${current}\n${line}` : line;
    if (nextCandidate.length <= maxChars) {
      current = nextCandidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (line.length <= maxChars) {
      current = line;
      continue;
    }

    for (let i = 0; i < line.length; i += maxChars) {
      chunks.push(line.slice(i, i + maxChars));
    }
    current = '';
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
};

export const upsertLyrics = async (songId: string, lyrics: LyricsInput): Promise<void> => {
  const content = normalizeLyricsContent(lyrics);
  if (!content) {
    return;
  }

  await prisma.lyric.create({
    data: {
      songId,
      content,
      sourceProvider: LyricSourceProvider.MANUAL,
      licenseStatus: LicenseStatus.UNKNOWN,
    },
  });
};

export const takedownLyrics = async (songId: string): Promise<number> => {
  const result = await prisma.$executeRaw`
    UPDATE "Lyric"
    SET "content" = NULL,
        "licenseStatus" = 'TAKEDOWN',
        "updatedAt" = NOW()
    WHERE "songId" = ${songId}
  `;

  return Number(result ?? 0);
};

export const categorizeSongLanguages = async (songId: string, content?: string | null): Promise<void> => {
  const lyricsText = (content ?? '').trim();
  if (!lyricsText) {
    return;
  }

  const chunks = splitIntoChunks(lyricsText);
  if (chunks.length === 0) {
    return;
  }

  const provider = getActiveProvider();
  const counts = new Map<string, number>();

  for (const chunk of chunks) {
    try {
      const result = await provider.detectLanguage(chunk);
      const languageCode = result.languageCode.trim().toLowerCase();
      if (!languageCode) {
        continue;
      }
      counts.set(languageCode, (counts.get(languageCode) ?? 0) + 1);
    } catch (error) {
      logger.warn({ err: error, songId }, 'Language detection failed for a lyrics chunk');
    }
  }

  if (counts.size === 0) {
    return;
  }

  const total = chunks.length;

  for (const [languageCode, count] of counts.entries()) {
    const percentage = Number(((count / total) * 100).toFixed(2));
    if (percentage < MIN_LANGUAGE_PERCENTAGE) {
      continue;
    }

    await prisma.language.upsert({
      where: { code: languageCode },
      create: { code: languageCode, name: languageCode.toUpperCase() },
      update: {},
    });

    await prisma.songLanguage.upsert({
      where: { songId_languageCode: { songId, languageCode } },
      create: { songId, languageCode, percentage },
      update: { percentage },
    });
  }
};

export const getLatestLyricsContent = async (songId: string): Promise<string | null> => {
  const lyric = await prisma.lyric.findFirst({
    where: {
      songId,
      licenseStatus: { not: LicenseStatus.TAKEDOWN },
    },
    orderBy: { createdAt: 'desc' },
    select: { content: true },
  });

  const content = (lyric as { content?: string | null } | null)?.content;
  return content ?? null;
};
