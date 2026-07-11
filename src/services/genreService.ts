import { searchSpotify } from './spotifyService';
import { logger } from '../lib/logger';
import { generateGradientImage, validateSpotifyImageUrl, GENRE_COLORS } from './imageService';

/**
 * Generate a playlist image URL from Spotify
 */
async function getPlaylistImage(genreName: string): Promise<string | null> {
  try {
    const config = GENRE_COLORS[genreName.toLowerCase()] || { playlist: genreName };
    const searchQuery = config.playlist;
    
    const results = await searchSpotify(`best ${searchQuery}`, 'playlist', 5);
    const playlists = results.playlists?.items || [];
    
    for (const playlist of playlists) {
      if (playlist.images && playlist.images.length > 0) {
        const image = playlist.images.find(img => img.width === 300) || 
                      playlist.images.find(img => img.width === 340) ||
                      playlist.images[0];
        if (image?.url && validateSpotifyImageUrl(image.url)) {
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
