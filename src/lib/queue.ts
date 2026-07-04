import { Queue } from 'bullmq';
import { env } from './env';

const connection = {
	url: env.REDIS_URL
};

const redisDisabled = process.env.DISABLE_REDIS === 'true';

const createQueue = (name: string) => {
	if (redisDisabled) {
		return {
			add: async () => ({ id: undefined }),
			addBulk: async () => [],
			close: async () => undefined,
		} as unknown as Queue;
	}

	try {
		return new Queue(name, { connection });
	} catch {
		return {
			add: async () => ({ id: undefined }),
			addBulk: async () => [],
			close: async () => undefined,
		} as unknown as Queue;
	}
};

export const translationQueue = createQueue('translationQueue');
export const notificationQueue = createQueue('notificationQueue');
export const searchIndexQueue = createQueue('searchIndexQueue');
export const languageCategorizationQueue = createQueue('languageCategorizationQueue');
export const viewCountFlushQueue = createQueue('viewCountFlushQueue');
export const lyricsEnrichmentQueue = createQueue('lyricsEnrichmentQueue');
