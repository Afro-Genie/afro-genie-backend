import type { NextFunction, Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Backend feature flags (Phase 4).
//
// Mirror of the frontend `VITE_FLAG_*` pattern. Each R1 feature area can be
// toggled via an env var (`BACKEND_FLAG_STORE`, `BACKEND_FLAG_REFERRALS`,
// `BACKEND_FLAG_SEASONS`). Defaults are ON once the R1 implementation landed;
// set the var to `false`/`0` to unmount the route or return 404 from a route.
// ---------------------------------------------------------------------------

export type BackendFlag = 'STORE' | 'REFERRALS' | 'SEASONS';

const envToBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
};

export const featureFlags: Record<BackendFlag, boolean> = {
  STORE: envToBoolean(process.env.BACKEND_FLAG_STORE, true),
  REFERRALS: envToBoolean(process.env.BACKEND_FLAG_REFERRALS, true),
  SEASONS: envToBoolean(process.env.BACKEND_FLAG_SEASONS, true),
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
