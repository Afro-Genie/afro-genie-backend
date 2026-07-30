import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body } from 'express-validator';
import { authenticate } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { prisma } from '../lib/prisma';
import { ApiError } from '../middleware/errorHandler';
import { logger } from '../lib/logger';

export const moderationRouter = Router();

moderationRouter.post(
  '/moderation/report',
  authenticate,
  [
    body('targetType').isString().notEmpty().withMessage('targetType is required'),
    body('targetId').isString().notEmpty().withMessage('targetId is required'),
    body('reason').isString().notEmpty().isLength({ min: 10, max: 500 }).withMessage('Reason must be 10-500 characters'),
    body('description').optional().isString().isLength({ max: 2000 }),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reporterId = req.user!.id;
      const { targetType, targetId, reason, description } = req.body as {
        targetType: string;
        targetId: string;
        reason: string;
        description?: string;
      };

      const validTypes = ['translation', 'topic', 'comment', 'correction', 'song'];
      if (!validTypes.includes(targetType)) {
        throw new ApiError(`Invalid targetType. Must be one of: ${validTypes.join(', ')}`, 'VALIDATION_ERROR', 400);
      }

      const report = await prisma.contentReport.create({
        data: { reporterId, targetType, targetId, reason, description: description ?? null },
        select: { id: true, status: true, createdAt: true },
      });

      logger.info({ reportId: report.id, reporterId, targetType, targetId }, 'Content report submitted');

      let targetAuthorId: string | null = null;
      switch (targetType) {
        case 'translation': {
          const t = await prisma.translation.findUnique({ where: { id: targetId }, select: { userId: true } });
          targetAuthorId = t?.userId ?? null;
          break;
        }
        case 'topic': {
          const t = await prisma.topic.findUnique({ where: { id: targetId }, select: { authorId: true } });
          targetAuthorId = t?.authorId ?? null;
          break;
        }
        case 'comment': {
          const c = await prisma.topicComment.findUnique({ where: { id: targetId }, select: { userId: true } });
          targetAuthorId = c?.userId ?? null;
          break;
        }
        case 'correction': {
          const c = await prisma.translationCorrection.findUnique({ where: { id: targetId }, select: { userId: true } });
          targetAuthorId = c?.userId ?? null;
          break;
        }
        case 'song': {
          const song = await prisma.song.findUnique({
            where: { id: targetId },
            select: { artist: { select: { userId: true } } },
          });
          targetAuthorId = song?.artist?.userId ?? null;
          break;
        }
      }

      if (targetAuthorId) {
        await prisma.notification.create({
          data: {
            userId: targetAuthorId,
            title: 'Content Flagged',
            message: `Your ${targetType} has been reported for: ${reason}`,
            type: 'FLAGGED_CONTENT',
          },
        });
      }

      res.status(201).json(report);
    } catch (error) {
      next(error);
    }
  },
);
