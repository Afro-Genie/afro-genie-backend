import { generateGradientImage } from './imageService';

/**
 * Resolve a genre image. The Spotify playlist-source enrichment was removed
 * with the Spotify pipeline (Phase 4), so the local gradient fallback is the
 * only source.
 */
async function getGenreImage(genreName: string): Promise<string> {
  return generateGradientImage(genreName);
}

/**
 * Batch resolve genre images
 */
async function getGenreImages(genreNames: string[]): Promise<Map<string, string>> {
  const imageMap = new Map<string, string>();

  await Promise.all(
    genreNames.map(async (name) => {
      const image = await getGenreImage(name);
      return imageMap.set(name, image);
    })
  );

  return imageMap;
}

export const genreService = {
  getGenreImage,
  getGenreImages,
};