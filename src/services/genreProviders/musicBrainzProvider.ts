import { env } from '../../lib/env';
import { classifyAfricanGenres } from '../youtubeCatalogPolicy';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const REQUEST_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15000;
const RETRYABLE_STATUSES = new Set([429, 503]);

const EXTRA_GENRE_ALIASES: Readonly<Record<string, string>> = {
  'afro pop': 'Afropop',
  'afro pop music': 'Afropop',
  'african pop': 'Afropop',
  'african popular music': 'Afropop',
  'afro fusion': 'Afro-fusion',
  'afro r and b': 'Afro-R&B',
  'afro r b': 'Afro-R&B',
  'african r and b': 'Afro-R&B',
  'african hip hop': 'African Hip-Hop',
  'african hiphop': 'African Hip-Hop',
  'afro hip hop': 'African Hip-Hop',
  'afro hiphop': 'African Hip-Hop',
  'afro rap': 'African Hip-Hop',
  'african rap': 'African Hip-Hop',
  'naija hip hop': 'African Hip-Hop',
  'nigerian hip hop': 'African Hip-Hop',
  'naija rap': 'African Hip-Hop',
  'nigerian rap': 'African Hip-Hop',
  'afro dancehall': 'Dancehall',
  'african dancehall': 'Dancehall',
  'ghanaian dancehall': 'Dancehall',
  'naija dancehall': 'Dancehall',
  'nigerian dancehall': 'Dancehall',
  'south african dancehall': 'Dancehall',
  'dance hall': 'Dancehall',
  'afro tech': 'Afro-house',
  'south african house': 'Afro-house',
};

type JsonRecord = Record<string, unknown>;

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

interface RecordingCandidate {
  id: string;
  title: string;
  artistName: string;
  score: number;
  releaseTitles: string[];
}

interface ArtistCandidate {
  id: string;
  name: string;
  score: number;
}

export interface SongGenreLookup {
  musicBrainzId: string;
  artistMusicBrainzId: string | null;
  genres: string[];
  artistGenres: string[];
}

export interface ArtistGenreLookup {
  musicBrainzId: string;
  genres: string[];
}

let nextRequestAt = 0;
const cache = new Map<string, CacheEntry>();

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function canonicalizeGenreBackfillTags(values: readonly string[]): string[] {
  const raw = values.map((value) => value.trim()).filter(Boolean);
  const policyGenres = classifyAfricanGenres(raw);
  const extraGenres = raw
    .map(normalizeText)
    .map((value) => EXTRA_GENRE_ALIASES[value])
    .filter((value): value is string => Boolean(value));
  return [...new Set([...policyGenres, ...extraGenres])].slice(0, 4);
}

function readTags(value: unknown): Array<{ name: string; count: number }> {
  return asArray(value)
    .map((entry) => {
      const count = isRecord(entry) && typeof entry.count === 'number' ? entry.count : 0;
      if (typeof entry === 'string') return { name: entry, count };
      if (!isRecord(entry)) return null;
      const genre = entry.genre;
      const tag = entry.tag;
      const genreName = isRecord(genre) ? asString(genre.name) : null;
      const tagName = isRecord(tag) ? asString(tag.name) : null;
      const name = genreName ?? tagName ?? asString(genre) ?? asString(tag) ?? asString(entry.name);
      return name ? { name, count } : null;
    })
    .filter((entry): entry is { name: string; count: number } => entry !== null)
    .sort((a, b) => b.count - a.count);
}

function readPrimaryArtistName(value: unknown): string {
  const credits = asArray(value);
  for (const credit of credits) {
    if (!isRecord(credit)) continue;
    const name = asString(credit.name) ?? asString(isRecord(credit.artist) ? credit.artist.name : null);
    if (name) return name;
  }
  return '';
}

function readPrimaryArtistId(value: unknown): string | null {
  const credits = asArray(value);
  for (const credit of credits) {
    if (!isRecord(credit)) continue;
    const artist = isRecord(credit.artist) ? credit.artist : null;
    const id = artist ? asString(artist.id) : null;
    if (id) return id;
  }
  return null;
}

function readArtistGenres(value: unknown): string[] {
  const credits = asArray(value);
  const names: string[] = [];
  for (const credit of credits) {
    if (!isRecord(credit)) continue;
    const artist = isRecord(credit.artist) ? credit.artist : null;
    names.push(...readTags(artist?.genres).map((entry) => entry.name));
  }
  return names;
}

function readReleaseTitles(value: unknown): string[] {
  return asArray(value)
    .map((release) => {
      if (!isRecord(release)) return null;
      return asString(release.title) ?? asString(isRecord(release['release-group']) ? release['release-group'].title : null);
    })
    .filter((title): title is string => title !== null);
}

async function throttle(): Promise<void> {
  const waitMs = Math.max(0, nextRequestAt - Date.now());
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  nextRequestAt = Date.now() + env.MUSICBRAINZ_REQUEST_INTERVAL_MS;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(Math.max(seconds * 1000, RETRY_BASE_DELAY_MS), RETRY_MAX_DELAY_MS);
    }
    const retryAt = Date.parse(retryAfter);
    if (!Number.isNaN(retryAt)) {
      return Math.min(Math.max(retryAt - Date.now(), RETRY_BASE_DELAY_MS), RETRY_MAX_DELAY_MS);
    }
  }
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
}

async function request(path: string, params: Record<string, string>): Promise<JsonRecord> {
  const url = new URL(`${env.MUSICBRAINZ_API_URL.replace(/\/$/, '')}${path}`);
  url.searchParams.set('fmt', 'json');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    await throttle();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'User-Agent': env.MUSICBRAINZ_USER_AGENT,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        if (RETRYABLE_STATUSES.has(response.status) && attempt < REQUEST_ATTEMPTS - 1) {
          const delay = retryDelayMs(response, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(`MusicBrainz request failed with ${response.status}`);
      }
      return (await response.json()) as JsonRecord;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('MusicBrainz request failed after retries');
}

async function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    return existing.value as T;
  }
  const value = await loader();
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

function parseRecordingCandidates(data: JsonRecord): RecordingCandidate[] {
  return asArray(data.recordings)
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const id = asString(entry.id);
      const title = asString(entry.title);
      if (!id || !title) return null;
      return {
        id,
        title,
        artistName: readPrimaryArtistName(entry['artist-credit']),
        score: typeof entry.score === 'number' ? entry.score : Number(entry.score) || 0,
        releaseTitles: readReleaseTitles(entry.releases),
      };
    })
    .filter((candidate): candidate is RecordingCandidate => candidate !== null);
}

function parseArtistCandidates(data: JsonRecord): ArtistCandidate[] {
  return asArray(data.artists)
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const id = asString(entry.id);
      const name = asString(entry.name);
      if (!id || !name) return null;
      return {
        id,
        name,
        score: typeof entry.score === 'number' ? entry.score : Number(entry.score) || 0,
      };
    })
    .filter((candidate): candidate is ArtistCandidate => candidate !== null);
}

function findRecordingCandidate(
  candidates: RecordingCandidate[],
  title: string,
  artistName: string,
  albumName: string | null,
): RecordingCandidate | null {
  const normalizedTitle = normalizeText(title);
  const normalizedArtist = normalizeText(artistName);
  const normalizedAlbum = albumName ? normalizeText(albumName) : null;

  const exact = candidates
    .filter((candidate) => normalizeText(candidate.title) === normalizedTitle
      && normalizeText(candidate.artistName) === normalizedArtist)
    .sort((a, b) => {
      const aAlbum = normalizedAlbum && a.releaseTitles.some((value) => normalizeText(value) === normalizedAlbum) ? 1 : 0;
      const bAlbum = normalizedAlbum && b.releaseTitles.some((value) => normalizeText(value) === normalizedAlbum) ? 1 : 0;
      return bAlbum - aAlbum || b.score - a.score;
    });
  if (exact.length > 0) return exact[0];

  const strong = candidates
    .filter((candidate) => candidate.score >= 85 && normalizeText(candidate.title) === normalizedTitle)
    .sort((a, b) => b.score - a.score);
  return strong[0] ?? null;
}

function findArtistCandidate(candidates: ArtistCandidate[], artistName: string): ArtistCandidate | null {
  const normalizedArtist = normalizeText(artistName);
  const exact = candidates.find((candidate) => normalizeText(candidate.name) === normalizedArtist);
  if (exact) return exact;
  return candidates.find((candidate) => candidate.score >= 90) ?? null;
}

export async function findSongGenreLookup(
  artistName: string,
  title: string,
  albumName?: string | null,
): Promise<SongGenreLookup | null> {
  const searchQuery = `artist:"${escapeQuery(artistName)}" AND recording:"${escapeQuery(title)}"`;
  const searchData = await cached(`mb:recording-search:${normalizeText(searchQuery)}`, () =>
    request('/recording', { query: searchQuery, limit: '5' }));
  const candidate = findRecordingCandidate(parseRecordingCandidates(searchData), title, artistName, albumName ?? null);
  if (!candidate) return null;

  const recording = await cached(`mb:recording:${candidate.id}`, () =>
    request(`/recording/${encodeURIComponent(candidate.id)}`, {
      inc: 'genres+tags+artist-credits+releases+release-groups',
    }));

  const recordingTags = [...readTags(recording.genres), ...readTags(recording.tags)].map((entry) => entry.name);
  const releaseGroupTags = asArray(recording['release-groups']).flatMap((entry) =>
    isRecord(entry) ? readTags(entry.genres).map((tag) => tag.name) : []);
  const artistGenres = readArtistGenres(recording['artist-credit']);

  return {
    musicBrainzId: candidate.id,
    artistMusicBrainzId: readPrimaryArtistId(recording['artist-credit']),
    genres: canonicalizeGenreBackfillTags([...recordingTags, ...releaseGroupTags]),
    artistGenres: canonicalizeGenreBackfillTags(artistGenres),
  };
}

export async function findArtistGenreLookup(artistName: string): Promise<ArtistGenreLookup | null> {
  const searchQuery = `artist:"${escapeQuery(artistName)}"`;
  const searchData = await cached(`mb:artist-search:${normalizeText(searchQuery)}`, () =>
    request('/artist', { query: searchQuery, limit: '5' }));
  const candidate = findArtistCandidate(parseArtistCandidates(searchData), artistName);
  if (!candidate) return null;

  const artist = await cached(`mb:artist:${candidate.id}`, () =>
    request(`/artist/${encodeURIComponent(candidate.id)}`, { inc: 'genres+tags' }));
  const tags = [...readTags(artist.genres), ...readTags(artist.tags)].map((entry) => entry.name);

  return {
    musicBrainzId: candidate.id,
    genres: canonicalizeGenreBackfillTags(tags),
  };
}
