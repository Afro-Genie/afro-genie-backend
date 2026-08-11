import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { param, query } from 'express-validator';
import { authenticate, optionalAuth } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { ApiError } from '../middleware/errorHandler';
import { getBalance, getLedger, getProfile } from '../services/tokenService';
import {
  getLeaderboard,
  getMyRank,
  isLeaderboardPeriod,
  isLeaderboardScope,
  type LeaderboardPeriod,
  type LeaderboardScope,
} from '../services/leaderboardService';
import { getSeasons, getSeason } from '../services/seasonService';
import { featureGate } from '../config/featureFlags';
import type { AuthUser } from '../types/auth';

export const tokensRouter = Router();

// Phase 4: seasonal snapshots are feature-flagged (BACKEND_FLAG_SEASONS).
const seasonsGate = featureGate('SEASONS');

// ---------------------------------------------------------------------------
// GET /api/users/:userId/profile
// Public. Server-computed token balance + badges + membership.
// ---------------------------------------------------------------------------
tokensRouter.get(
  '/users/:userId/profile',
  optionalAuth,
  [param('userId').isString().notEmpty().withMessage('User id is required'), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = await getProfile(req.params.userId);
      return res.status(200).json(profile);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/users/me/tokens?page=&limit=
// Authenticated. Paginated ledger for the signed-in user.
// ---------------------------------------------------------------------------
tokensRouter.get(
  '/users/me/tokens',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const result = await getLedger(user.id, page, limit);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/community/leaderboard?period=all|week|month&scope=tokens|quality
// Public. Top contributors by tokens earned (or approved translations for
// scope=quality) in the period.
// ---------------------------------------------------------------------------
tokensRouter.get(
  '/community/leaderboard',
  optionalAuth,
  [
    query('period').optional().isString().withMessage('period must be all, week, or month'),
    query('scope').optional().isString().withMessage('scope must be tokens or quality'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const period = (req.query.period ?? 'all') as string;
      const scope = (req.query.scope ?? 'tokens') as string;
      if (!isLeaderboardPeriod(period)) {
        return next(new ApiError('period must be all, week, or month', 'VALIDATION_ERROR', 400));
      }
      if (!isLeaderboardScope(scope)) {
        return next(new ApiError('scope must be tokens or quality', 'VALIDATION_ERROR', 400));
      }
      const { entries } = await getLeaderboard(period, 100, scope as LeaderboardScope);
      return res.status(200).json(entries);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/community/leaderboard/me?period=&scope=
// Authenticated. Signed-in user's rank + totals.
// ---------------------------------------------------------------------------
tokensRouter.get(
  '/community/leaderboard/me',
  authenticate,
  [
    query('period').optional().isString().withMessage('period must be all, week, or month'),
    query('scope').optional().isString().withMessage('scope must be tokens or quality'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const period = (req.query.period ?? 'all') as string;
      const scope = (req.query.scope ?? 'tokens') as string;
      if (!isLeaderboardPeriod(period)) {
        return next(new ApiError('period must be all, week, or month', 'VALIDATION_ERROR', 400));
      }
      if (!isLeaderboardScope(scope)) {
        return next(new ApiError('scope must be tokens or quality', 'VALIDATION_ERROR', 400));
      }
      const result = await getMyRank(period as LeaderboardPeriod, user.id, scope as LeaderboardScope);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/community/leaderboard/seasons
// Public. Frozen monthly leaderboard snapshots (period, top 3).
// ---------------------------------------------------------------------------
tokensRouter.get(
  '/community/leaderboard/seasons',
  seasonsGate,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const seasons = await getSeasons();
      return res.status(200).json(seasons);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/community/leaderboard/seasons/:id
// Public. Full frozen snapshot for one season.
// ---------------------------------------------------------------------------
tokensRouter.get(
  '/community/leaderboard/seasons/:id',
  [param('id').isString().notEmpty().withMessage('Season id is required'), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const season = await getSeason(req.params.id);
      return res.status(200).json(season);
    } catch (err) {
      return next(err);
    }
  },
);
