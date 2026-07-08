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
  data?: {
    artists: number;
    songs: number;
    genres: number;
    languages: number;
  };
}

export const getHealthStatus = async (verbose?: boolean): Promise<HealthStatus> => {
  let database: 'ok' | 'error' = 'ok';
  let redisStatus: 'ok' | 'error' = 'ok';
  let data: HealthStatus['data'];

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

  if (verbose && database === 'ok') {
    try {
      const [artistCount, songCount, genreCount, languageCount] = await Promise.all([
        prisma.artist.count(),
        prisma.song.count(),
        prisma.genre.count(),
        prisma.language.count(),
      ]);
      data = { artists: artistCount, songs: songCount, genres: genreCount, languages: languageCount };
    } catch {
      // non-fatal if counts fail
    }
  }

  return {
    status: 'ok',
    uptime: process.uptime(),
    version: env.APP_VERSION,
    checks: {
      database,
      redis: redisStatus
    },
    ...(data && { data }),
  };
};
