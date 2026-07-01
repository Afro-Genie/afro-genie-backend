import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { env } from '../lib/env';

export interface HealthStatus {
  status: 'ok';
  uptime: number;
  version: string;
  checks: {
    database: 'ok' | 'error';
    redis: 'ok' | 'error';
  };
}

export const getHealthStatus = async (): Promise<HealthStatus> => {
  let database: 'ok' | 'error' = 'ok';
  let redisStatus: 'ok' | 'error' = 'ok';

  try {
    await prisma.$queryRawUnsafe('SELECT 1');
  } catch {
    database = 'error';
  }

  try {
    const response = await redis.ping();
    if (response !== 'PONG') {
      redisStatus = 'error';
    }
  } catch {
    redisStatus = 'error';
  }

  return {
    status: 'ok',
    uptime: process.uptime(),
    version: env.APP_VERSION,
    checks: {
      database,
      redis: redisStatus
    }
  };
};
