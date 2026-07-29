import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../middleware/errorHandler';
import { queueReward } from '../../services/rewardService';
import { logger } from '../../lib/logger';

export const adminTranslationsRouter = Router();

adminTranslationsRouter.use(authenticate, requireRole('MODERATOR', 'ADMIN'));

adminTranslationsRouter.patch(
  '/translations/corrections/:id',
  [
    param('id').isString().notEmpty(),
    body('status').isIn(['APPROVED', 'REJECTED']).withMessage('Status must be APPROVED or REJECTED'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const correctionId = req.params.id;
      const { status } = req.body as { status: 'APPROVED' | 'REJECTED' };
      const moderatorId = req.user!.id;

      const correction = await prisma.translationCorrection.findUnique({
        where: { id: correctionId },
        include: { translation: { select: { id: true, translatedLyrics: true, culturalContext: true } } },
      });

      if (!correction) throw new ApiError('Correction not found', 'NOT_FOUND', 404);
      if (correction.status !== 'PENDING') throw new ApiError('Correction is not in PENDING status', 'CONFLICT', 409);

      if (status === 'APPROVED') {
        await prisma.$transaction([
          prisma.translation.update({
            where: { id: correction.translationId },
            data: {
              translatedLyrics: correction.suggestedText,
              updatedAt: new Date(),
            },
          }),
          prisma.translationCorrection.update({
            where: { id: correctionId },
            data: { status: 'APPROVED' },
          }),
        ]);

        await queueReward(moderatorId, 3, 'Correction approved', 'MODERATOR_ACTION', `correction-approve:${correctionId}:${moderatorId}`);

        await prisma.notification.create({
          data: {
            userId: correction.userId,
            title: 'Correction Approved',
            message: 'Your suggested correction has been approved and applied to the translation.',
            type: 'REWARD',
          },
        });
      } else {
        await prisma.translationCorrection.update({
          where: { id: correctionId },
          data: { status: 'REJECTED' },
        });

        await prisma.notification.create({
          data: {
            userId: correction.userId,
            title: 'Correction Not Approved',
            message: 'Your suggested correction was not approved by the moderator.',
            type: 'MODERATION',
          },
        });
      }

      logger.info({ correctionId, status, moderatorId }, 'Correction reviewed');

      res.json({ id: correctionId, status });
    } catch (error) {
      next(error);
    }
  },
);

adminTranslationsRouter.post(
  '/translations/:id/reject',
  [
    param('id').isString().notEmpty(),
    body('reason').optional().isString().isLength({ max: 500 }),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const translationId = req.params.id;
      const { reason } = req.body as { reason?: string };
      const moderatorId = req.user!.id;

      const translation = await prisma.translation.findUnique({
        where: { id: translationId },
        select: { id: true, userId: true, status: true },
      });

      if (!translation) throw new ApiError('Translation not found', 'NOT_FOUND', 404);
      if (translation.status !== 'APPROVED' && translation.status !== 'PENDING') {
        throw new ApiError('Translation cannot be rejected in its current state', 'CONFLICT', 409);
      }

      await prisma.translation.update({
        where: { id: translationId },
        data: { status: 'REJECTED', updatedAt: new Date() },
      });

      await prisma.notification.create({
        data: {
          userId: translation.userId,
          title: 'Translation Rejected',
          message: reason
            ? `Your translation was rejected: ${reason}`
            : 'Your translation was rejected by a moderator.',
          type: 'MODERATION',
        },
      });

      logger.info({ translationId, moderatorId, reason }, 'Translation rejected');

      res.json({ id: translationId, status: 'REJECTED' as const });
    } catch (error) {
      next(error);
    }
  },
);
