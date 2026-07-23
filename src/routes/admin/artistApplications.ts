import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import type { Prisma } from '@prisma/client';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../middleware/errorHandler';
import {
  sendApplicationApproved,
  sendApplicationRejected,
} from '../../services/emailService';
import { enqueueIndexArtist } from '../../jobs/searchIndexJob';

export const adminArtistApplicationsRouter = Router();

// All routes require ADMIN authentication
adminArtistApplicationsRouter.use(authenticate, requireRole('ADMIN'));

// ─── GET /api/admin/artist-applications ──────────────────────────────────────
// Paginated list of artist applications, filterable by status.

adminArtistApplicationsRouter.get(
  '/artist-applications',
  [
    query('cursor').optional().isString(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED']),
    query('search').optional().isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const cursor = req.query.cursor as string | undefined;
      const status = req.query.status as string | undefined;
      const search = req.query.search as string | undefined;

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { stageName: { contains: search, mode: 'insensitive' } },
          { genre: { contains: search, mode: 'insensitive' } },
          { user: { email: { contains: search, mode: 'insensitive' } } },
        ];
      }

      const [applications, total] = await Promise.all([
        prisma.artistApplication.findMany({
          where,
          include: {
            user: {
              select: {
                id: true,
                email: true,
                displayName: true,
                photoUrl: true,
                role: true,
              },
            },
            reviewedBy: {
              select: {
                id: true,
                displayName: true,
                email: true,
              },
            },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
        prisma.artistApplication.count({ where }),
      ]);

      const hasMore = applications.length > limit;
      const data = hasMore ? applications.slice(0, limit) : applications;
      const nextCursor = hasMore ? data[data.length - 1].id : null;

      res.status(200).json({ data, total, nextCursor });
    } catch (error) {
      next(error);
    }
  },
);

// ─── GET /api/admin/artist-applications/:id ──────────────────────────────────
// Get a single application with full details.

adminArtistApplicationsRouter.get(
  '/artist-applications/:id',
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const application = await prisma.artistApplication.findUnique({
        where: { id: req.params.id },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              displayName: true,
              photoUrl: true,
              role: true,
              createdAt: true,
            },
          },
          reviewedBy: {
            select: {
              id: true,
              displayName: true,
              email: true,
            },
          },
        },
      });

      if (!application) {
        throw new ApiError('Application not found', 'NOT_FOUND', 404);
      }

      res.status(200).json(application);
    } catch (error) {
      next(error);
    }
  },
);

// ─── PATCH /api/admin/artist-applications/:id ────────────────────────────────
// Approve or reject an artist application.

adminArtistApplicationsRouter.patch(
  '/artist-applications/:id',
  [
    param('id').isString().notEmpty(),
    body('status')
      .isIn(['APPROVED', 'REJECTED'])
      .withMessage('Status must be APPROVED or REJECTED'),
    body('rejectionReason').optional({ nullable: true }).isString(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { status, rejectionReason } = req.body as {
        status: 'APPROVED' | 'REJECTED';
        rejectionReason?: string;
      };
      const adminId = req.user!.id;

      const application = await prisma.artistApplication.findUnique({
        where: { id },
        include: { user: true },
      });

      if (!application) {
        throw new ApiError('Application not found', 'NOT_FOUND', 404);
      }

      if (application.status !== 'PENDING' && application.status !== 'UNDER_REVIEW') {
        throw new ApiError(
          `Application has already been ${application.status.toLowerCase()}`,
          'CONFLICT',
          409,
        );
      }

      if (status === 'REJECTED' && !rejectionReason) {
        throw new ApiError('Rejection reason is required', 'VALIDATION_ERROR', 400);
      }

      // Perform approval/rejection in a transaction
      const result = await prisma.$transaction(async (tx) => {
        // Update the application
        const updated = await tx.artistApplication.update({
          where: { id },
          data: {
            status,
            rejectionReason: status === 'REJECTED' ? rejectionReason ?? null : null,
            reviewedByUserId: adminId,
            reviewedAt: new Date(),
          },
          include: {
            user: {
              select: { id: true, email: true, displayName: true, role: true },
            },
          },
        });

        if (status === 'APPROVED') {
          // Upgrade user role to ARTIST
          await tx.user.update({
            where: { id: application.userId },
            data: { role: 'ARTIST' },
          });

          // Create or link Artist row
          const existingArtist = await tx.artist.findUnique({
            where: { userId: application.userId },
            select: { id: true },
          });

          if (existingArtist) {
            // Link existing artist to user
            await tx.artist.update({
              where: { id: existingArtist.id },
              data: {
                userId: application.userId,
                bio: application.bio,
                socialLinks: application.socialLinks as Prisma.InputJsonValue,
              },
            });
          } else {
            // Create new Artist row
            const newArtist = await tx.artist.create({
              data: {
                userId: application.userId,
                name: application.stageName,
                bio: application.bio,
                socialLinks: application.socialLinks as Prisma.InputJsonValue,
                verified: true,
              },
            });

            // Index in Typesense
            enqueueIndexArtist(newArtist.id).catch(() => {});
          }
        }

        return updated;
      });

      // Send email (non-blocking)
      const userEmail = application.user.email;
      if (userEmail) {
        if (status === 'APPROVED') {
          sendApplicationApproved(userEmail, application.stageName).catch(() => {});
        } else {
          sendApplicationRejected(userEmail, application.stageName, rejectionReason).catch(() => {});
        }
      }

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
);
