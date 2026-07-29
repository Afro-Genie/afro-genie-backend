import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body } from 'express-validator';
import { authenticate } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { getOrCreateReferralCode, applyReferral, getMyReferrals } from '../services/referralService';
import { ApiError } from '../middleware/errorHandler';

export const referralsRouter = Router();

referralsRouter.get(
  '/referrals/me',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getMyReferrals(req.user!.id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

referralsRouter.post(
  '/referrals/code',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = await getOrCreateReferralCode(req.user!.id);
      res.json({ code });
    } catch (error) {
      next(error);
    }
  },
);

referralsRouter.post(
  '/referrals/apply',
  authenticate,
  [body('code').isString().notEmpty().withMessage('Referral code is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code } = req.body as { code: string };
      const result = await applyReferral(code, req.user!.id);
      if (!result.success) {
        throw new ApiError(result.message, 'REFERRAL_FAILED', 400);
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);
