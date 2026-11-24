import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { LicenseStatus, LyricSourceProvider } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../middleware/errorHandler';
import { logger } from '../../lib/logger';
import { logModAction } from '../../services/moderationAuditService';
import { parseLrcTimestamps, upsertLyrics } from '../../services/lyricsService';

export const adminLyricsRouter = Router();

adminLyricsRouter.use(authenticate, requireRole('MODERATOR', 'ADMIN'));

adminLyricsRouter.patch(
  '/lyrics/:songId',
  [
    param('songId').isString().notEmpty(),
    body('content').isString().notEmpty().withMessage('Lyrics content is required'),
    body('syncedLyrics').optional({ nullable: true }).isString(),
    body('lyricLines').optional({ nullable: true }).isArray(),
    body('lyricLines.*.time').optional().isNumeric(),
    body('lyricLines.*.text').optional().isString(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const songId = req.params.songId;
      const { content, syncedLyrics, lyricLines } = req.body as {
        content: string;
        syncedLyrics?: string | null;
        lyricLines?: Array<{ time: number; text: string }> | null;
      };
      const moderatorId = req.user!.id;

      const song = await prisma.song.findUnique({
        where: { id: songId },
        select: {
          title: true,
          artist: { select: { userId: true, name: true } },
        },
      });

      if (!song) {
        throw new ApiError('Song not found', 'NOT_FOUND', 404);
      }

      const normalizedLines = Array.isArray(lyricLines)
        ? lyricLines
            .filter((line) => line && typeof line.text === 'string' && line.text.trim())
            .map((line) => ({ time: Number(line.time) || 0, text: line.text.trim() }))
            .sort((a, b) => a.time - b.time)
        : null;
      const parsedFromLrc = syncedLyrics?.trim() ? parseLrcTimestamps(syncedLyrics) : null;

      await upsertLyrics(
        songId,
        {
          rawText: content,
          syncedLyrics: syncedLyrics ?? null,
          lyricLines: normalizedLines?.length ? normalizedLines : parsedFromLrc,
        },
        { sourceProvider: LyricSourceProvider.MANUAL, licenseStatus: LicenseStatus.UNKNOWN, markBackfillResolved: true },
      );

      await logModAction({
        moderatorId,
        actionType: 'LYRICS_EDIT',
        targetId: songId,
        targetType: 'song',
        details: `Edited lyrics for "${song.title}"`,
      });

      if (song.artist?.userId) {
        await prisma.notification.create({
          data: {
            userId: song.artist.userId,
            title: 'Lyrics Updated',
            message: `Your lyrics for "${song.title}" have been updated by a moderator.`,
            type: 'MODERATION',
          },
        });
      }

      logger.info({ songId, moderatorId, songTitle: song.title }, 'Lyrics updated by moderator');

      res.json({ id: songId, content, updatedBy: moderatorId });
    } catch (error) {
      next(error);
    }
  },
);
