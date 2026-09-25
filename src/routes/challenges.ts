import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { param } from 'express-validator';
import { authenticate } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import {
  claimChallengeReward,
  getChallengeProgress,
  getCurrentChallenges,
} from '../services/challengeService';

export const challengesRouter = Router();

// ---------------------------------------------------------------------------
// GET /api/challenges
// Open challenges with the caller's progress merged in.
// ---------------------------------------------------------------------------
challengesRouter.get(
  '/challenges',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const challenges = await getCurrentChallenges(req.user!.id);
      return res.status(200).json(challenges);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/challenges/:id/progress
// ---------------------------------------------------------------------------
challengesRouter.get(
  '/challenges/:id/progress',
  authenticate,
  [param('id').isString().notEmpty().withMessage('Challenge id is required'), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const progress = await getChallengeProgress(req.user!.id, req.params.id);
      return res.status(200).json({ challengeId: req.params.id, ...progress });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/challenges/:id/claim
// ---------------------------------------------------------------------------
challengesRouter.post(
  '/challenges/:id/claim',
  authenticate,
  [param('id').isString().notEmpty().withMessage('Challenge id is required'), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await claimChallengeReward(req.user!.id, req.params.id);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);