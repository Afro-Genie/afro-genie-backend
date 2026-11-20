import type { LyricsSearchResult } from './lyricsProvider';

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\[[^\]]*(?:official|video|audio|lyrics?)[^\]]*\]/g, ' ')
    .replace(/\([^)]*(?:official|video|audio|lyrics?)[^)]*\)/g, ' ')
    .replace(/\s+(?:feat(?:uring)?|ft)\.?\s+.*$/i, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function containsArtist(candidateArtist: string, expectedArtist: string): boolean {
  return candidateArtist === expectedArtist
    || candidateArtist.startsWith(`${expectedArtist} `)
    || candidateArtist.includes(` ${expectedArtist} `)
    || candidateArtist.endsWith(` ${expectedArtist}`);
}

export function findBestLyricsMatch(
  results: readonly LyricsSearchResult[],
  artist: string,
  title: string,
): LyricsSearchResult | null {
  const expectedArtist = normalizeText(artist);
  const expectedTitle = normalizeText(title);
  if (!expectedArtist || !expectedTitle) return null;

  const matches = results.filter((result) =>
    normalizeText(result.title) === expectedTitle
    && containsArtist(normalizeText(result.artist), expectedArtist),
  );
  return matches.find((result) => normalizeText(result.artist) === expectedArtist) ?? matches[0] ?? null;
}

export function plainLyricsFromSyncedLyrics(syncedLyrics: string): string {
  return syncedLyrics
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[(?:\d{1,2}:)?\d{2}:\d{2}(?:[.:]\d{1,3})?\]\s*/, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
