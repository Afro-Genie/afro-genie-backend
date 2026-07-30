import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authenticate, optionalAuth } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { communityRedesignService } from '../services/communityRedesignService';
import { prisma } from '../lib/prisma';
import type { AuthUser } from '../types/auth';

export const communityRedesignRouter = Router();

// GET /api/community/feed — general recent feed
communityRedesignRouter.get(
  '/community/feed',
  optionalAuth,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    query('categoryId').optional().isString(),
    query('search').optional().isString(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req.user as AuthUser | undefined)?.id;
      const result = await communityRedesignService.getFeed(req.query as any, userId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/community/trending — hot topics with engagement velocity
communityRedesignRouter.get(
  '/community/trending',
  optionalAuth,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req.user as AuthUser | undefined)?.id;
      const result = await communityRedesignService.getTrending(req.query as any, userId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/community/moderator-picks — moderator-created topics only
communityRedesignRouter.get(
  '/community/moderator-picks',
  optionalAuth,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req.user as AuthUser | undefined)?.id;
      const result = await communityRedesignService.getModeratorPicks(req.query as any, userId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/community/for-you — personalized recommendations
communityRedesignRouter.get(
  '/community/for-you',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const result = await communityRedesignService.getForYou(user.id, req.query as any);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/community/explore/what-others-listen — aggregated listening data
communityRedesignRouter.get(
  '/community/explore/what-others-listen',
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await communityRedesignService.getExploreData();
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/community/recommended-moderators — top moderators
communityRedesignRouter.get(
  '/community/recommended-moderators',
  optionalAuth,
  [
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const result = await communityRedesignService.getRecommendedModerators(limit);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/community/topics/:id/view — record a topic view
communityRedesignRouter.post(
  '/community/topics/:id/view',
  optionalAuth,
  [param('id').isString(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req.user as AuthUser | undefined)?.id;
      const result = await communityRedesignService.recordTopicView(req.params.id, userId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/users/listening-preferences/compute — compute listening prefs
communityRedesignRouter.post(
  '/users/listening-preferences/compute',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const result = await communityRedesignService.computeListeningPreferences(user.id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/users/listening-preferences — get current prefs
communityRedesignRouter.get(
  '/users/listening-preferences',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const prefs = await prisma.userListeningPreference.findUnique({
        where: { userId: user.id },
      });
      res.json(prefs || { genreIds: [], languageCodes: [], listenedArtistIds: [] });
    } catch (error) {
      next(error);
    }
  },
);
