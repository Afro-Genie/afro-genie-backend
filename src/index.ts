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

async function checkDatabasePopulation(): Promise<void> {
  try {
    const [artistCount, songCount, genreCount, languageCount] = await Promise.all([
      prisma.artist.count(),
      prisma.song.count(),
      prisma.genre.count(),
      prisma.language.count(),
    ]);

    if (artistCount === 0 && songCount === 0 && genreCount === 0) {
      logger.warn(
        'Database appears empty. Run `npx tsx prisma/seed.ts` to populate seed data, ' +
        'or check the Neon connection if this is unexpected.'
      );
    } else {
      logger.info(
        { artistCount, songCount, genreCount, languageCount },
        'Database population check passed'
      );
    }
  } catch (err) {
    logger.error({ err }, 'Database population check failed — Neon may be cold-starting');
  }
}

const server = app.listen(env.PORT, async () => {
  logger.info({ port: env.PORT }, 'Server started');
  await checkDatabasePopulation();
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
