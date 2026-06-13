import type { RepeatOptions } from 'bullmq';
import { prisma } from '../lib/prisma';
import { viewCountFlushQueue } from '../lib/queue';
import { redis } from '../lib/redis';

const VIEW_KEY_PREFIX = 'song:views:';
const BATCH_SIZE = 200;

const FLUSH_JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: 50,
  repeat: {
    every: 5 * 60 * 1000,
  } satisfies RepeatOptions,
};

const parseSongId = (redisKey: string): string | null => {
  if (!redisKey.startsWith(VIEW_KEY_PREFIX)) {
    return null;
  }

  const songId = redisKey.slice(VIEW_KEY_PREFIX.length);
  return songId || null;
};

export const scheduleViewCountFlush = async () => {
  await viewCountFlushQueue.add('flushSongViews', {}, { ...FLUSH_JOB_OPTIONS, jobId: 'flush-song-views' });
};

export const processViewCountFlushJob = async (): Promise<void> => {
  let cursor = '0';

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${VIEW_KEY_PREFIX}*`, 'COUNT', BATCH_SIZE);
    cursor = nextCursor;

    if (keys.length === 0) {
      continue;
    }

    const values = await redis.mget(...keys);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const count = Number(values[index] ?? '0');
      if (!count || Number.isNaN(count)) {
        continue;
      }

      const songId = parseSongId(key);
      if (!songId) {
        continue;
      }

      await prisma.song.updateMany({
        where: {
          id: songId,
          ...( { softDeleted: false } as Record<string, unknown> ),
        },
        data: {
          views: {
            increment: count,
          },
        },
      });

      await redis.del(key);
    }
  } while (cursor !== '0');
};
