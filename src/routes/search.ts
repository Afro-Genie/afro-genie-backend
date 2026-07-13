import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { query } from 'express-validator';
import { validateRequest } from '../middleware/validateRequest';
import { searchCatalog, suggestCatalog, type SearchType } from '../services/searchService';
import { searchSpotify } from '../services/spotifyService';

export const searchRouter = Router();

searchRouter.get(
  '/search',
  [
    query('q').optional().isString().withMessage('q must be a string'),
    query('type')
      .optional()
      .isIn(['song', 'artist', 'genre', 'all'])
      .withMessage("type must be one of 'song', 'artist', 'genre', 'all'"),
    query('lang').optional().isString().trim().isLength({ min: 2, max: 10 }).withMessage('lang must be a valid language code'),
    query('genre').optional().isString().trim().isLength({ min: 1, max: 64 }).withMessage('genre must be a non-empty string'),
    query('page').optional().isInt({ min: 1 }).withMessage('page must be an integer >= 1'),
    query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('limit must be between 1 and 50'),
    query('spotifyFallback').optional().isBoolean().withMessage('spotifyFallback must be a boolean')
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await searchCatalog({
        q: typeof req.query.q === 'string' ? req.query.q : '',
        type: (typeof req.query.type === 'string' ? req.query.type : 'all') as SearchType,
        lang: typeof req.query.lang === 'string' ? req.query.lang : undefined,
        genre: typeof req.query.genre === 'string' ? req.query.genre : undefined,
        page: typeof req.query.page === 'string' ? Number(req.query.page) : undefined,
        limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined
      });

      const enableFallback = req.query.spotifyFallback === 'true';

      if (enableFallback && typeof req.query.q === 'string' && req.query.q.trim()) {
        const q = req.query.q.trim();

        const localSongIds = new Set(
          (result.songs?.hits ?? []).map((h) => String(h.document.id))
        );
        const localArtistIds = new Set(
          (result.artists?.hits ?? []).map((h) => String(h.document.id))
        );

        try {
          const [artistResp, trackResp] = await Promise.all([
            searchSpotify(q, 'artist', 10).catch(() => null),
            searchSpotify(q, 'track', 10).catch(() => null)
          ]);

          const spotifyArtists = (artistResp?.artists?.items ?? [])
            .filter((a) => !localArtistIds.has(a.id))
            .map((a) => ({
              document: {
                id: a.id,
                name: a.name,
                imageUrl: a.images?.[0]?.url ?? '',
                genres: a.genres ?? [],
                popularity: a.popularity ?? 0,
                followers: a.followers?.total ?? 0,
                externalUrl: a.external_urls?.spotify ?? null
              },
              textMatch: 0,
              highlights: []
            }));

          const spotifyTracks = (trackResp?.tracks?.items ?? [])
            .filter((t) => !localSongIds.has(t.id))
            .map((t) => ({
              document: {
                id: t.id,
                title: t.name,
                artistName: t.artists?.[0]?.name ?? 'Unknown',
                imageUrl: t.album?.images?.[0]?.url ?? '',
                popularity: t.popularity ?? 0,
                externalUrl: t.external_urls?.spotify ?? null
              },
              textMatch: 0,
              highlights: []
            }));

          if (spotifyArtists.length > 0) {
            result.artists = {
              found: (result.artists?.found ?? 0) + spotifyArtists.length,
              page: 1,
              hits: [...spotifyArtists, ...(result.artists?.hits ?? [])]
            };
          }
          if (spotifyTracks.length > 0) {
            const localHits = result.songs?.hits ?? [];
            const sortedSpotify = [...spotifyTracks].sort(
              (a, b) => (b.document.popularity as number) - (a.document.popularity as number)
            );
            result.songs = {
              found: (result.songs?.found ?? 0) + spotifyTracks.length,
              page: 1,
              hits: [...sortedSpotify, ...localHits]
            };
          }
        } catch {
          // Spotify fallback is best-effort; continue with Typesense results.
        }
      }

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

searchRouter.get(
  '/search/suggest',
  [
    query('q').isString().trim().isLength({ min: 1 }).withMessage('q is required'),
    query('spotifyFallback').optional().isBoolean().withMessage('spotifyFallback must be a boolean')
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = String(req.query.q);
      const result = await suggestCatalog(q);

      if (req.query.spotifyFallback === 'true' && q.trim()) {
        const localIds = new Set(
          (result.suggestions ?? []).map((s: any) => String(s.document.id))
        );

        try {
          const [artistResp, trackResp] = await Promise.all([
            searchSpotify(q, 'artist', 5).catch(() => null),
            searchSpotify(q, 'track', 5).catch(() => null)
          ]);

          const spotifySuggestions = [
            ...(artistResp?.artists?.items ?? [])
              .filter((a) => !localIds.has(a.id))
              .map((a) => ({
                type: 'artist' as const,
                textMatch: 0,
                highlights: [],
                document: {
                  id: a.id,
                  name: a.name,
                  imageUrl: a.images?.[0]?.url ?? '',
                  popularity: a.popularity ?? 0,
                  externalUrl: a.external_urls?.spotify ?? null
                }
              })),
            ...(trackResp?.tracks?.items ?? [])
              .filter((t) => !localIds.has(t.id))
              .map((t) => ({
                type: 'song' as const,
                textMatch: 0,
                highlights: [],
                document: {
                  id: t.id,
                  title: t.name,
                  artistName: t.artists?.[0]?.name ?? 'Unknown',
                  imageUrl: t.album?.images?.[0]?.url ?? '',
                  popularity: t.popularity ?? 0,
                  externalUrl: t.external_urls?.spotify ?? null
                }
              }))
          ];

          if (spotifySuggestions.length > 0) {
            result.suggestions = [...spotifySuggestions, ...(result.suggestions ?? [])].slice(0, 12);
          }
        } catch {
          // Spotify fallback is best-effort
        }
      }

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

searchRouter.get(
  '/search/spotify-image',
  [
    query('artist').optional().isString(),
    query('track').optional().isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = typeof req.query.artist === 'string' ? req.query.artist : '';
      const track = typeof req.query.track === 'string' ? req.query.track : '';
      const q = [artist, track].filter(Boolean).join(' ');

      if (!q) {
        return res.status(200).json({ imageUrl: null });
      }

      const result = await searchSpotify(q, 'track');
      const firstTrack = result.tracks?.items?.[0];
      const imageUrl = firstTrack?.album?.images?.[0]?.url || null;

      res.status(200).json({ imageUrl });
    } catch (error) {
      res.status(200).json({ imageUrl: null });
    }
  }
);
