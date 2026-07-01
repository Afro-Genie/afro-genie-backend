import { app } from './app';
import { env } from './lib/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';

if (env.ENABLE_WORKERS) {
  void import('./jobs/workers.js');
  logger.info('Background workers enabled');
} else {
  logger.info('Background workers disabled for this process');
}

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'Server started');
});

const gracefulShutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received');

  server.close(async () => {
    try {
      await prisma.$disconnect();
      await redis.quit();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Shutdown failure');
      process.exit(1);
    }
  });
};

process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
