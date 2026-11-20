import channelData from '../data/youtube-african-channel-allowlist.json';
import playlistArtistData from '../data/youtube-african-playlist-artists.json';

export type AfricanOriginBasis = 'nationality' | 'born-in-africa' | 'formed-in-africa';
export type ArtistEvidenceSource =
  | 'official-biography'
  | 'label-biography'
  | 'reputable-publication';

export interface YouTubeCatalogChannel {
  channelId: string;
  artistName: string;
  countryCode: string;
  originBasis: AfricanOriginBasis;
  sourceType: ArtistEvidenceSource;
  sourceTitle: string;
  sourceUrl: string;
  reviewedAt: string;
  rationale: string;
  genres: string[];
}

export interface YouTubePlaylistArtist {
  channelId: string;
  artistName: string;
  countryCode: string;
  genres: string[];
}

export interface YouTubeVideoCandidate {
  videoId: string;
  channelId: string;
  title: string;
  categoryId: string | null;
  embeddable: boolean | null;
  durationSeconds: number | null;
  publishedAt: string | null;
}

export interface AfricanGenreSearchQuery {
  query: string;
  genre: string;
}

const AFRICAN_COUNTRY_CODES = new Set([
  'AO', 'BF', 'BI', 'BJ', 'BW', 'CD', 'CF', 'CG', 'CI', 'CM', 'CV', 'DJ',
  'DZ', 'EG', 'ER', 'ET', 'GA', 'GH', 'GM', 'GN', 'GQ', 'GW', 'KE', 'KM',
  'LR', 'LS', 'LY', 'MA', 'MG', 'ML', 'MR', 'MU', 'MW', 'MZ', 'NA', 'NE',
  'NG', 'RW', 'SC', 'SD', 'SL', 'SN', 'SO', 'SS', 'ST', 'SZ', 'TD', 'TG',
  'TN', 'TZ', 'UG', 'ZA', 'ZM', 'ZW',
]);

const ORIGIN_BASES = new Set<AfricanOriginBasis>([
  'nationality',
  'born-in-africa',
  'formed-in-africa',
]);

const EVIDENCE_SOURCES = new Set<ArtistEvidenceSource>([
  'official-biography',
  'label-biography',
  'reputable-publication',
]);

const AFRICAN_GENRE_ALIASES: Readonly<Record<string, string>> = {
  'afrobeat': 'Afrobeat',
  'afro beats': 'Afrobeats',
  'afrobeats': 'Afrobeats',
  'afro pop': 'Afropop',
  'afropop': 'Afropop',
  'afro fusion': 'Afro-fusion',
  'afro r and b': 'Afro-R&B',
  'afro r b': 'Afro-R&B',
  'afro house': 'Afro-house',
  'afro tech': 'Afro-house',
  'african hip hop': 'African Hip-Hop',
  'afro hip hop': 'African Hip-Hop',
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
  'amapiano': 'Amapiano',
  'azonto': 'Azonto',
  'banku': 'Banku',
  'bongo flava': 'Bongo Flava',
  'coupe decale': 'Coupé-Décalé',
  'gengetone': 'Gengetone',
  'gqom': 'Gqom',
  'highlife': 'Highlife',
  'fuji': 'Fuji',
  'juju': 'Juju',
  'kizomba': 'Kizomba',
  'kuduro': 'Kuduro',
  'kwaito': 'Kwaito',
  'makossa': 'Makossa',
  'mbalax': 'Mbalax',
  'ndombolo': 'Ndombolo',
  'soukous': 'Soukous',
  'taarab': 'Taarab',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeGenre(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeArtistIdentity(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function classifyAfricanGenres(tags: readonly string[]): string[] {
  return [...new Set(
    tags
      .map(normalizeGenre)
      .map(tag => AFRICAN_GENRE_ALIASES[tag])
      .filter((genre): genre is string => genre !== undefined),
  )];
}

export function validateManualAfricanSongGenres(
  artistName: string,
  songGenres: readonly string[],
): string[] {
  const requestedGenres = classifyAfricanGenres(songGenres);
  if (!requestedGenres.length || requestedGenres.length !== new Set(songGenres.map(normalizeGenre)).size) {
    throw new Error('Manual songs must use approved African music genres.');
  }
  return requestedGenres;
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseChannel(value: unknown, index: number): YouTubeCatalogChannel {
  if (!isRecord(value)) throw new Error(`Channel allowlist entry ${index + 1} must be an object`);
  const {
    channelId, artistName, countryCode, originBasis, sourceType, sourceTitle,
    sourceUrl, reviewedAt, rationale, genres,
  } = value;

  if (typeof channelId !== 'string' || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
    throw new Error(`Channel allowlist entry ${index + 1} must have a valid YouTube channel ID`);
  }
  if (!nonEmpty(artistName)) throw new Error(`Channel allowlist entry ${index + 1} must have an artist name`);
  if (typeof countryCode !== 'string' || !AFRICAN_COUNTRY_CODES.has(countryCode)) {
    throw new Error(`Channel allowlist entry ${index + 1} must use an African ISO country code`);
  }
  if (typeof originBasis !== 'string' || !ORIGIN_BASES.has(originBasis as AfricanOriginBasis)) {
    throw new Error(`Channel allowlist entry ${index + 1} has an unsupported origin basis`);
  }
  if (typeof sourceType !== 'string' || !EVIDENCE_SOURCES.has(sourceType as ArtistEvidenceSource)) {
    throw new Error(`Channel allowlist entry ${index + 1} has an unsupported evidence source`);
  }
  if (!nonEmpty(sourceTitle)) throw new Error(`Channel allowlist entry ${index + 1} must name its evidence source`);
  let url: URL;
  try {
    url = new URL(String(sourceUrl));
  } catch {
    throw new Error(`Channel allowlist entry ${index + 1} must have a valid HTTPS evidence URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`Channel allowlist entry ${index + 1} evidence URL must use HTTPS`);
  if (!isValidDate(reviewedAt)) throw new Error(`Channel allowlist entry ${index + 1} must have a valid review date`);
  if (!nonEmpty(rationale)) throw new Error(`Channel allowlist entry ${index + 1} must explain its origin evidence`);
  if (!Array.isArray(genres) || !genres.every(nonEmpty)) {
    throw new Error(`Channel allowlist entry ${index + 1} must list supported African genres`);
  }
  const canonicalGenres = classifyAfricanGenres(genres);
  if (!canonicalGenres.length || canonicalGenres.length !== new Set(genres.map(normalizeGenre)).size) {
    throw new Error(`Channel allowlist entry ${index + 1} contains unsupported genres`);
  }

  return {
    channelId,
    artistName: artistName.trim(),
    countryCode,
    originBasis: originBasis as AfricanOriginBasis,
    sourceType: sourceType as ArtistEvidenceSource,
    sourceTitle: sourceTitle.trim(),
    sourceUrl: url.toString(),
    reviewedAt,
    rationale: rationale.trim(),
    genres: canonicalGenres,
  };
}

export function validateYouTubeChannelAllowlist(value: unknown): readonly YouTubeCatalogChannel[] {
  if (!Array.isArray(value)) throw new Error('YouTube channel allowlist entries must be an array');
  const entries = value.map(parseChannel);
  const channelIds = new Set<string>();
  for (const entry of entries) {
    if (channelIds.has(entry.channelId)) {
      throw new Error(`Duplicate YouTube channel ID in allowlist: ${entry.channelId}`);
    }
    channelIds.add(entry.channelId);
  }
  return entries;
}

export const YOUTUBE_AFRICAN_CHANNELS =
  validateYouTubeChannelAllowlist(channelData.entries);

export function validateYouTubePlaylistArtists(value: unknown): readonly YouTubePlaylistArtist[] {
  if (!Array.isArray(value)) throw new Error('YouTube playlist artist entries must be an array');
  const entries = value.map((entry, index): YouTubePlaylistArtist => {
    if (!isRecord(entry)) throw new Error(`Playlist artist entry ${index + 1} must be an object`);
    const { channelId, artistName, countryCode, genres } = entry;
    if (typeof channelId !== 'string' || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
      throw new Error(`Playlist artist entry ${index + 1} must have a valid YouTube channel ID`);
    }
    if (!nonEmpty(artistName)) throw new Error(`Playlist artist entry ${index + 1} must have an artist name`);
    if (typeof countryCode !== 'string' || !AFRICAN_COUNTRY_CODES.has(countryCode)) {
      throw new Error(`Playlist artist entry ${index + 1} must use an African ISO country code`);
    }
    if (!Array.isArray(genres) || !genres.every(nonEmpty)) {
      throw new Error(`Playlist artist entry ${index + 1} must list supported African genres`);
    }
    const canonicalGenres = classifyAfricanGenres(genres);
    if (!canonicalGenres.length || canonicalGenres.length !== new Set(genres.map(normalizeGenre)).size) {
      throw new Error(`Playlist artist entry ${index + 1} contains unsupported genres`);
    }
    return {
      channelId,
      artistName: artistName.trim(),
      countryCode,
      genres: canonicalGenres,
    };
  });
  const channelIds = new Set<string>();
  for (const entry of entries) {
    if (channelIds.has(entry.channelId)) {
      throw new Error(`Duplicate YouTube playlist artist channel ID: ${entry.channelId}`);
    }
    channelIds.add(entry.channelId);
  }
  return entries;
}

export const YOUTUBE_AFRICAN_PLAYLIST_ARTISTS =
  validateYouTubePlaylistArtists(playlistArtistData.entries);

export interface AvailableYouTubeCatalogArtist {
  name: string;
  genres: string[];
}

export function getAvailableYouTubeCatalogSources(): {
  artists: AvailableYouTubeCatalogArtist[];
  genres: string[];
} {
  const channels = [...YOUTUBE_AFRICAN_CHANNELS, ...YOUTUBE_AFRICAN_PLAYLIST_ARTISTS];
  const artistsByIdentity = new Map<string, AvailableYouTubeCatalogArtist>();
  for (const channel of channels) {
    const identity = normalizeArtistIdentity(channel.artistName);
    const existing = artistsByIdentity.get(identity);
    artistsByIdentity.set(identity, {
      name: existing?.name || channel.artistName,
      genres: [...new Set([...(existing?.genres || []), ...channel.genres])].sort((a, b) => a.localeCompare(b)),
    });
  }
  return {
    artists: [...artistsByIdentity.values()].sort((a, b) => a.name.localeCompare(b.name)),
    genres: [...new Set(channels.flatMap((channel) => channel.genres))].sort((a, b) => a.localeCompare(b)),
  };
}

export function normalizeVideoTitle(rawTitle: string, artistName: string): string {
  let title = rawTitle.trim();
  title = title
    .replace(/\s*[\[(][^\])]*(?:official|video|audio|lyric|visualizer|visualiser)[^\])]*[\])]\s*/gi, ' ')
    .replace(/\s*(?:official|visualizer|visualiser|lyric\s+video|music\s+video|official\s+audio|official\s+video)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, '')
    .trim();
  const artistPrefix = new RegExp(`^${escapeRegExp(artistName)}\\s*[-–—:|]+\\s*`, 'i');
  const artistSuffix = new RegExp(`\\s*[-–—:|]+\\s*${escapeRegExp(artistName)}$`, 'i');
  title = title.replace(artistPrefix, '').replace(artistSuffix, '').trim();
  return title;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isEligibleYouTubeMusicVideo(
  video: YouTubeVideoCandidate,
  channel: Pick<YouTubeCatalogChannel, 'channelId' | 'artistName'> | undefined,
): boolean {
  return Boolean(
    channel &&
    video.videoId &&
    video.channelId === channel.channelId &&
    video.categoryId === '10' &&
    video.embeddable === true &&
    video.durationSeconds !== null &&
    video.durationSeconds > 30 &&
    normalizeVideoTitle(video.title, channel.artistName).length > 0,
  );
}

export const AFRICAN_GENRE_SEARCH_QUERIES: readonly AfricanGenreSearchQuery[] = [
  { query: 'afrobeats', genre: 'Afrobeats' },
  { query: 'afrobeat', genre: 'Afrobeat' },
  { query: 'afropop', genre: 'Afropop' },
  { query: 'afro fusion', genre: 'Afro-fusion' },
  { query: 'afro r&b', genre: 'Afro-R&B' },
  { query: 'afro house', genre: 'Afro-house' },
  { query: 'amapiano', genre: 'Amapiano' },
  { query: 'azonto', genre: 'Azonto' },
  { query: 'banku', genre: 'Banku' },
  { query: 'bongo flava', genre: 'Bongo Flava' },
  { query: 'coupé-décalé', genre: 'Coupé-Décalé' },
  { query: 'african dancehall', genre: 'Dancehall' },
  { query: 'african hip hop', genre: 'African Hip-Hop' },
  { query: 'fuji music', genre: 'Fuji' },
  { query: 'gengetone', genre: 'Gengetone' },
  { query: 'gqom', genre: 'Gqom' },
  { query: 'highlife', genre: 'Highlife' },
  { query: 'juju music', genre: 'Juju' },
  { query: 'kizomba', genre: 'Kizomba' },
  { query: 'kuduro', genre: 'Kuduro' },
  { query: 'kwaito', genre: 'Kwaito' },
  { query: 'makossa', genre: 'Makossa' },
  { query: 'mbalax', genre: 'Mbalax' },
  { query: 'ndombolo', genre: 'Ndombolo' },
  { query: 'soukous', genre: 'Soukous' },
  { query: 'taarab', genre: 'Taarab' },
];
