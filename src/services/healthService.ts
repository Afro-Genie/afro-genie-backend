import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { env } from '../lib/env';

export interface PopulationCheck {
  artists: number;
  songs: number;
  genres: number;
  languages: number;
  status: 'healthy' | 'degraded' | 'empty';
}

export interface HealthStatus {
  status: 'ok';
  uptime: number;
  version: string;
  checks: {
    database: 'ok' | 'error';
    redis: 'ok' | 'error';
  };
  population?: PopulationCheck;
}

async function getPopulationCheck(): Promise<PopulationCheck> {
  const [artists, songs, genres, languages] = await Promise.all([
    prisma.artist.count(),
    prisma.song.count(),
    prisma.genre.count(),
    prisma.language.count(),
  ]);

  const hasArtists = artists > 0;
  const hasSongs = songs > 0;
  const hasGenres = genres > 0;

  let status: PopulationCheck['status'];
  if (hasArtists && hasSongs && hasGenres) {
    status = 'healthy';
  } else if (hasArtists || hasSongs || hasGenres) {
    status = 'degraded';
  } else {
    status = 'empty';
  }

  return { artists, songs, genres, languages, status };
}

export const getHealthStatus = async (verbose = false): Promise<HealthStatus> => {
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

  const result: HealthStatus = {
    status: 'ok',
    uptime: process.uptime(),
    version: env.APP_VERSION,
    checks: {
      database,
      redis: redisStatus
    }
  };

  if (verbose) {
    result.population = await getPopulationCheck();
  }

  return result;
};
