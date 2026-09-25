import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authenticate } from '../middleware/auth';
import { validateRequest } from '../middleware/validateRequest';
import { ApiError } from '../middleware/errorHandler';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
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
