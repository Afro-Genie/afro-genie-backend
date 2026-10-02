import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body, param } from 'express-validator';
import { Prisma } from '@prisma/client';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateRequest } from '../../middleware/validateRequest';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { redis } from '../../lib/redis';
import { createRedisRateLimitStore } from '../../lib/rateLimitStore';
import { catalogService } from '../../services/catalogService';
import { ApiError } from '../../middleware/errorHandler';
import {
  TUNABLE_REWARD_TYPES,
  flushRewardConfigCache,
  getRewardConfig,
  updateRewardConfigValue,
  type RewardConfig,
} from '../../config/rewards';
import { adjustTokens } from '../../services/tokenService';
import { logModAction } from '../../services/moderationAuditService';
import { getAbuseDashboard, reviewAbuseFlag } from '../../services/abuseService';

// ---------------------------------------------------------------------------
// Admin economy dashboard (Phase 5 / 6.1).
//
// Live economy tuning + observability: reward config, store pricing, GT
// circulation charts, abuse surface and manual adjustments. Every write is
// audit-logged to ModActionLog and (for config) invalidates the 5-min cache.
// ---------------------------------------------------------------------------

export const adminEconomyRouter = Router();

adminEconomyRouter.use(authenticate, requireRole('ADMIN'));

// 2.7 — backed by Redis so the limit is a real control across every instance.
// The default in-memory store made the effective limit `limit x instanceCount`
// (30/min per instance) and reset on every deploy.
const economyWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisRateLimitStore('economy-write'),
  message: { error: 'Too many economy updates. Please wait before retrying.', code: 'RATE_LIMITED' },
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
});

const ACTIVE_KEY_PREFIX = 'ACTIVE:';

/**
 * Invalidate the caches that embed store pricing.
 *
 * Previously this SCAN+DEL'd `store:*` and `catalog:homepage:*` by hand. Two
 * problems: (a) no `store:*` key exists anywhere in the codebase — store items
 * are read straight from Postgres — so that half of the scan matched nothing
 * while still walking the keyspace; (b) `catalogService` keeps an in-process
 * `memCache` fallback for when Redis is cold, and a Redis-only DEL cannot reach
 * it, so on a warm process a price edit stayed invisible for up to an hour
 * behind the stale in-memory copy.
 *
 * `invalidateHomepageCache()` is the purpose-built API: it clears the memCache
 * *and* the Redis keys. Store pricing is only ever surfaced through the
 * homepage payload, so that single scoped call is the whole invalidation.
 */
async function invalidateStoreCache(): Promise<void> {
  try {
    await catalogService.invalidateHomepageCache();
  } catch (err) {
    logger.warn({ err }, 'Store cache invalidation failed — non-fatal');
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/economy/config
// Reward amounts + daily caps (DB-merged), store prices and bundle prices.
// ---------------------------------------------------------------------------
adminEconomyRouter.get(
  '/economy/config',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [config, storeItems, bundles, overrides] = await Promise.all([
        getRewardConfig(),
        prisma.storeItem.findMany({
          orderBy: [{ sortOrder: 'asc' }, { tokenCost: 'asc' }],
          select: {
            id: true,
            name: true,
            category: true,
            tokenCost: true,
            active: true,
            featured: true,
            limitedTime: true,
            discountPercent: true,
            discountedPrice: true,
            promoEndsAt: true,
          },
        }),
        prisma.gtBundle.findMany({
          orderBy: [{ sortOrder: 'asc' }, { gtAmount: 'asc' }],
          select: {
            id: true,
            name: true,
            gtAmount: true,
            priceKobo: true,
            currency: true,
            bonusPercent: true,
            active: true,
          },
        }),
        prisma.economyConfig.findMany({ select: { key: true, value: true, lastModifiedBy: true, lastModifiedAt: true } }),
      ]);

      const activeByType = new Map<string, boolean>();
      for (const row of overrides) {
        if (row.key.startsWith(ACTIVE_KEY_PREFIX)) {
          activeByType.set(row.key.slice(ACTIVE_KEY_PREFIX.length), Boolean(row.value));
        }
      }

      const rewards = TUNABLE_REWARD_TYPES.map((def) => ({
        type: def.type,
        label: def.label,
        amount: def.amountKey ? (config[def.amountKey] as number | number[]) : null,
        dailyCap: def.dailyCapKey ? (config[def.dailyCapKey] as number) : null,
        active: activeByType.get(def.type) ?? true,
      }));

      return res.status(200).json({
        rewards,
        rewardConfig: config,
        overrides: overrides.map((o) => ({
          key: o.key,
          value: o.value,
          lastModifiedBy: o.lastModifiedBy,
          lastModifiedAt: o.lastModifiedAt,
        })),
        store: { items: storeItems },
        bundles,
      });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /api/admin/economy/rewards
// Body { rewardType, newAmount?, newDailyCap?, active? }
// ---------------------------------------------------------------------------
adminEconomyRouter.patch(
  '/economy/rewards',
  economyWriteLimiter,
  [
    body('rewardType').isString().notEmpty().withMessage('rewardType is required'),
    body('newAmount').optional().isFloat({ min: 0 }).withMessage('newAmount must be >= 0'),
    body('newDailyCap').optional().isInt({ min: 0 }).withMessage('newDailyCap must be >= 0'),
    body('active').optional().isBoolean().withMessage('active must be a boolean'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rewardType, newAmount, newDailyCap, active } = req.body as {
        rewardType: string;
        newAmount?: number;
        newDailyCap?: number;
        active?: boolean;
      };

      const def = TUNABLE_REWARD_TYPES.find((t) => t.type === rewardType);
      if (!def) {
        throw new ApiError(
          `Unknown rewardType. Valid types: ${TUNABLE_REWARD_TYPES.map((t) => t.type).join(', ')}`,
          'VALIDATION_ERROR',
          400,
        );
      }

      if (newAmount === undefined && newDailyCap === undefined && active === undefined) {
        throw new ApiError('Provide at least one of newAmount, newDailyCap, active', 'VALIDATION_ERROR', 400);
      }

      const previousValue: Record<string, unknown> = {};
      const newValue: Record<string, unknown> = {};
      const changes: string[] = [];

      if (newAmount !== undefined) {
        if (!def.amountKey) {
          throw new ApiError(`${rewardType} has no tunable amount`, 'VALIDATION_ERROR', 400);
        }
        const result = await updateRewardConfigValue(def.amountKey, newAmount, req.user!.id);
        previousValue.amount = result.previousValue;
        newValue.amount = result.newValue;
        changes.push(`${def.amountKey}=${newAmount}`);
      }

      if (newDailyCap !== undefined) {
        if (!def.dailyCapKey) {
          throw new ApiError(`${rewardType} has no tunable daily cap`, 'VALIDATION_ERROR', 400);
        }
        const result = await updateRewardConfigValue(def.dailyCapKey, newDailyCap, req.user!.id);
        previousValue.dailyCap = result.previousValue;
        newValue.dailyCap = result.newValue;
        changes.push(`${def.dailyCapKey}=${newDailyCap}`);
      }

      if (active !== undefined) {
        const key = `${ACTIVE_KEY_PREFIX}${rewardType}`;
        const existing = await prisma.economyConfig.findUnique({ where: { key } });
        await prisma.economyConfig.upsert({
          where: { key },
          update: { value: active, lastModifiedBy: req.user!.id, lastModifiedAt: new Date() },
          create: { key, value: active, lastModifiedBy: req.user!.id, description: `Whether ${rewardType} rewards are active` },
        });
        await flushRewardConfigCache();
        previousValue.active = existing ? existing.value : true;
        newValue.active = active;
        changes.push(`${key}=${active}`);
      }

      await logModAction({
        moderatorId: req.user!.id,
        actionType: 'ECONOMY_REWARD_UPDATE',
        targetId: rewardType,
        targetType: 'ECONOMY_CONFIG',
        details: changes.join(', '),
      });

      return res.status(200).json({ updated: true, rewardType, previousValue, newValue });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /api/admin/economy/store/:itemId
// Body { tokenCost?, featured?, limitedTime?, discountPercent?, promoEndsAt? }
// ---------------------------------------------------------------------------
adminEconomyRouter.patch(
  '/economy/store/:itemId',
  economyWriteLimiter,
  [
    param('itemId').isString().notEmpty().withMessage('itemId is required'),
    body('tokenCost').optional().isInt({ min: 1 }).withMessage('tokenCost must be a positive integer'),
    body('featured').optional().isBoolean(),
    body('limitedTime').optional().isBoolean(),
    body('discountPercent').optional().isInt({ min: 1, max: 99 }).withMessage('discountPercent must be 1-99'),
    body('promoEndsAt').optional({ nullable: true }).isISO8601().withMessage('promoEndsAt must be an ISO date'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tokenCost, featured, limitedTime, discountPercent, promoEndsAt } = req.body as {
        tokenCost?: number;
        featured?: boolean;
        limitedTime?: boolean;
        discountPercent?: number;
        promoEndsAt?: string | null;
      };

      const existing = await prisma.storeItem.findUnique({ where: { id: req.params.itemId } });
      if (!existing) {
        throw new ApiError('Store item not found', 'NOT_FOUND', 404);
      }

      const data: Prisma.StoreItemUpdateInput = {};
      if (tokenCost !== undefined) data.tokenCost = tokenCost;
      if (featured !== undefined) data.featured = featured;
      if (limitedTime !== undefined) data.limitedTime = limitedTime;

      if (discountPercent !== undefined) {
        const originalPrice = existing.originalPrice ?? existing.tokenCost;
        data.originalPrice = originalPrice;
        data.discountedPrice = Math.max(1, Math.floor((originalPrice * (100 - discountPercent)) / 100));
        data.discountPercent = discountPercent;
        data.limitedTime = true;
        data.promoStartsAt = new Date();
        if (promoEndsAt !== undefined) data.promoEndsAt = promoEndsAt ? new Date(promoEndsAt) : null;
      } else if (promoEndsAt !== undefined) {
        data.promoEndsAt = promoEndsAt ? new Date(promoEndsAt) : null;
      }

      const item = await prisma.storeItem.update({ where: { id: existing.id }, data });

      await invalidateStoreCache();

      await logModAction({
        moderatorId: req.user!.id,
        actionType: 'ECONOMY_STORE_UPDATE',
        targetId: item.id,
        targetType: 'STORE_ITEM',
        details: JSON.stringify({ tokenCost, featured, limitedTime, discountPercent, promoEndsAt }),
      });

      return res.status(200).json(item);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/economy/circulation
// Total earned/spent, circulating supply, active holders and 30-day charts.
// ---------------------------------------------------------------------------
adminEconomyRouter.get(
  '/economy/circulation',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [earnedAgg, spentAgg, circulatingAgg, activeHolders, dailyRows] = await Promise.all([
        prisma.tokenLedger.aggregate({ _sum: { amount: true }, where: { type: 'EARN' } }),
        prisma.tokenLedger.aggregate({ _sum: { amount: true }, where: { type: 'SPEND' } }),
        prisma.userWallet.aggregate({ _sum: { balance: true } }),
        prisma.userWallet.count({ where: { balance: { gt: 0 } } }),
        prisma.$queryRaw<Array<{ day: Date; type: string; total: number }>>`
          SELECT DATE("createdAt") AS "day", "type", SUM("amount")::int AS "total"
          FROM "TokenLedger"
          WHERE "createdAt" >= now() - interval '30 days'
            AND "type" IN ('EARN', 'SPEND')
          GROUP BY "day", "type"
          ORDER BY "day" ASC
        `,
      ]);

      const byDay = new Map<string, { day: string; earned: number; spent: number }>();
      for (const row of dailyRows) {
        const day = row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10);
        const entry = byDay.get(day) ?? { day, earned: 0, spent: 0 };
        if (row.type === 'EARN') entry.earned += row.total;
        if (row.type === 'SPEND') entry.spent += Math.abs(row.total);
        byDay.set(day, entry);
      }

      return res.status(200).json({
        totalEarned: earnedAgg._sum.amount ?? 0,
        totalSpent: Math.abs(spentAgg._sum.amount ?? 0),
        totalInCirculation: circulatingAgg._sum.balance ?? 0,
        activeHolders,
        daily: [...byDay.values()],
      });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/economy/abuse
// Live abuse surface: 3σ earners, low-quality translations, rapid-fire
// corrections, shared-IP/mutual referrals and open AbuseFlag rows.
// ---------------------------------------------------------------------------
adminEconomyRouter.get(
  '/economy/abuse',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const dashboard = await getAbuseDashboard();
      return res.status(200).json(dashboard);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /api/admin/economy/abuse/:flagId
// Body { reviewed?, pausedRewards? } — review a flag and/or resume earning.
// ---------------------------------------------------------------------------
adminEconomyRouter.patch(
  '/economy/abuse/:flagId',
  economyWriteLimiter,
  [
    param('flagId').isString().notEmpty().withMessage('flagId is required'),
    body('reviewed').optional().isBoolean(),
    body('pausedRewards').optional().isBoolean(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reviewed, pausedRewards } = req.body as { reviewed?: boolean; pausedRewards?: boolean };

      const updated = await reviewAbuseFlag(req.params.flagId, req.user!.id, { reviewed, pausedRewards });
      if (!updated) {
        throw new ApiError('Abuse flag not found', 'NOT_FOUND', 404);
      }

      await logModAction({
        moderatorId: req.user!.id,
        actionType: 'ECONOMY_ABUSE_REVIEW',
        targetId: updated.id,
        targetType: 'ABUSE_FLAG',
        details: JSON.stringify({ reviewed, pausedRewards }),
      });

      return res.status(200).json(updated);
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/economy/adjust
// Body { userId, amount, reason, type: 'CREDIT'|'DEBIT' }
// ---------------------------------------------------------------------------
adminEconomyRouter.post(
  '/economy/adjust',
  economyWriteLimiter,
  [
    body('userId').isString().notEmpty().withMessage('userId is required'),
    body('amount').isInt({ min: 1, max: 100000 }).withMessage('amount must be a positive integer'),
    body('reason').isString().notEmpty().isLength({ max: 255 }).withMessage('reason is required'),
    body('type').isIn(['CREDIT', 'DEBIT']).withMessage("type must be 'CREDIT' or 'DEBIT'"),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, amount, reason, type } = req.body as {
        userId: string;
        amount: number;
        reason: string;
        type: 'CREDIT' | 'DEBIT';
      };

      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true } });
      if (!user) {
        throw new ApiError('User not found', 'NOT_FOUND', 404);
      }

      const signedAmount = type === 'CREDIT' ? amount : -amount;

      const ledger = await adjustTokens({
        userId,
        amount: signedAmount,
        reason: `Admin economy adjustment: ${reason}`,
        sourceType: 'ADMIN_ECONOMY_ADJUST',
        sourceId: `${userId}:${Date.now()}`,
      });

      await prisma.notification
        .create({
          data: {
            userId,
            title: signedAmount > 0 ? 'Tokens credited' : 'Tokens debited',
            message: `An admin ${signedAmount > 0 ? 'credited' : 'debited'} ${Math.abs(signedAmount)} GT: ${reason}`,
            type: 'REWARD',
          },
        })
        .catch((err) => logger.warn({ err, userId }, 'Economy adjustment notification failed'));

      await logModAction({
        moderatorId: req.user!.id,
        actionType: 'ECONOMY_ADJUST',
        targetId: userId,
        targetType: 'USER',
        details: JSON.stringify({ amount: signedAmount, reason, ledgerId: ledger.id }),
      });

      return res.status(200).json({
        success: true,
        userId,
        amount: signedAmount,
        type,
        reason,
        balanceAfter: ledger.balanceAfter,
        adjustedBy: req.user!.id,
      });
    } catch (err) {
      return next(err);
    }
  },
);