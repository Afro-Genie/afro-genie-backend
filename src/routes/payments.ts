import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body, param, query } from 'express-validator';
import { authenticate } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { ApiError } from '../middleware/errorHandler';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { createRedisRateLimitStore } from '../lib/rateLimitStore';
import { prisma } from '../lib/prisma';
import {
  getBundles,
  getPurchaseHistory,
  handleWebhook,
  initializePayment,
  verifyPayment,
} from '../services/paymentService';
import type { AuthUser } from '../types/auth';

export const paymentsRouter = Router();

type RequestWithRawBody = Request & { rawBody?: Buffer };

// ---------------------------------------------------------------------------
// Rate limits on the two endpoints that cost money to serve.
//
// The global /api limiter (app.ts) allows 100 req/min/IP and keys on IP, which is
// the wrong shape for these: `initialize` creates a Paystack transaction AND a
// GtPurchase row per call, and `verify` spends a Paystack API call (a metered,
// billable quota) and can mutate the purchase row. Shared-NAT office egress also
// means one IP can be many users, so the global limit is not a per-user control
// at all. Both are keyed on user id, so a single account cannot exhaust the
// provider quota or flood the table, while other buyers are unaffected.
//
// The webhook is deliberately NOT rate limited beyond the global /api limiter:
// Paystack retries on non-2xx, so throttling it would turn a transient blip into
// a permanently uncredited payment. It is protected by the HMAC signature
// instead, which is the control that actually limits who can spend our time.
// ---------------------------------------------------------------------------

const initializeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisRateLimitStore('payments-initialize'),
  keyGenerator: (req) => (req.user as AuthUser | undefined)?.id ?? req.ip ?? 'unknown',
  message: { error: 'Too many payment attempts. Please wait.', code: 'RATE_LIMITED' },
});

const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisRateLimitStore('payments-verify'),
  keyGenerator: (req) => (req.user as AuthUser | undefined)?.id ?? req.ip ?? 'unknown',
  message: { error: 'Too many payment checks. Please wait.', code: 'RATE_LIMITED' },
});

// ---------------------------------------------------------------------------
// GET /api/payments/bundles
// Public. Active GT bundles ordered for the Buy GT page.
// ---------------------------------------------------------------------------
paymentsRouter.get(
  '/payments/bundles',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const bundles = await getBundles();
      return res.status(200).json(bundles);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/payments/history?page=&limit=
// Authenticated. Signed-in user's GT purchase history.
// ---------------------------------------------------------------------------
paymentsRouter.get(
  '/payments/history',
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
      const result = await getPurchaseHistory(user.id, page, limit);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/payments/initialize
// Body { bundleId }. Creates a purchase and returns Paystack checkout data.
// ---------------------------------------------------------------------------
paymentsRouter.post(
  '/payments/initialize',
  authenticate,
  initializeLimiter,
  [body('bundleId').isString().notEmpty().withMessage('bundleId is required'), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;
      const { bundleId } = req.body as { bundleId: string };
      const result = await initializePayment(user.id, bundleId);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/payments/verify/:reference
// Authenticated. Verifies with Paystack and credits GT once.
// ---------------------------------------------------------------------------
paymentsRouter.get(
  '/payments/verify/:reference',
  authenticate,
  verifyLimiter,
  [param('reference').isString().notEmpty().withMessage('reference is required'), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as AuthUser;

      // Ownership check: only the buyer may trigger/observe a verify.
      const purchase = await prisma.gtPurchase.findFirst({
        where: { OR: [{ id: req.params.reference }, { paystackRef: req.params.reference }] },
        select: { userId: true },
      });
      if (!purchase || purchase.userId !== user.id) {
        throw new ApiError('Purchase not found', 'NOT_FOUND', 404);
      }

      const result = await verifyPayment(req.params.reference);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/payments/webhook
// NO AUTH. Paystack calls this on charge success. The x-paystack-signature
// header is an HMAC-SHA512 of the raw request body, keyed by the secret key.
// ---------------------------------------------------------------------------
paymentsRouter.post(
  '/payments/webhook',
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const secret = env.PAYSTACK_SECRET_KEY;
      if (!secret) {
        return res.status(503).json({ error: 'Payments not configured', code: 'PAYMENTS_NOT_CONFIGURED' });
      }

      const signature = req.headers['x-paystack-signature'];
      const rawBody = (req as RequestWithRawBody).rawBody;

      if (typeof signature !== 'string' || !rawBody) {
        return res.status(400).json({ error: 'Missing signature', code: 'INVALID_SIGNATURE' });
      }

      const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
      const signatureBuffer = Buffer.from(signature, 'utf8');
      const expectedBuffer = Buffer.from(expected, 'utf8');

      if (
        signatureBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(signatureBuffer, expectedBuffer)
      ) {
        logger.warn('Paystack webhook signature mismatch');
        return res.status(401).json({ error: 'Invalid signature', code: 'INVALID_SIGNATURE' });
      }

      // Acknowledge immediately; process asynchronously so Paystack doesn't
      // time out and retry while we talk to its verify endpoint.
      res.status(200).json({ received: true });
      void handleWebhook(req.body as { event?: string; data?: { reference?: string } });
      return undefined;
    } catch (err) {
      return next(err);
    }
  },
);
