import type { NextFunction, Request, Response } from 'express';
import { env } from '../lib/env';

// ---------------------------------------------------------------------------
// Backend feature flags (Phase 4).
//
// Mirror of the frontend `VITE_FLAG_*` pattern. Each R1 feature area can be
// toggled via an env var (`BACKEND_FLAG_STORE`, `BACKEND_FLAG_REFERRALS`,
// `BACKEND_FLAG_SEASONS`). Defaults are ON once the R1 implementation landed;
// set the var to `false`/`0` to unmount the route or return 404 from a route.
// ---------------------------------------------------------------------------

export type BackendFlag = 'STORE' | 'REFERRALS' | 'SEASONS' | 'PLAYBACK_YOUTUBE';

const envToBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
};

/**
 * Live flag registry.
 *
 * These are getters, not values. A plain object literal snapshots each flag once
 * at module load, which silently creates a second, stale answer to "is this flag
 * on?" — the resolver (`youtubeService`) reads `env` per call, so the registry
 * and the code that actually honours the flag can disagree. That disagreement is
 * exactly the failure mode an admin flag-inspection endpoint exists to prevent: it
 * would confidently report a state the server is not enforcing.
 *
 * Getters stay enumerable own properties, so `Object.keys`, spread and iteration
 * all behave as before.
 */
export const featureFlags: Record<BackendFlag, boolean> = {
  get STORE() {
    return envToBoolean(process.env.BACKEND_FLAG_STORE, true);
  },
  get REFERRALS() {
    return envToBoolean(process.env.BACKEND_FLAG_REFERRALS, true);
  },
  get SEASONS() {
    return envToBoolean(process.env.BACKEND_FLAG_SEASONS, true);
  },
  // Phase 4 playback rollout — OFF by default so the legacy Spotify player
  // stays active and library enrichment stays idle until the YouTube tier is
  // validated per environment (staging → production → 100%). Also exposed as
  // env.FLAG_PLAYBACK_YOUTUBE (zod-validated) for use inside job processors.
  get PLAYBACK_YOUTUBE() {
    return env.FLAG_PLAYBACK_YOUTUBE;
  },
};

export const isFeatureEnabled = (flag: BackendFlag): boolean => featureFlags[flag];

/**
 * Express middleware that rejects requests to a flag-disabled feature area with
 * a 404 (the route is "not implemented" from the client's perspective). Mount
 * it on individual routes when the router contains a mix of gated/ungated
 * endpoints (e.g. the seasons routes inside tokens.ts).
 */
export const featureGate =
  (flag: BackendFlag) => (_req: Request, res: Response, next: NextFunction) => {
    if (!featureFlags[flag]) {
      res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      return;
    }
    next();
  };
