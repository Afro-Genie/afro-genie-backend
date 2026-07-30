import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { param } from 'express-validator';
import { authenticate, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { takeLeaderboardSnapshot, getSeasonalSnapshots, getSnapshotById } from '../services/leaderboardSnapshotService';
import { ApiError } from '../middleware/errorHandler';

export const leaderboardHistoryRouter = Router();

leaderboardHistoryRouter.get(
  '/leaderboard/seasons',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const snapshots = await getSeasonalSnapshots();
      res.json(snapshots);
    } catch (error) {
      next(error);
    }
  },
);

leaderboardHistoryRouter.get(
  '/leaderboard/seasons/:id',
  [param('id').isString().notEmpty()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const snapshot = await getSnapshotById(req.params.id);
      if (!snapshot) {
        throw new ApiError('Snapshot not found', 'NOT_FOUND', 404);
      }
      res.json(snapshot);
    } catch (error) {
      next(error);
    }
  },
);

leaderboardHistoryRouter.post(
  '/admin/leaderboard/snapshot',
  authenticate,
  requireRole('ADMIN'),
  [param('period').optional().isString()],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const period = (req.body.period as string) || 'monthly';
      const result = await takeLeaderboardSnapshot(period);
      if (!result.success) {
        throw new ApiError('Snapshot already exists for this period', 'ALREADY_EXISTS', 409);
      }
      res.json({ success: true, snapshotId: result.snapshotId });
    } catch (error) {
      next(error);
    }
  },
);
