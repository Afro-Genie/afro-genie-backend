import { env } from './env';
import { redis } from './redis';

const KEY_PREFIX = 'catalog-import:quota';

export interface CatalogQuotaState {
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
  source: 'estimated';
  unavailable?: boolean;
}

export class CatalogQuotaExceededError extends Error {
  readonly state: CatalogQuotaState;
  readonly requestedUnits: number;

  constructor(state: CatalogQuotaState, requestedUnits: number) {
    super(
      `YouTube quota budget exhausted: used ${state.used}/${state.limit} estimated units. ` +
        `The budget resets at ${state.resetAt}. Wait for the reset or use a different YouTube API key.`,
    );
    this.name = 'CatalogQuotaExceededError';
    this.state = state;
    this.requestedUnits = requestedUnits;
  }
}

function quotaWindow() {
  const now = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return {
    key: `${KEY_PREFIX}:${reset.toISOString().slice(0, 10)}`,
    resetAt: reset.toISOString(),
    ttlSeconds: Math.ceil((reset.getTime() - now.getTime()) / 1000) + 3600,
  };
}

function stateFromUsed(used: number, window: { resetAt: string }, unavailable = false): CatalogQuotaState {
  const limit = env.YOUTUBE_DAILY_QUOTA_UNITS;
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetAt: window.resetAt,
    source: 'estimated',
    ...(unavailable && { unavailable: true }),
  };
}

export async function getCatalogImportQuota(): Promise<CatalogQuotaState> {
  const window = quotaWindow();
  try {
    const raw = await redis.get(window.key);
    return stateFromUsed(Math.max(0, Number(raw) || 0), window);
  } catch {
    return stateFromUsed(0, window, true);
  }
}

export async function assertCatalogImportQuota(units: number): Promise<CatalogQuotaState> {
  const state = await getCatalogImportQuota();
  if (!state.unavailable && state.remaining < units) {
    throw new CatalogQuotaExceededError(state, units);
  }
  return state;
}

export async function consumeCatalogImportQuota(units: number): Promise<CatalogQuotaState> {
  const window = quotaWindow();
  try {
    const used = await redis.incrby(window.key, units);
    if (used === units) await redis.expire(window.key, window.ttlSeconds);
    const state = stateFromUsed(used, window);
    if (state.remaining === 0) throw new CatalogQuotaExceededError(state, units);
    return state;
  } catch (error) {
    if (error instanceof CatalogQuotaExceededError) throw error;
    return stateFromUsed(0, window, true);
  }
}
