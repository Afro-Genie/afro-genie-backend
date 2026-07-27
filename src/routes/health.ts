import { type NextFunction, type Request, type Response, Router } from 'express';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { getHealthStatus } from '../services/healthService';

export const healthRouter = Router();

healthRouter.get(
  '/health',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const health = await getHealthStatus();
      const httpStatus = health.status === 'error' ? 503 : 200;
      res.status(httpStatus).json(health);
    } catch (error) {
      next(error);
    }
  }
);

healthRouter.get(
  '/sync-health',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const lastSync = await redis.get('sync:lastSync:popularTracks');
      const daysSince = lastSync
        ? (Date.now() - new Date(lastSync).getTime()) / (1000 * 60 * 60 * 24)
        : 99;

      const [syncRunCount, recentRuns] = await Promise.all([
        prisma.syncRun.count(),
        prisma.syncRun.findMany({
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { type: true, startedAt: true, durationMs: true, songsAdded: true, errors: true },
        }),
      ]);

      res.json({
        status: daysSince < 7 ? 'healthy' : 'stale',
        lastSync,
        daysSince: Math.round(daysSince * 10) / 10,
        totalSyncRuns: syncRunCount,
        recentRuns,
        nodeEnv: process.env.NODE_ENV,
      });
    } catch (error) {
      next(error);
    }
  }
);
