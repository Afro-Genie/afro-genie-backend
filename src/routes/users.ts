import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param } from 'express-validator';
import { validateRequest } from '../middleware/validateRequest';
import { authenticate } from '../middleware/auth';
import { prisma } from '../lib/prisma';

const FAVORITES_LIMIT = 5;
const HISTORY_LIMIT = 5;

export const usersRouter = Router();

// ── History ──────────────────────────────────────────────────

// POST /api/users/history — record a song view
usersRouter.post(
  '/users/history',
  authenticate,
  [body('songId').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req.user as any).id;
      const { songId } = req.body;

      // Upsert: update viewedAt if the user already has this song in history
      const existing = await prisma.userHistory.findFirst({
        where: { userId, songId },
      });

      if (existing) {
        await prisma.userHistory.update({
          where: { id: existing.id },
          data: { viewedAt: new Date() },
        });
      } else {
        await prisma.userHistory.create({
          data: { userId, songId },
        });

        // Trim to most recent HISTORY_LIMIT entries
        const allEntries = await prisma.userHistory.findMany({
          where: { userId },
          orderBy: { viewedAt: 'desc' },
          select: { id: true },
        });

        if (allEntries.length > HISTORY_LIMIT) {
          const idsToDelete = allEntries.slice(HISTORY_LIMIT).map((e) => e.id);
          await prisma.userHistory.deleteMany({
            where: { id: { in: idsToDelete } },
          });
        }
      }

      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/users/history — fetch recent history
usersRouter.get(
  '/users/history',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req.user as any).id;

      const entries = await prisma.userHistory.findMany({
        where: { userId },
        orderBy: { viewedAt: 'desc' },
        take: HISTORY_LIMIT,
        include: {
          song: {
            select: {
              id: true,
              title: true,
              artist: { select: { name: true } },
            },
          },
        },
      });

      const history = entries.map((e) => ({
        songId: e.songId,
        songTitle: e.song.title,
        artistName: e.song.artist?.name ?? '',
        viewedAt: e.viewedAt,
      }));

      res.status(200).json(history);
    } catch (error) {
      next(error);
    }
  },
);

// ── Favorites ────────────────────────────────────────────────

// GET /api/users/favorites
usersRouter.get(
  '/users/favorites',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req.user as any).id;

      const entries = await prisma.favorite.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        include: {
          song: {
            select: {
              id: true,
              title: true,
              artist: { select: { name: true } },
            },
          },
        },
      });

      const favorites = entries.map((e) => ({
        id: e.id,
        songId: e.songId,
        songTitle: e.song.title,
        artistName: e.song.artist?.name ?? '',
        createdAt: e.createdAt,
      }));

      res.status(200).json(favorites);
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/users/favorites
usersRouter.post(
  '/users/favorites',
  authenticate,
  [body('songId').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req.user as any).id;
      const { songId } = req.body;

      // Check limit
      const count = await prisma.favorite.count({ where: { userId } });
      if (count >= FAVORITES_LIMIT) {
        res.status(400).json({ error: `Favorites limit reached (${FAVORITES_LIMIT}). Remove one first.` });
        return;
      }

      // Check duplicate
      const existing = await prisma.favorite.findFirst({
        where: { userId, songId },
      });
      if (existing) {
        res.status(200).json({ id: existing.id, success: true });
        return;
      }

      const favorite = await prisma.favorite.create({
        data: { userId, songId },
      });

      res.status(200).json({ id: favorite.id, success: true });
    } catch (error) {
      next(error);
    }
  },
);

// DELETE /api/users/me — self-service account deletion
usersRouter.delete(
  '/users/me',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req.user as any).id;

      await prisma.user.delete({ where: { id: userId } });

      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// DELETE /api/users/favorites/:id
usersRouter.delete(
  '/users/favorites/:id',
  authenticate,
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req.user as any).id;
      const { id } = req.params;

      await prisma.favorite.deleteMany({
        where: { id, userId },
      });

      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// PUT /api/users/me — update own profile
usersRouter.put(
  '/users/me',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req.user as any).id;
      const { displayName, photoUrl } = req.body;

      const data: Record<string, any> = {};
      if (displayName !== undefined) data.displayName = displayName;
      if (photoUrl !== undefined) data.photoUrl = photoUrl;

      const user = await prisma.user.update({
        where: { id: userId },
        data,
        select: {
          id: true,
          email: true,
          displayName: true,
          photoUrl: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      res.status(200).json(user);
    } catch (error) {
      next(error);
    }
  },
);
