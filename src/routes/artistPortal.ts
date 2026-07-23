import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authenticate, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { prisma } from '../lib/prisma';
import { ApiError } from '../middleware/errorHandler';
import {
  sendArtistApplicationConfirmation,
} from '../services/emailService';
import { searchSpotify } from '../services/spotifyService';
import { enqueueIndexSong } from '../jobs/searchIndexJob';
import { enqueueLanguageCategorization } from '../jobs/languageCategorizationJob';
import type { Prisma } from '@prisma/client';

export const artistPortalRouter = Router();

// ─── POST /api/artists/apply ─────────────────────────────────────────────────
// Authenticated users submit an artist application.

artistPortalRouter.post(
  '/artists/apply',
  authenticate,
  [
    body('stageName').isString().trim().notEmpty().withMessage('Stage name is required'),
    body('genre').isString().trim().notEmpty().withMessage('Genre is required'),
    body('bio').isString().trim().notEmpty().withMessage('Bio is required'),
    body('socialLinks').optional().isObject(),
    body('spotifyArtistId').optional({ nullable: true }).isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;

      // Reject if an existing PENDING or APPROVED application exists
      const existing = await prisma.artistApplication.findFirst({
        where: {
          userId,
          status: { in: ['PENDING', 'UNDER_REVIEW', 'APPROVED'] },
        },
        select: { id: true, status: true },
      });

      if (existing) {
        throw new ApiError(
          `You already have a ${existing.status.toLowerCase()} application`,
          'CONFLICT',
          409,
        );
      }

      const { stageName, genre, bio, socialLinks, spotifyArtistId } = req.body;

      const application = await prisma.artistApplication.create({
        data: {
          userId,
          stageName: stageName.trim(),
          genre: genre.trim(),
          bio: bio.trim(),
          socialLinks: socialLinks ?? {},
        },
        select: { id: true, status: true },
      });

      // Send confirmation email (non-blocking)
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });

      if (user?.email) {
        sendArtistApplicationConfirmation(user.email, stageName.trim()).catch(() => {});
      }

      res.status(201).json({
        applicationId: application.id,
        status: application.status,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ─── GET /api/artists/me/profile ─────────────────────────────────────────────
// Authenticated ARTISTs retrieve their linked Artist profile.

artistPortalRouter.get(
  '/artists/me/profile',
  authenticate,
  requireRole('ARTIST'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;

      const artist = await prisma.artist.findUnique({
        where: { userId },
        select: {
          id: true,
          name: true,
          bio: true,
          imageUrl: true,
          profileImageUrl: true,
          bannerImageUrl: true,
          socialLinks: true,
          spotifyId: true,
          spotifyArtistId: true,
          genres: true,
          verified: true,
          suspended: true,
          isFeatured: true,
          popularity: true,
          followers: true,
          createdAt: true,
          _count: { select: { songs: true, releases: true } },
        },
      });

      if (!artist) {
        throw new ApiError('Artist profile not found. Complete your application first.', 'NOT_FOUND', 404);
      }

      res.status(200).json(artist);
    } catch (error) {
      next(error);
    }
  },
);

// ─── PUT /api/artists/me/profile ─────────────────────────────────────────────
// Authenticated ARTISTs update their profile fields.

artistPortalRouter.put(
  '/artists/me/profile',
  authenticate,
  requireRole('ARTIST'),
  [
    body('bio').optional({ nullable: true }).isString(),
    body('profileImageUrl').optional({ nullable: true }).isString(),
    body('bannerImageUrl').optional({ nullable: true }).isString(),
    body('socialLinks').optional().isObject(),
    body('spotifyArtistId').optional({ nullable: true }).isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;

      const artist = await prisma.artist.findUnique({
        where: { userId },
        select: { id: true },
      });

      if (!artist) {
        throw new ApiError('Artist profile not found', 'NOT_FOUND', 404);
      }

      const { bio, profileImageUrl, bannerImageUrl, socialLinks, spotifyArtistId } = req.body;

      const updated = await prisma.artist.update({
        where: { id: artist.id },
        data: {
          ...(bio !== undefined && { bio }),
          ...(profileImageUrl !== undefined && { profileImageUrl }),
          ...(bannerImageUrl !== undefined && { bannerImageUrl }),
          ...(socialLinks !== undefined && { socialLinks }),
          ...(spotifyArtistId !== undefined && { spotifyArtistId }),
        },
        select: {
          id: true,
          name: true,
          bio: true,
          profileImageUrl: true,
          bannerImageUrl: true,
          socialLinks: true,
          spotifyArtistId: true,
          verified: true,
        },
      });

      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  },
);

// ─── POST /api/artists/me/spotify-search ─────────────────────────────────────
// Proxy Spotify artist search for onboarding link-up.

artistPortalRouter.post(
  '/artists/me/spotify-search',
  authenticate,
  requireRole('ARTIST'),
  [body('query').isString().trim().notEmpty().withMessage('Search query is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { query } = req.body;

      const result = await searchSpotify(query, 'artist', 5);

      const artists = (result.artists?.items ?? []).map((a) => ({
        spotifyArtistId: a.id,
        name: a.name,
        imageUrl: a.images?.[0]?.url ?? null,
        genres: a.genres ?? [],
        followers: a.followers?.total ?? 0,
      }));

      res.status(200).json({ artists });
    } catch (error) {
      next(error);
    }
  },
);

// ─── Shared helper ────────────────────────────────────────────────────────────
// Resolves the Artist row linked to the authenticated user.

const getArtistFromUser = async (userId: string) => {
  const artist = await prisma.artist.findUnique({
    where: { userId },
    select: { id: true, name: true, verified: true, suspended: true },
  });
  if (!artist) {
    throw new ApiError('Artist profile not found', 'NOT_FOUND', 404);
  }
  if (artist.suspended) {
    throw new ApiError('Your artist account has been suspended', 'FORBIDDEN', 403);
  }
  return artist;
};

// ─── 2.1 Artist Song CRUD ─────────────────────────────────────────────────────

// GET /api/artists/me/songs
artistPortalRouter.get(
  '/artists/me/songs',
  authenticate,
  requireRole('ARTIST'),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('search').optional().isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const page = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
      const limit = Math.min(typeof req.query.limit === 'string' ? Number(req.query.limit) : 20, 100);
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;

      const where: Prisma.SongWhereInput = {
        artistId: artist.id,
        softDeleted: false,
        ...(search ? { title: { contains: search, mode: 'insensitive' as const } } : {}),
      };

      const [songs, total] = await Promise.all([
        prisma.song.findMany({
          where,
          include: {
            lyrics: {
              orderBy: { createdAt: 'desc' as const },
              take: 1,
              select: { sourceProvider: true, licenseStatus: true },
            },
            release: { select: { id: true, title: true, status: true } },
            _count: { select: { translations: true } },
          },
          orderBy: { createdAt: 'desc' as const },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.song.count({ where }),
      ]);

      res.status(200).json({ songs, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) });
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/artists/me/songs
artistPortalRouter.post(
  '/artists/me/songs',
  authenticate,
  requireRole('ARTIST'),
  [
    body('title').isString().trim().notEmpty().withMessage('Title is required'),
    body('lyrics').optional().isObject(),
    body('lyrics.rawText').optional().isString(),
    body('lyrics.lineBreaks').optional().isArray(),
    body('albumName').optional({ nullable: true }).isString(),
    body('releaseYear').optional({ nullable: true }).isInt({ min: 1800, max: 2200 }),
    body('imageUrl').optional({ nullable: true }).isString(),
    body('genres').optional().isArray(),
    body('languages').optional().isArray(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const { title, lyrics, albumName, releaseYear, imageUrl, genres, languages } = req.body;

      const song = await prisma.song.create({
        data: {
          title: title.trim(),
          artistId: artist.id,
          albumName: albumName ?? null,
          releaseYear: releaseYear ?? null,
          imageUrl: imageUrl ?? null,
        },
      });

      // Create lyric with ARTIST source
      const rawText = lyrics?.rawText ?? (Array.isArray(lyrics?.lineBreaks) ? lyrics.lineBreaks.join('\n').trim() : '');
      if (rawText) {
        await prisma.lyric.create({
          data: {
            songId: song.id,
            content: rawText,
            sourceProvider: 'ARTIST',
            licenseStatus: 'LICENSED',
          },
        });
        await enqueueLanguageCategorization(song.id, rawText);
      }

      // Sync genres
      if (genres && Array.isArray(genres)) {
        const deduped = [...new Set(genres.map((g: string) => g.trim()).filter(Boolean))];
        for (const genreName of deduped) {
          const genre = await prisma.genre.upsert({
            where: { name: genreName },
            create: { name: genreName },
            update: {},
          });
          await prisma.songGenre.create({ data: { songId: song.id, genreId: genre.id } });
        }
      }

      // Sync languages
      if (languages && Array.isArray(languages)) {
        const deduped = [...new Set(languages.map((l: string) => l.trim().toLowerCase()).filter(Boolean))];
        const pct = deduped.length > 0 ? Number((100 / deduped.length).toFixed(2)) : 0;
        for (const code of deduped) {
          await prisma.language.upsert({
            where: { code },
            create: { code, name: code.toUpperCase() },
            update: {},
          });
          await prisma.songLanguage.create({ data: { songId: song.id, languageCode: code, percentage: pct } });
        }
      }

      await enqueueIndexSong(song.id);

      res.status(201).json({ songId: song.id, title: song.title, artistId: song.artistId });
    } catch (error) {
      next(error);
    }
  },
);

// PUT /api/artists/me/songs/:id
artistPortalRouter.put(
  '/artists/me/songs/:id',
  authenticate,
  requireRole('ARTIST'),
  [
    param('id').isString().notEmpty(),
    body('title').optional().isString().trim().notEmpty(),
    body('lyrics').optional().isObject(),
    body('lyrics.rawText').optional().isString(),
    body('lyrics.lineBreaks').optional().isArray(),
    body('albumName').optional({ nullable: true }).isString(),
    body('releaseYear').optional({ nullable: true }).isInt({ min: 1800, max: 2200 }),
    body('imageUrl').optional({ nullable: true }).isString(),
    body('genres').optional().isArray(),
    body('languages').optional().isArray(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const song = await prisma.song.findFirst({
        where: { id: req.params.id, artistId: artist.id },
        select: { id: true },
      });
      if (!song) {
        throw new ApiError('Song not found or access denied', 'NOT_FOUND', 404);
      }

      const { title, lyrics, albumName, releaseYear, imageUrl, genres, languages } = req.body;

      await prisma.song.update({
        where: { id: song.id },
        data: {
          ...(title !== undefined && { title: title.trim() }),
          ...(albumName !== undefined && { albumName }),
          ...(releaseYear !== undefined && { releaseYear }),
          ...(imageUrl !== undefined && { imageUrl }),
        },
      });

      // Update lyrics
      if (lyrics) {
        const rawText = lyrics.rawText ?? (Array.isArray(lyrics.lineBreaks) ? lyrics.lineBreaks.join('\n').trim() : '');
        if (rawText) {
          await prisma.lyric.upsert({
            where: { songId: song.id },
            create: { songId: song.id, content: rawText, sourceProvider: 'ARTIST', licenseStatus: 'LICENSED' },
            update: { content: rawText, licenseStatus: 'LICENSED' },
          });
          await enqueueLanguageCategorization(song.id, rawText);
        }
      }

      // Sync genres
      if (genres && Array.isArray(genres)) {
        await prisma.songGenre.deleteMany({ where: { songId: song.id } });
        const deduped = [...new Set(genres.map((g: string) => g.trim()).filter(Boolean))];
        for (const genreName of deduped) {
          const genre = await prisma.genre.upsert({
            where: { name: genreName },
            create: { name: genreName },
            update: {},
          });
          await prisma.songGenre.create({ data: { songId: song.id, genreId: genre.id } });
        }
      }

      // Sync languages
      if (languages && Array.isArray(languages)) {
        await prisma.songLanguage.deleteMany({ where: { songId: song.id } });
        const deduped = [...new Set(languages.map((l: string) => l.trim().toLowerCase()).filter(Boolean))];
        const pct = deduped.length > 0 ? Number((100 / deduped.length).toFixed(2)) : 0;
        for (const code of deduped) {
          await prisma.language.upsert({
            where: { code },
            create: { code, name: code.toUpperCase() },
            update: {},
          });
          await prisma.songLanguage.create({ data: { songId: song.id, languageCode: code, percentage: pct } });
        }
      }

      await enqueueIndexSong(song.id);

      res.status(200).json({ songId: song.id, title: title ?? undefined });
    } catch (error) {
      next(error);
    }
  },
);

// DELETE /api/artists/me/songs/:id
artistPortalRouter.delete(
  '/artists/me/songs/:id',
  authenticate,
  requireRole('ARTIST'),
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const song = await prisma.song.findFirst({
        where: { id: req.params.id, artistId: artist.id },
        select: { id: true },
      });
      if (!song) {
        throw new ApiError('Song not found or access denied', 'NOT_FOUND', 404);
      }

      await prisma.song.update({
        where: { id: song.id },
        data: { softDeleted: true },
      });

      await enqueueIndexSong(song.id);

      res.status(200).json({ success: true, songId: song.id });
    } catch (error) {
      next(error);
    }
  },
);

// ─── 2.2 Release CRUD ─────────────────────────────────────────────────────────

// POST /api/artists/me/releases
artistPortalRouter.post(
  '/artists/me/releases',
  authenticate,
  requireRole('ARTIST'),
  [
    body('title').isString().trim().notEmpty().withMessage('Title is required'),
    body('type').isIn(['SINGLE', 'EP', 'ALBUM']).withMessage('Type must be SINGLE, EP, or ALBUM'),
    body('releaseDate').isISO8601().withMessage('Release date is required'),
    body('coverImageUrl').optional({ nullable: true }).isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const { title, type, releaseDate, coverImageUrl } = req.body;
      const releaseDateObj = new Date(releaseDate);
      const now = new Date();
      const status = releaseDateObj <= now ? 'PUBLISHED' : 'SCHEDULED';

      const release = await prisma.release.create({
        data: {
          artistId: artist.id,
          title: title.trim(),
          type,
          releaseDate: releaseDateObj,
          coverImageUrl: coverImageUrl ?? null,
          status,
        },
      });

      res.status(201).json({ releaseId: release.id, title: release.title, status: release.status });
    } catch (error) {
      next(error);
    }
  },
);

// PUT /api/artists/me/releases/:id
artistPortalRouter.put(
  '/artists/me/releases/:id',
  authenticate,
  requireRole('ARTIST'),
  [
    param('id').isString().notEmpty(),
    body('title').optional().isString().trim().notEmpty(),
    body('type').optional().isIn(['SINGLE', 'EP', 'ALBUM']),
    body('releaseDate').optional().isISO8601(),
    body('coverImageUrl').optional({ nullable: true }).isString(),
    body('status').optional().isIn(['DRAFT', 'SCHEDULED', 'PUBLISHED']),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const release = await prisma.release.findFirst({
        where: { id: req.params.id, artistId: artist.id },
        select: { id: true, status: true, releaseDate: true },
      });
      if (!release) {
        throw new ApiError('Release not found or access denied', 'NOT_FOUND', 404);
      }

      const { title, type, releaseDate, coverImageUrl, status } = req.body;

      // Validate status transitions
      if (status) {
        const allowedTransitions: Record<string, string[]> = {
          DRAFT: ['SCHEDULED', 'PUBLISHED'],
          SCHEDULED: ['PUBLISHED'],
        };
        const allowed = allowedTransitions[release.status] ?? [];
        if (!allowed.includes(status)) {
          throw new ApiError(
            `Cannot transition from ${release.status} to ${status}`,
            'BAD_REQUEST',
            400,
          );
        }
      }

      // Auto-assign status from releaseDate if provided
      let finalStatus = status;
      if (!finalStatus && releaseDate) {
        const d = new Date(releaseDate);
        finalStatus = d <= new Date() ? 'PUBLISHED' : 'SCHEDULED';
      }

      const updated = await prisma.release.update({
        where: { id: release.id },
        data: {
          ...(title !== undefined && { title: title.trim() }),
          ...(type !== undefined && { type }),
          ...(releaseDate !== undefined && { releaseDate: new Date(releaseDate) }),
          ...(coverImageUrl !== undefined && { coverImageUrl }),
          ...(finalStatus !== undefined && { status: finalStatus }),
        },
      });

      res.status(200).json({ releaseId: updated.id, title: updated.title, status: updated.status });
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/artists/me/releases/:id/tracks
artistPortalRouter.post(
  '/artists/me/releases/:id/tracks',
  authenticate,
  requireRole('ARTIST'),
  [
    param('id').isString().notEmpty(),
    body('songIds').isArray().notEmpty().withMessage('songIds array is required'),
    body('songIds.*').isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const release = await prisma.release.findFirst({
        where: { id: req.params.id, artistId: artist.id },
        select: { id: true },
      });
      if (!release) {
        throw new ApiError('Release not found or access denied', 'NOT_FOUND', 404);
      }

      const { songIds } = req.body as { songIds: string[] };
      const deduped = [...new Set(songIds)];

      // Verify all songs belong to this artist
      const songs = await prisma.song.findMany({
        where: { id: { in: deduped }, artistId: artist.id },
        select: { id: true },
      });
      if (songs.length !== deduped.length) {
        throw new ApiError('One or more songs not found or access denied', 'BAD_REQUEST', 400);
      }

      // Get current max track number in this release
      const maxTrack = await prisma.song.aggregate({
        where: { releaseId: release.id },
        _max: { trackNumber: true },
      });
      let nextTrack = (maxTrack._max.trackNumber ?? 0) + 1;

      const updates = songs.map((s) =>
        prisma.song.update({
          where: { id: s.id },
          data: { releaseId: release.id, trackNumber: nextTrack++ },
        })
      );
      await prisma.$transaction(updates);

      res.status(200).json({ releaseId: release.id, tracksAdded: songs.length });
    } catch (error) {
      next(error);
    }
  },
);

// ─── GET /api/artists/me/releases ─────────────────────────────────────────────

artistPortalRouter.get(
  '/artists/me/releases',
  authenticate,
  requireRole('ARTIST'),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const page = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
      const limit = Math.min(typeof req.query.limit === 'string' ? Number(req.query.limit) : 20, 100);

      const where: Prisma.ReleaseWhereInput = { artistId: artist.id };

      const [releases, total] = await Promise.all([
        prisma.release.findMany({
          where,
          include: { _count: { select: { songs: true } } },
          orderBy: { releaseDate: 'desc' as const },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.release.count({ where }),
      ]);

      res.status(200).json({ releases, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) });
    } catch (error) {
      next(error);
    }
  },
);

// ─── 3.1 Artist Analytics ─────────────────────────────────────────────────────

// GET /api/artists/me/analytics
artistPortalRouter.get(
  '/artists/me/analytics',
  authenticate,
  requireRole('ARTIST'),
  [query('rangeDays').optional().isIn(['30', '90'])],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const rangeDays = typeof req.query.rangeDays === 'string' ? Number(req.query.rangeDays) : 30;

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - rangeDays);
      startDate.setHours(0, 0, 0, 0);

      // Aggregate daily rows
      const dailyRows = await prisma.artistAnalyticsDaily.findMany({
        where: {
          artistId: artist.id,
          date: { gte: startDate },
        },
        orderBy: { date: 'asc' },
        select: {
          date: true,
          plays: true,
          translationViews: true,
          uniqueListeners: true,
        },
      });

      const totalPlays = dailyRows.reduce((sum, r) => sum + r.plays, 0);
      const totalTranslationViews = dailyRows.reduce((sum, r) => sum + r.translationViews, 0);
      const totalUniqueListeners = dailyRows.reduce((sum, r) => sum + r.uniqueListeners, 0);

      const series = dailyRows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        plays: r.plays,
        translationViews: r.translationViews,
        uniqueListeners: r.uniqueListeners,
      }));

      // Top songs by views (non-soft-deleted)
      const topSongs = await prisma.song.findMany({
        where: { artistId: artist.id, softDeleted: false },
        orderBy: { views: 'desc' },
        take: 10,
        select: {
          id: true,
          title: true,
          views: true,
          requestCount: true,
          imageUrl: true,
          _count: { select: { translations: true } },
        },
      });

      res.status(200).json({
        rangeDays,
        totalPlays,
        totalTranslationViews,
        totalUniqueListeners,
        series,
        topSongs,
      });
    } catch (error) {
      next(error);
    }
  },
);
