import { logger } from '../lib/logger';

const SPOTIFY_CDN_PATTERN = /^https:\/\/i\.scdn\.co\/image/;
const SPOTIFY_CDN_HOST = 'i.scdn.co';

const GENRE_COLORS: Record<string, { primary: string; secondary: string; playlist: string }> = {
  'afrobeats': { primary: '#FF6B35', secondary: '#F7931E', playlist: 'afrobeats' },
  'afropop': { primary: '#F4A261', secondary: '#E76F51', playlist: 'afropop' },
  'amapiano': { primary: '#2A9D8F', secondary: '#264653', playlist: 'amapiano' },
  'highlife': { primary: '#E9C46A', secondary: '#F4A261', playlist: 'highlife' },
  'dancehall': { primary: '#D62828', secondary: '#F77F00', playlist: 'dancehall' },
  'reggae': { primary: '#06A77D', secondary: '#118B7C', playlist: 'reggae' },
  'hipop': { primary: '#D62828', secondary: '#F77F00', playlist: 'hip hop' },
  'hip-hop': { primary: '#D62828', secondary: '#F77F00', playlist: 'hip hop' },
  'r&b': { primary: '#7209B7', secondary: '#B5179E', playlist: 'r&b' },
  'alt-r&b': { primary: '#7209B7', secondary: '#B5179E', playlist: 'r&b' },
  'house': { primary: '#00A8E8', secondary: '#00C9FF', playlist: 'house' },
  'electronic': { primary: '#FF0080', secondary: '#FF8C00', playlist: 'electronic' },
  'pop': { primary: '#FF006E', secondary: '#FB5607', playlist: 'pop' },
  'mbalax': { primary: '#FFB703', secondary: '#FB8500', playlist: 'mbalax' },
  'benga': { primary: '#8ECAE6', secondary: '#219EBC', playlist: 'benga' },
  'kwaito': { primary: '#023047', secondary: '#FB8500', playlist: 'kwaito' },
  'afro-fusion': { primary: '#FF006E', secondary: '#FB5607', playlist: 'afro-fusion' },
  'banku': { primary: '#2D6A4F', secondary: '#40916C', playlist: 'banku' },
};

export { GENRE_COLORS };

/**
 * Validate that an image URL is from the Spotify CDN.
 * Returns the URL if valid, null otherwise.
 */
export function validateSpotifyImageUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') {
    return null;
  }

  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === SPOTIFY_CDN_HOST && SPOTIFY_CDN_PATTERN.test(trimmed)) {
      return trimmed;
    }
  } catch {
    // Not a valid URL
  }

  return null;
}

/**
 * Select the best image URL from a Spotify images array.
 * Returns the largest image (by area) that passes CDN validation.
 */
export function selectBestSpotifyImage(
  images: Array<{ url: string; height: number | null; width: number | null }> | undefined
): string | null {
  if (!images || images.length === 0) return null;

  const validImages = images
    .filter((img) => validateSpotifyImageUrl(img.url))
    .sort((a, b) => {
      const areaA = (a.height ?? 0) * (a.width ?? 0);
      const areaB = (b.height ?? 0) * (b.width ?? 0);
      return areaB - areaA;
    });

  return validImages[0]?.url ?? null;
}

/**
 * Generate a gradient-based SVG image as a data URL.
 * Used as a fallback when no Spotify image is available.
 */
export function generateGradientImage(name: string): string {
  const config = GENRE_COLORS[name.toLowerCase()] || {
    primary: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
    secondary: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
  };

  const initial = name.substring(0, 1).toUpperCase();

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
    <defs>
      <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:${config.primary};stop-opacity:1" />
        <stop offset="100%" style="stop-color:${config.secondary};stop-opacity:1" />
      </linearGradient>
    </defs>
    <rect width="300" height="300" fill="url(#grad)" />
    <text x="50%" y="50%" text-anchor="middle" dy="0.3em" font-size="36" font-weight="bold" fill="white" font-family="Arial" opacity="0.3">
      ${initial}
    </text>
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Get a display-safe image URL.
 * Returns the Spotify CDN URL if valid, or a gradient fallback.
 */
export function getDisplayImage(
  spotifyUrl: string | null | undefined,
  fallbackName: string
): string {
  const validated = validateSpotifyImageUrl(spotifyUrl);
  if (validated) {
    return validated;
  }
  return generateGradientImage(fallbackName);
}

/**
 * Check if a URL is from a known broken image host.
 */
const BROKEN_HOSTS = new Set(['images.afrogenie.dev']);

export function isBrokenImageUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(url);
    return BROKEN_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}
