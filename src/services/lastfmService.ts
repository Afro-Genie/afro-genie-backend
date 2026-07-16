/**
 * Last.fm Artist Enrichment Service
 *
 * Fetches artist metadata from Last.fm that the Spotify Web API no longer
 * provides (listeners, playcount, bio, genres). Used to backfill the
 * deprecated popularity/followers/genres fields in the Artist table.
 *
 * Fields mapped:
 *   listeners   → popularity  (for sorting: higher = more popular)
 *   playcount   → followers   (for display: total engagement)
 *   bio.summary → bio         (artist biography)
 *   tags        → genres      (genre tags)
 *   image       → imageUrl    (only fills missing images)
 */

const LASTFM_API_BASE = 'https://ws.audioscrobbler.com/2.0/';
// Public Last.fm demo key — works for basic artist lookups
const LASTFM_API_KEY = 'b25b959554ed76058ac220b7b2e0a026';

export interface LastFmArtistData {
  name: string;
  listeners: number;
  playcount: number;
  bio: string;
  tags: string[];
  imageUrl: string;
}

/**
 * Fetch artist metadata from Last.fm by name.
 * Returns null if the artist is not found or the request fails.
 */
export async function fetchLastFmArtist(artistName: string): Promise<LastFmArtistData | null> {
  try {
    const params = new URLSearchParams({
      method: 'artist.getinfo',
      artist: artistName,
      format: 'json',
      api_key: LASTFM_API_KEY,
    });

    const res = await fetch(`${LASTFM_API_BASE}?${params.toString()}`, {
      headers: { 'User-Agent': 'AfroGenie/1.0 (artist-enrichment)' },
    });

    if (!res.ok) return null;

    const data = await res.json() as any;

    // Last.fm returns { error: 6 } when artist not found
    if (data.error || !data.artist) return null;

    const artist = data.artist;

    // Extract the largest available image
    const images = artist.image || [];
    const imageUrl = images.find((i: any) => i.size === 'extralarge')?.['#text']
      || images.find((i: any) => i.size === 'large')?.['#text']
      || '';

    // Clean HTML from bio
    const rawBio = artist.bio?.summary || '';
    const bio = rawBio.replace(/<[^>]*>/g, '').trim();

    // Extract genre tags
    const tags = (artist.tags?.tag || [])
      .map((t: any) => (t.name || '').toLowerCase().trim())
      .filter((t: string) => t.length > 0);

    return {
      name: artist.name || artistName,
      listeners: parseInt(artist.stats?.listeners || '0', 10),
      playcount: parseInt(artist.stats?.playcount || '0', 10),
      bio,
      tags,
      imageUrl,
    };
  } catch (err) {
    console.error(`[Last.fm] Failed to fetch "${artistName}":`, err);
    return null;
  }
}

/**
 * Batch-fetch multiple artists from Last.fm with rate limiting.
 * Last.fm allows ~5 requests/second with an API key.
 */
export async function fetchLastFmArtistsBatch(
  artistNames: string[],
  onProgress?: (completed: number, total: number) => void,
  delayMs = 250
): Promise<Map<string, LastFmArtistData>> {
  const results = new Map<string, LastFmArtistData>();

  for (let i = 0; i < artistNames.length; i++) {
    const name = artistNames[i];
    const data = await fetchLastFmArtist(name);
    if (data) {
      results.set(name, data);
    }
    onProgress?.(i + 1, artistNames.length);
    if (i < artistNames.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return results;
}
