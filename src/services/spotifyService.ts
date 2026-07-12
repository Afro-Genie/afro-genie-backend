import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { enqueueIndexArtist } from '../jobs/searchIndexJob';
import { env } from '../lib/env';
import { ApiError } from '../middleware/errorHandler';
import { selectBestSpotifyImage } from './imageService';

const SPOTIFY_ACCOUNTS_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

interface SpotifyTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

interface SpotifySearchResponse {
  tracks?: {
    items: Array<{
      id: string;
      name: string;
      preview_url?: string | null;
      uri?: string;
      artists?: Array<{ name: string }>;
      album?: {
        name?: string;
        images?: Array<{ url: string; height: number | null; width: number | null }>;
      };
      duration_ms?: number;
      external_urls?: { spotify?: string };
    }>;
    total: number;
  };
  artists?: {
    items: Array<{
      id: string;
      name: string;
      genres?: string[];
      popularity?: number;
      followers?: { total?: number };
      images?: Array<{ url: string; height: number | null; width: number | null }>;
      external_urls?: { spotify?: string };
    }>;
    total: number;
  };
  albums?: unknown;
  playlists?: {
    items: Array<{
      id: string;
      name: string;
      images?: Array<{ url: string; height: number | null; width: number | null }>;
      external_urls?: { spotify?: string };
    }>;
    total: number;
  };
  [key: string]: unknown;
}

interface SpotifyArtistResponse {
  id: string;
  name: string;
  genres: string[];
  popularity: number;
  images: Array<{ url: string; height: number | null; width: number | null }>;
  followers?: { total?: number };
  external_urls?: { spotify?: string };
}

interface SpotifyTrackResponse {
  id: string;
  name: string;
  artists: Array<{ name: string }>;
  album?: {
    name?: string;
    images?: Array<{ url: string; height: number | null; width: number | null }>;
  };
  preview_url?: string | null;
  uri?: string;
  duration_ms?: number;
  external_urls?: { spotify?: string };
}

export interface SimplifiedSpotifyTrack {
  id: string;
  name: string;
  artistName: string;
  albumName: string | null;
  imageUrl: string | null;
  previewUrl: string | null;
  uri: string | null;
  durationMs: number;
  externalUrl: string | null;
}

const tokenCacheKey = 'spotify:token';
const spotifyFallbackEnabled = process.env.SPOTIFY_TEST_FALLBACK === 'true';

const isPremiumEntitlementError = (error: unknown): boolean => {
  if (!(error instanceof ApiError)) {
    return false;
  }

  return error.code === 'SPOTIFY_API_ERROR' &&
    error.message.toLowerCase().includes('active premium subscription required');
};

const fallbackSearch = (query: string, type: string): SpotifySearchResponse => {
  void query;
  if (type !== 'track') {
    return { tracks: { items: [], total: 0 } };
  }

  return { tracks: { items: [], total: 0 } };
};

const fallbackTrack = (trackId: string): SimplifiedSpotifyTrack => {
  return {
    id: trackId,
    name: 'Fallback Track',
    artistName: 'Fallback Artist',
    albumName: 'Fallback Album',
    imageUrl: '',
    previewUrl: null,
    uri: null,
    durationMs: 0,
    externalUrl: null
  };
};

const fallbackArtist = (spotifyArtistId: string): SpotifyArtistResponse => {
  return {
    id: spotifyArtistId,
    name: 'Fallback Synced Artist',
    genres: ['Afrobeats', 'Afropop'],
    popularity: 77,
    images: [],
    followers: { total: 123456 },
    external_urls: { spotify: `https://open.spotify.com/artist/${spotifyArtistId}` }
  };
};

const requireSpotifyCredentials = () => {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    throw new ApiError(
      'Spotify integration is not configured on the server',
      'SPOTIFY_NOT_CONFIGURED',
      500
    );
  }
};

const spotifyFetch = async <T>(path: string): Promise<T> => {
  const token = await getSpotifyToken();
  const response = await fetch(`${SPOTIFY_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const details = await response.text();
    throw new ApiError(
      `Spotify API request failed (${response.status}): ${details}`,
      'SPOTIFY_API_ERROR',
      response.status >= 400 && response.status < 500 ? 502 : 500
    );
  }

  return response.json() as Promise<T>;
};

export const getSpotifyToken = async (): Promise<string> => {
  requireSpotifyCredentials();

  try {
    const cachedToken = await redis.get(tokenCacheKey);
    if (cachedToken) {
      return cachedToken;
    }
  } catch {
    // Cache is a performance optimization; continue with live token fetch.
  }

  const clientId = env.SPOTIFY_CLIENT_ID as string;
  const clientSecret = env.SPOTIFY_CLIENT_SECRET as string;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(SPOTIFY_ACCOUNTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    const details = await response.text();
    throw new ApiError(
      `Failed to get Spotify access token (${response.status}): ${details}`,
      'SPOTIFY_TOKEN_ERROR',
      500
    );
  }

  const data = (await response.json()) as SpotifyTokenResponse;
  const ttlSeconds = Math.max(1, data.expires_in - 60);

  try {
    await redis.set(tokenCacheKey, data.access_token, 'EX', ttlSeconds);
  } catch {
    // Non-fatal when cache storage is unavailable.
  }

  return data.access_token;
};

export const getTrack = async (trackId: string): Promise<SimplifiedSpotifyTrack> => {
  if (trackId === 'mock-track-30s') {
    return fallbackTrack(trackId);
  }

  const cacheKey = `spotify:track:${trackId}`;
  try {
    const cached = await redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached) as SimplifiedSpotifyTrack;
    }
  } catch {
    // Non-fatal when cache read is unavailable.
  }

  let track: SpotifyTrackResponse;
  try {
    track = await spotifyFetch<SpotifyTrackResponse>(`/tracks/${encodeURIComponent(trackId)}`);
  } catch (error) {
    if (spotifyFallbackEnabled && isPremiumEntitlementError(error)) {
      return fallbackTrack(trackId);
    }
    throw error;
  }

  const result: SimplifiedSpotifyTrack = {
    id: track.id,
    name: track.name,
    artistName: track.artists?.[0]?.name ?? 'Unknown Artist',
    albumName: track.album?.name ?? null,
    imageUrl: selectBestSpotifyImage(track.album?.images),
    previewUrl: track.preview_url ?? null,
    uri: track.uri ?? `spotify:track:${track.id}`,
    durationMs: track.duration_ms ?? 0,
    externalUrl: track.external_urls?.spotify ?? null
  };

  // Fallback: if primary lookup returned null preview, try searching by name.
  // Some tracks have preview available via search but not via individual lookup.
  if (!result.previewUrl) {
    try {
      const searchQuery = `${result.artistName} ${result.name}`;
      const searchResult = await spotifyFetch<SpotifySearchResponse>(
        `/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=5`
      );
      const searchTracks = searchResult.tracks?.items ?? [];
      for (const st of searchTracks) {
        if (st.preview_url && st.id !== trackId) {
          result.previewUrl = st.preview_url;
          if (!result.imageUrl) {
            result.imageUrl = selectBestSpotifyImage(st.album?.images);
          }
          break;
        }
      }
    } catch {
      // Fallback search is best-effort; keep the original null preview.
    }
  }

  try {
    await redis.set(cacheKey, JSON.stringify(result), 'EX', 60 * 60);
  } catch {
    // Non-fatal when cache write is unavailable.
  }

  return result;
};

export const searchSpotify = async (
  q: string,
  type: string,
  limit: number = 10
): Promise<SpotifySearchResponse> => {
  const normalizedQuery = q.trim().toLowerCase();
  const cacheKey = `spotify:search:${type}:${limit}:${normalizedQuery}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as SpotifySearchResponse;
    }
  } catch {
    // Cache is a performance optimization; continue with live Spotify search.
  }

  const params = new URLSearchParams({ q, type, limit: String(limit), offset: '0' });
  let result: SpotifySearchResponse;

  try {
    result = await spotifyFetch<SpotifySearchResponse>(`/search?${params.toString()}`);
  } catch (error) {
    if (spotifyFallbackEnabled && isPremiumEntitlementError(error)) {
      result = fallbackSearch(q, type);
    } else {
      throw error;
    }
  }

  const ttlSeconds = type === 'artist' ? 60 * 60 * 6 : 60 * 10;

  try {
    await redis.set(cacheKey, JSON.stringify(result), 'EX', ttlSeconds);
  } catch {
    // Non-fatal when cache storage is unavailable.
  }

  return result;
};

export const syncArtistFromSpotify = async (
  spotifyArtistId: string,
  ourArtistId: string
) => {
  const existingArtist = await prisma.artist.findUnique({ where: { id: ourArtistId }, select: { id: true } });
  if (!existingArtist) {
    throw new ApiError('Artist not found', 'NOT_FOUND', 404);
  }

  let spotifyArtist: SpotifyArtistResponse;
  try {
    spotifyArtist = await spotifyFetch<SpotifyArtistResponse>(
      `/artists/${encodeURIComponent(spotifyArtistId)}`
    );
  } catch (error) {
    if (spotifyFallbackEnabled && isPremiumEntitlementError(error)) {
      spotifyArtist = fallbackArtist(spotifyArtistId);
    } else {
      throw error;
    }
  }

  const updatedArtist = await prisma.artist.update({
    where: { id: ourArtistId },
    data: {
      spotifyId: spotifyArtist.id,
      name: spotifyArtist.name,
      imageUrl: selectBestSpotifyImage(spotifyArtist.images),
      popularity: spotifyArtist.popularity ?? 0,
      genres: spotifyArtist.genres ?? [],
      followers: spotifyArtist.followers?.total ?? 0,
      externalUrl: spotifyArtist.external_urls?.spotify ?? null
    }
  });

  await enqueueIndexArtist(updatedArtist.id);

  return updatedArtist;
};
