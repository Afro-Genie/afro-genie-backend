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

export const adminLyricsRouter = Router();

adminLyricsRouter.use(authenticate, requireRole('MODERATOR', 'ADMIN'));

adminLyricsRouter.patch(
  '/lyrics/:songId',
  [
    param('songId').isString().notEmpty(),
    body('content').isString().notEmpty().withMessage('Lyrics content is required'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const songId = req.params.songId;
      const { content } = req.body as { content: string };
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

      await prisma.lyric.upsert({
        where: { songId },
        create: {
          songId,
          content,
          sourceProvider: LyricSourceProvider.MANUAL,
          licenseStatus: LicenseStatus.UNKNOWN,
        },
        update: { content },
      });

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
