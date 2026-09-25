import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { env } from '../lib/env';
import { dbPopulationStatus } from '../index';
import { getRewardQueueStats } from './rewardService';

export interface PopulationCheck {
  artists: number;
  songs: number;
  genres: number;
  languages: number;
  status: 'healthy' | 'degraded' | 'empty';
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  version: string;
  checks: {
    database: 'ok' | 'error';
    redis: 'ok' | 'error';
  };
  population: PopulationCheck;
  rewards: {
    queue: {
      waiting: number;
      active: number;
      completed: number;
      failed: number;
      status: 'ok' | 'error';
    };
  };
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

  const population = await getPopulationCheck();
  const rewards = await getRewardQueueStats();

  let status: HealthStatus['status'];
  if (database === 'error') {
    status = 'error';
  } else if (redisStatus === 'error' || population.status === 'empty' || population.status === 'degraded') {
    // A Redis outage (or an unpopulated DB) degrades the experience but the
    // API itself remains available — only a DB failure returns HTTP 503.
    status = 'degraded';
  } else {
    status = 'ok';
  }

  return {
    status,
    uptime: process.uptime(),
    version: env.APP_VERSION,
    checks: {
      database,
      redis: redisStatus
    },
    population,
    rewards: { queue: rewards }
  };
};
