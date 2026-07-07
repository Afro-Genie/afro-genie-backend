import { searchSpotify } from './spotifyService';
import { logger } from '../lib/logger';

// Color mapping for genres - used for gradient backgrounds and playlist search
const GENRE_COLORS: Record<string, { primary: string; secondary: string; playlist: string }> = {
  'afrobeats': { primary: '#FF6B35', secondary: '#F7931E', playlist: 'afrobeats' },
  'afropop': { primary: '#F4A261', secondary: '#E76F51', playlist: 'afropop' },
  'amapiano': { primary: '#2A9D8F', secondary: '#264653', playlist: 'amapiano' },
  'highlife': { primary: '#E9C46A', secondary: '#F4A261', playlist: 'highlife' },
  'dancehall': { primary: '#D62828', secondary: '#F77F00', playlist: 'dancehall' },
  'reggae': { primary: '#06A77D', secondary: '#118B7C', playlist: 'reggae' },
  'hipop': { primary: '#D62828', secondary: '#F77F00', playlist: 'hip hop' },
  'r&b': { primary: '#7209B7', secondary: '#B5179E', playlist: 'r&b' },
  'alt-r&b': { primary: '#7209B7', secondary: '#B5179E', playlist: 'r&b' },
  'house': { primary: '#00A8E8', secondary: '#00C9FF', playlist: 'house' },
  'electronic': { primary: '#FF0080', secondary: '#FF8C00', playlist: 'electronic' },
  'pop': { primary: '#FF006E', secondary: '#FB5607', playlist: 'pop' },
  'mbalax': { primary: '#FFB703', secondary: '#FB8500', playlist: 'mbalax' },
  'benga': { primary: '#8ECAE6', secondary: '#219EBC', playlist: 'benga' },
  'kwaito': { primary: '#023047', secondary: '#FB8500', playlist: 'kwaito' },
  'afro-fusion': { primary: '#FF006E', secondary: '#FB5607', playlist: 'afro-fusion' },
};

/**
 * Generate a playlist image URL from Spotify
 */
async function getPlaylistImage(genreName: string): Promise<string | null> {
  try {
    const config = GENRE_COLORS[genreName.toLowerCase()] || { playlist: genreName };
    const searchQuery = config.playlist;
    
    const results = await searchSpotify(`best ${searchQuery}`, 'playlist', 5);
    const playlists = results.playlists?.items || [];
    
    // Find first playlist with images
    for (const playlist of playlists) {
      if (playlist.images && playlist.images.length > 0) {
        // Prefer medium-sized images (300x300)
        const image = playlist.images.find(img => img.width === 300) || 
                      playlist.images.find(img => img.width === 340) ||
                      playlist.images[0];
        if (image?.url) {
          return image.url;
        }
      }
    }
    
    return null;
  } catch (err) {
    logger.warn({ err, genre: genreName }, 'Failed to fetch genre playlist image');
    return null;
  }
}

/**
 * Generate a gradient-based image URL for genres
 * Uses a data URL with a simple SVG gradient
 */
function generateGradientImage(genreName: string): string {
  const config = GENRE_COLORS[genreName.toLowerCase()] || {
    primary: '#' + Math.floor(Math.random() * 16777215).toString(16),
    secondary: '#' + Math.floor(Math.random() * 16777215).toString(16),
  };

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
    <defs>
      <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:${config.primary};stop-opacity:1" />
        <stop offset="100%" style="stop-color:${config.secondary};stop-opacity:1" />
      </linearGradient>
    </defs>
    <rect width="300" height="300" fill="url(#grad)" />
    <text x="50%" y="50%" text-anchor="middle" dy="0.3em" font-size="36" font-weight="bold" fill="white" font-family="Arial" opacity="0.3">
      ${genreName.substring(0, 1).toUpperCase()}
    </text>
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Fetch genre image from Spotify playlists with gradient fallback
 */
async function getGenreImage(genreName: string): Promise<string> {
  // First, try to get real image from Spotify
  const playlistImage = await getPlaylistImage(genreName);
  if (playlistImage) {
    return playlistImage;
  }

  // Fall back to gradient image
  return generateGradientImage(genreName);
}

/**
 * Batch fetch genre images
 */
async function getGenreImages(genreNames: string[]): Promise<Map<string, string>> {
  const imageMap = new Map<string, string>();

  // Fetch in parallel with concurrency limit
  const batchSize = 2;
  for (let i = 0; i < genreNames.length; i += batchSize) {
    const batch = genreNames.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (name) => {
        const image = await getGenreImage(name);
        return { name, image };
      })
    );

    for (const { name, image } of results) {
      imageMap.set(name, image);
    }
  }

  return imageMap;
}

export const genreService = {
  getGenreImage,
  getGenreImages,
};
