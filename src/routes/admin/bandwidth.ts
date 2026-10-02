import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from 'express-validator';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import {
  BANDWIDTH_THRESHOLDS,
  getBandwidthAlerts,
  getBandwidthByGroup,
  getBandwidthDaily,
} from '../../lib/bandwidthMonitor';

export const adminBandwidthRouter = Router();

adminBandwidthRouter.use(authenticate, requireRole('ADMIN'));

const bandwidthReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bandwidth requests. Please wait.', code: 'RATE_LIMITED' },
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
});

// ---------------------------------------------------------------------------
// GET /api/admin/bandwidth/daily?days=30
// Outbound bytes per day (most recent N days).
// ---------------------------------------------------------------------------
adminBandwidthRouter.get(
  '/bandwidth/daily',
  bandwidthReadLimiter,
  [
    query('days')
      .optional()
      .isInt({ min: 1, max: 90 })
      .withMessage('days must be an integer between 1 and 90')
      .toInt(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const days = (req.query.days as number | undefined) ?? 30;
      const points = await getBandwidthDaily(days);
      res.status(200).json({
        series: points,
        thresholds: BANDWIDTH_THRESHOLDS,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/admin/bandwidth/by-worker?days=7
// Outbound bytes attributed to route groups (proxies worker usage).
// ---------------------------------------------------------------------------
adminBandwidthRouter.get(
  '/bandwidth/by-worker',
  bandwidthReadLimiter,
  [
    query('days')
      .optional()
      .isInt({ min: 1, max: 90 })
      .withMessage('days must be an integer between 1 and 90')
      .toInt(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const days = (req.query.days as number | undefined) ?? 7;
      const rows = await getBandwidthByGroup(days);
      res.status(200).json({ groups: rows });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/admin/bandwidth/alerts?limit=50
// Most recent alert records and today's running totals.
// ---------------------------------------------------------------------------
adminBandwidthRouter.get(
  '/bandwidth/alerts',
  bandwidthReadLimiter,
  [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('limit must be an integer between 1 and 100')
      .toInt(),
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = (req.query.limit as number | undefined) ?? 50;
      const alerts = await getBandwidthAlerts(limit);
      res.status(200).json({ alerts });
    } catch (err) {
      next(err);
    }
  }
);