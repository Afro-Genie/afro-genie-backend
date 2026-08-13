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
    body('imageUrl').optional({ nullable: true }).isString(),
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

      const { stageName, genre, bio, socialLinks, spotifyArtistId, imageUrl } = req.body;

      const application = await prisma.artistApplication.create({
        data: {
          userId,
          stageName: stageName.trim(),
          genre: genre.trim(),
          bio: bio.trim(),
          socialLinks: socialLinks ?? {},
          imageUrl: imageUrl ?? null,
          spotifyArtistId: spotifyArtistId ?? null,
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

// ─── GET /api/artists/me/application-status ──────────────────────────────────
// Check if user has a pending/under-review artist application.

artistPortalRouter.get(
  '/artists/me/application-status',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;

      const application = await prisma.artistApplication.findFirst({
        where: {
          userId,
          status: { in: ['PENDING', 'UNDER_REVIEW'] },
        },
        select: { id: true, status: true, stageName: true, createdAt: true },
      });

      res.status(200).json({ application: application ?? null });
    } catch (error) {
      next(error);
    }
  },
);

// ─── DELETE /api/artists/me/application ──────────────────────────────────────
// Cancel a pending artist application.

artistPortalRouter.delete(
  '/artists/me/application',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;

      const application = await prisma.artistApplication.findFirst({
        where: {
          userId,
          status: { in: ['PENDING', 'UNDER_REVIEW'] },
        },
      });

      if (!application) {
        throw new ApiError('No pending application found', 'NOT_FOUND', 404);
      }

      await prisma.artistApplication.delete({
        where: { id: application.id },
      });

      res.status(200).json({ success: true });
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
          user: { select: { email: true } },
          _count: { select: { songs: true, releases: true } },
        },
      });

      if (!artist) {
        throw new ApiError('Artist profile not found. Complete your application first.', 'NOT_FOUND', 404);
      }

      // Compute totalStreams (sum of all song views)
      const streamsAgg = await prisma.song.aggregate({
        where: { artistId: artist.id, softDeleted: false },
        _sum: { views: true },
      });

      // Compute totalListeners (unique listeners over last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      thirtyDaysAgo.setHours(0, 0, 0, 0);
      const listenersAgg = await prisma.artistAnalyticsDaily.aggregate({
        where: { artistId: artist.id, date: { gte: thirtyDaysAgo } },
        _sum: { uniqueListeners: true },
      });

      const { user, ...artistData } = artist;
      res.status(200).json({
        ...artistData,
        stageName: artist.name,
        email: user?.email ?? null,
        totalStreams: streamsAgg._sum.views ?? 0,
        totalListeners: listenersAgg._sum.uniqueListeners ?? 0,
      });
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
    body('contact').optional().isObject(),
    body('spotifyArtistId').optional({ nullable: true }).isString(),
    body('stageName').optional({ nullable: true }).isString(),
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

      const { bio, profileImageUrl, bannerImageUrl, socialLinks, spotifyArtistId, stageName } = req.body;

      const updated = await prisma.artist.update({
        where: { id: artist.id },
        data: {
          ...(bio !== undefined && { bio }),
          ...(profileImageUrl !== undefined && { profileImageUrl }),
          ...(bannerImageUrl !== undefined && { bannerImageUrl }),
          ...(socialLinks !== undefined && { socialLinks }),
          ...(spotifyArtistId !== undefined && { spotifyArtistId }),
          ...(stageName !== undefined && { name: stageName }),
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
    body('audioUrl').optional({ nullable: true }).isString(),
    body('audioMimeType').optional({ nullable: true }).isString(),
    body('audioSize').optional({ nullable: true }).isInt({ min: 0 }),
    body('audioDurationMs').optional({ nullable: true }).isInt({ min: 0 }),
    body('genres').optional().isArray(),
    body('languages').optional().isArray(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const { title, lyrics, albumName, releaseYear, imageUrl, audioUrl, audioMimeType, audioSize, audioDurationMs, genres, languages } = req.body;
      const normalizedTitle = title.trim();

      // Friendly guard for the [title, artistId] unique constraint
      const existingSong = await prisma.song.findUnique({
        where: { title_artistId: { title: normalizedTitle, artistId: artist.id } },
        select: { id: true },
      });
      if (existingSong) {
        throw new ApiError(
          'You already have a song with this title. Choose a different title.',
          'CONFLICT',
          409,
        );
      }

      const song = await prisma.song.create({
        data: {
          title: normalizedTitle,
          artistId: artist.id,
          albumName: albumName ?? null,
          releaseYear: releaseYear ?? null,
          imageUrl: imageUrl ?? null,
          audioUrl: audioUrl ?? null,
          audioMimeType: audioMimeType ?? null,
          audioSize: audioSize ?? null,
          durationMs: audioDurationMs ?? null,
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
    body('audioUrl').optional({ nullable: true }).isString(),
    body('audioMimeType').optional({ nullable: true }).isString(),
    body('audioSize').optional({ nullable: true }).isInt({ min: 0 }),
    body('audioDurationMs').optional({ nullable: true }).isInt({ min: 0 }),
    body('genres').optional().isArray(),
    body('languages').optional().isArray(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const song = await prisma.song.findUnique({
        where: { id: req.params.id },
        select: { id: true, artistId: true, title: true },
      });
      if (!song) {
        throw new ApiError('Song not found', 'NOT_FOUND', 404);
      }
      if (song.artistId !== artist.id) {
        throw new ApiError('Access denied', 'FORBIDDEN', 403);
      }

      const { title, lyrics, albumName, releaseYear, imageUrl, audioUrl, audioMimeType, audioSize, audioDurationMs, genres, languages } = req.body;

      // Friendly guard for the [title, artistId] unique constraint (excluding this song)
      if (title !== undefined && title.trim().toLowerCase() !== song.title.toLowerCase()) {
        const duplicate = await prisma.song.findFirst({
          where: {
            title: title.trim(),
            artistId: artist.id,
            id: { not: song.id },
            softDeleted: false,
          },
          select: { id: true },
        });
        if (duplicate) {
          throw new ApiError(
            'You already have a song with this title. Choose a different title.',
            'CONFLICT',
            409,
          );
        }
      }

      await prisma.song.update({
        where: { id: song.id },
        data: {
          ...(title !== undefined && { title: title.trim() }),
          ...(albumName !== undefined && { albumName }),
          ...(releaseYear !== undefined && { releaseYear }),
          ...(imageUrl !== undefined && { imageUrl }),
          ...(audioUrl !== undefined && { audioUrl }),
          ...(audioMimeType !== undefined && { audioMimeType }),
          ...(audioSize !== undefined && { audioSize }),
          ...(audioDurationMs !== undefined && { durationMs: audioDurationMs }),
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
      const song = await prisma.song.findUnique({
        where: { id: req.params.id },
        select: { id: true, artistId: true },
      });
      if (!song) {
        throw new ApiError('Song not found', 'NOT_FOUND', 404);
      }
      if (song.artistId !== artist.id) {
        throw new ApiError('Access denied', 'FORBIDDEN', 403);
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
    body('releaseDate').optional().isISO8601().withMessage('Release date must be a valid date'),
    body('coverImageUrl').optional({ nullable: true }).isString(),
    body('status').optional().isIn(['DRAFT', 'SCHEDULED', 'PUBLISHED']).withMessage('Status must be DRAFT, SCHEDULED, or PUBLISHED'),
    body('songIds').optional().isArray().withMessage('songIds must be an array'),
    body('songIds.*').optional().isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const { title, type, releaseDate, coverImageUrl, status: requestedStatus, songIds } = req.body;

      const releaseDateObj = releaseDate ? new Date(releaseDate) : null;
      const now = new Date();

      // An explicit status wins; otherwise derive it from the release date.
      // "Publish now" (PUBLISHED without a date) records today as the effective
      // release date so the catalog/sort timeline shows it immediately.
      let status: 'DRAFT' | 'SCHEDULED' | 'PUBLISHED' = requestedStatus;
      if (!status) {
        status = releaseDateObj
          ? releaseDateObj <= now
            ? 'PUBLISHED'
            : 'SCHEDULED'
          : 'DRAFT';
      }

      // A scheduled release must have a future release date, otherwise it stays
      // hidden forever (the auto-publish job only matches releaseDate <= now).
      if (status === 'SCHEDULED' && (!releaseDateObj || releaseDateObj <= now)) {
        throw new ApiError(
          'A scheduled release requires a future release date',
          'BAD_REQUEST',
          400,
        );
      }

      const effectiveReleaseDate = !releaseDateObj && status === 'PUBLISHED' ? now : releaseDateObj;

      const selectedSongIds: string[] = Array.isArray(songIds) ? songIds : [];

      // Validate song ownership up-front
      if (selectedSongIds.length > 0) {
        const owned = await prisma.song.count({
          where: { id: { in: selectedSongIds }, artistId: artist.id, softDeleted: false },
        });
        if (owned !== selectedSongIds.length) {
          throw new ApiError('One or more songs do not belong to this artist', 'BAD_REQUEST', 400);
        }
      }

      const isPublished = status === 'PUBLISHED';

      const release = await prisma.$transaction(async (tx) => {
        const created = await tx.release.create({
          data: {
            artistId: artist.id,
            title: title.trim(),
            type,
            releaseDate: effectiveReleaseDate,
            coverImageUrl: coverImageUrl ?? null,
            status,
          },
        });

        if (selectedSongIds.length > 0) {
          await tx.song.updateMany({
            where: { id: { in: selectedSongIds } },
            data: {
              releaseId: created.id,
              released: isPublished,
            },
          });
          // Set track order based on the provided selection
          for (const [index, songId] of selectedSongIds.entries()) {
            await tx.song.update({
              where: { id: songId },
              data: { trackNumber: index + 1 },
            });
          }
        }

        return created;
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
    body('songIds').optional().isArray().withMessage('songIds must be an array'),
    body('songIds.*').optional().isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const release = await prisma.release.findUnique({
        where: { id: req.params.id },
        select: { id: true, artistId: true, status: true },
      });
      if (!release) {
        throw new ApiError('Release not found', 'NOT_FOUND', 404);
      }
      if (release.artistId !== artist.id) {
        throw new ApiError('Access denied', 'FORBIDDEN', 403);
      }

      const { title, type, releaseDate, coverImageUrl, status, songIds } = req.body;

      // Resolve the intended status: explicit status wins, otherwise derive
      // from the provided release date (past -> PUBLISHED, future -> SCHEDULED).
      let finalStatus = status;
      if (!finalStatus && releaseDate) {
        const d = new Date(releaseDate);
        finalStatus = d <= new Date() ? 'PUBLISHED' : 'SCHEDULED';
      }

      // A scheduled release must have a future release date, otherwise it stays
      // hidden forever (the auto-publish job only matches releaseDate <= now).
      if (finalStatus === 'SCHEDULED' && (!releaseDate || new Date(releaseDate) <= new Date())) {
        throw new ApiError(
          'A scheduled release requires a future release date',
          'BAD_REQUEST',
          400,
        );
      }

      // Validate status transitions (PUBLISHED is terminal — no unpublishing)
      if (finalStatus && finalStatus !== release.status) {
        const allowedTransitions: Record<string, string[]> = {
          DRAFT: ['SCHEDULED', 'PUBLISHED'],
          SCHEDULED: ['PUBLISHED'],
          PUBLISHED: [],
        };
        const allowed = allowedTransitions[release.status] ?? [];
        if (!allowed.includes(finalStatus)) {
          throw new ApiError(
            `Cannot transition from ${release.status} to ${finalStatus}`,
            'BAD_REQUEST',
            400,
          );
        }
      }

      const isPublished = finalStatus === 'PUBLISHED' || release.status === 'PUBLISHED';

      // "Publish now" (no date given) records today as the effective date
      const effectiveReleaseDate = finalStatus === 'PUBLISHED' && !releaseDate ? new Date() : releaseDate;

      const updated = await prisma.$transaction(async (tx) => {
        const upd = await tx.release.update({
          where: { id: release.id },
          data: {
            ...(title !== undefined && { title: title.trim() }),
            ...(type !== undefined && { type }),
            ...(effectiveReleaseDate !== undefined && { releaseDate: new Date(effectiveReleaseDate) }),
            ...(coverImageUrl !== undefined && { coverImageUrl }),
            ...(finalStatus !== undefined && { status: finalStatus }),
          },
        });

        if (Array.isArray(songIds)) {
          // Validate ownership of the new track list
          if (songIds.length > 0) {
            const owned = await tx.song.count({
              where: { id: { in: songIds }, artistId: artist.id, softDeleted: false },
            });
            if (owned !== songIds.length) {
              throw new ApiError('One or more songs do not belong to this artist', 'BAD_REQUEST', 400);
            }
          }

          // Detach songs no longer in the list (return them to private)
          const currentSongs = await tx.song.findMany({
            where: { releaseId: upd.id },
            select: { id: true },
          });
          const removedIds = currentSongs
            .map((s) => s.id)
            .filter((id) => !songIds.includes(id));
          if (removedIds.length > 0) {
            await tx.song.updateMany({
              where: { id: { in: removedIds } },
              data: { releaseId: null, released: false },
            });
          }

          // Attach the new track list in order
          for (const [index, songId] of songIds.entries()) {
            await tx.song.update({
              where: { id: songId },
              data: { releaseId: upd.id, trackNumber: index + 1, released: isPublished },
            });
          }
        } else if (isPublished) {
          await tx.song.updateMany({
            where: { releaseId: release.id },
            data: { released: true },
          });
        }

        return upd;
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
      const release = await prisma.release.findUnique({
        where: { id: req.params.id },
        select: { id: true, artistId: true, status: true },
      });
      if (!release) {
        throw new ApiError('Release not found', 'NOT_FOUND', 404);
      }
      if (release.artistId !== artist.id) {
        throw new ApiError('Access denied', 'FORBIDDEN', 403);
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

      if (release.status === 'PUBLISHED') {
        await prisma.song.updateMany({
          where: { id: { in: deduped }, artistId: artist.id },
          data: { released: true },
        });
      }

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
          include: {
            songs: {
              select: { id: true, title: true },
              orderBy: { trackNumber: 'asc' as const },
            },
            _count: { select: { songs: true } },
          },
          orderBy: { releaseDate: 'desc' as const },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.release.count({ where }),
      ]);

      const mapped = releases.map((r) => ({
        id: r.id,
        title: r.title,
        type: r.type,
        status: r.status,
        releaseDate: r.releaseDate,
        coverImageUrl: r.coverImageUrl,
        trackCount: r._count.songs,
        tracks: r.songs.map((s) => ({ songId: s.id, title: s.title })),
      }));

      res.status(200).json({ releases: mapped, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) });
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
  [query('rangeDays').optional().isIn(['7', '14', '30', '90', '365'])],
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
          durationMs: true,
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

// GET /api/artists/me/listener-regions
// Returns country and city breakdown of listeners for the artist.
artistPortalRouter.get(
  '/artists/me/listener-regions',
  authenticate,
  requireRole('ARTIST'),
  [query('rangeDays').optional().isIn(['7', '14', '30', '90', '365'])],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const rangeDays = typeof req.query.rangeDays === 'string' ? Number(req.query.rangeDays) : 30;

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - rangeDays);
      startDate.setHours(0, 0, 0, 0);

      const regionRows = await prisma.artistListenerRegion.findMany({
        where: {
          artistId: artist.id,
          date: { gte: startDate },
        },
        select: {
          country: true,
          city: true,
          listeners: true,
          plays: true,
        },
      });

      // Aggregate by country
      const countryMap = new Map<string, { listeners: number; plays: number }>();
      // Aggregate by city
      const cityMap = new Map<string, { country: string; listeners: number; plays: number }>();

      for (const row of regionRows) {
        // Country aggregation
        const existing = countryMap.get(row.country) || { listeners: 0, plays: 0 };
        existing.listeners += row.listeners;
        existing.plays += row.plays;
        countryMap.set(row.country, existing);

        // City aggregation
        const cityKey = `${row.city}, ${row.country}`;
        const existingCity = cityMap.get(cityKey) || { country: row.country, listeners: 0, plays: 0 };
        existingCity.listeners += row.listeners;
        existingCity.plays += row.plays;
        cityMap.set(cityKey, existingCity);
      }

      // Calculate total listeners across all regions
      let totalListeners = 0;
      for (const entry of countryMap.values()) {
        totalListeners += entry.listeners;
      }

      // Convert to sorted arrays
      const regions = Array.from(countryMap.entries())
        .map(([name, data]) => ({
          name,
          listeners: data.listeners,
          plays: data.plays,
          percentage: totalListeners > 0 ? Math.round((data.listeners / totalListeners) * 100) : 0,
        }))
        .sort((a, b) => b.listeners - a.listeners);

      const cities = Array.from(cityMap.entries())
        .map(([name, data]) => ({
          name: name.split(',')[0].trim(),
          country: data.country,
          listeners: data.listeners,
          plays: data.plays,
          percentage: totalListeners > 0 ? Math.round((data.listeners / totalListeners) * 100) : 0,
        }))
        .sort((a, b) => b.listeners - a.listeners)
        .slice(0, 10);

      res.status(200).json({
        rangeDays,
        totalListeners,
        regions,
        cities,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ─── GET /api/artists/me/notifications ─────────────────────────────────────
// Returns paginated notifications for the authenticated artist.

artistPortalRouter.get(
  '/artists/me/notifications',
  authenticate,
  requireRole('ARTIST'),
  [
    query('limit').optional().isInt({ min: 1, max: 50 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const limit = parseInt(req.query.limit as string) || 20;
      const offset = parseInt(req.query.offset as string) || 0;

      const [notifications, total] = await Promise.all([
        prisma.artistNotification.findMany({
          where: { artistId: artist.id },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          select: {
            id: true,
            type: true,
            message: true,
            metadata: true,
            isRead: true,
            createdAt: true,
          },
        }),
        prisma.artistNotification.count({
          where: { artistId: artist.id },
        }),
      ]);

      res.status(200).json({
        notifications: notifications.map((n) => ({
          id: n.id,
          type: n.type,
          message: n.message,
          metadata: n.metadata,
          isRead: n.isRead,
          timestamp: n.createdAt.toISOString(),
        })),
        total,
        unreadCount: await prisma.artistNotification.count({
          where: { artistId: artist.id, isRead: false },
        }),
      });
    } catch (error) {
      next(error);
    }
  },
);

// ─── PATCH /api/artists/me/notifications/:id ──────────────────────────────
// Mark a notification as read.

artistPortalRouter.patch(
  '/artists/me/notifications/:id',
  authenticate,
  requireRole('ARTIST'),
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const notification = await prisma.artistNotification.findUnique({
        where: { id: req.params.id },
        select: { id: true, artistId: true },
      });
      if (!notification) {
        throw new ApiError('Notification not found', 'NOT_FOUND', 404);
      }
      if (notification.artistId !== artist.id) {
        throw new ApiError('Access denied', 'FORBIDDEN', 403);
      }

      await prisma.artistNotification.update({
        where: { id: req.params.id },
        data: { isRead: true },
      });

      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// ─── DELETE /api/artists/me/notifications/:id ─────────────────────────────
// Delete a notification.

artistPortalRouter.delete(
  '/artists/me/notifications/:id',
  authenticate,
  requireRole('ARTIST'),
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const notification = await prisma.artistNotification.findUnique({
        where: { id: req.params.id },
        select: { id: true, artistId: true },
      });
      if (!notification) {
        throw new ApiError('Notification not found', 'NOT_FOUND', 404);
      }
      if (notification.artistId !== artist.id) {
        throw new ApiError('Access denied', 'FORBIDDEN', 403);
      }

      await prisma.artistNotification.delete({
        where: { id: req.params.id },
      });

      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// ─── DELETE /api/artists/me/releases/:id ──────────────────────────────────
// Delete a release and detach its tracks.

artistPortalRouter.delete(
  '/artists/me/releases/:id',
  authenticate,
  requireRole('ARTIST'),
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);
      const release = await prisma.release.findUnique({
        where: { id: req.params.id },
        select: { id: true, artistId: true },
      });
      if (!release) {
        throw new ApiError('Release not found', 'NOT_FOUND', 404);
      }
      if (release.artistId !== artist.id) {
        throw new ApiError('Access denied', 'FORBIDDEN', 403);
      }

      // Detach songs from this release and un-publish them so they return to private
      await prisma.song.updateMany({
        where: { releaseId: release.id },
        data: { releaseId: null, released: false },
      });

      await prisma.release.delete({
        where: { id: release.id },
      });

      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// DELETE /api/artists/me/account
// Soft-deletes the artist account and all associated data.
artistPortalRouter.delete(
  '/artists/me/account',
  authenticate,
  requireRole('ARTIST'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const artist = await getArtistFromUser(req.user!.id);

      // Soft-delete the artist
      await prisma.artist.update({
        where: { id: artist.id },
        data: { softDeleted: true },
      });

      // Soft-delete all songs
      await prisma.song.updateMany({
        where: { artistId: artist.id },
        data: { softDeleted: true },
      });

      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);
