import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import { featureFlags, type BackendFlag } from '../../config/featureFlags';
import { env } from '../../lib/env';

export const adminFeatureFlagsRouter = Router();

adminFeatureFlagsRouter.use(authenticate, requireRole('ADMIN'));

// ---------------------------------------------------------------------------
// GET /api/admin/feature-flags
//
// The effective state of every backend feature flag, so an operator can confirm
// what is actually being served without reading env files on a running instance
// (Phase 2.4). Read-only and deliberately the narrowest useful surface: it reports
// booleans and the *presence* of configuration, never a configuration value.
// ---------------------------------------------------------------------------

/**
 * Presence-only companion facts.
 *
 * Reported as booleans on purpose. `configured: true` is the thing an operator
 * needs when a flag looks wrong ("is the key even set?"), and it cannot leak a
 * secret the way the value would. Each is a genuinely separate failure mode: a
 * flag can be on with no key behind it, which looks like a working feature and is
 * not.
 */
const configPresence = (): Record<string, boolean> => ({
  // Playback cannot resolve a YouTube tier without a key, whatever the flag says.
  YOUTUBE_API_KEY: Boolean(env.YOUTUBE_API_KEY),
  // Store needs a bundle table with active rows; the flag being on proves nothing
  // about whether a row exists.
  PAYSTACK_SECRET_KEY: Boolean(env.PAYSTACK_SECRET_KEY),
  PAYSTACK_PUBLIC_KEY: Boolean(env.PAYSTACK_PUBLIC_KEY),
});

adminFeatureFlagsRouter.get(
  '/feature-flags',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const flags = Object.fromEntries(
        (Object.keys(featureFlags) as BackendFlag[]).map((name) => [name, featureFlags[name]]),
      ) as Record<BackendFlag, boolean>;

      return res.status(200).json({
        flags,
        config: configPresence(),
        // The registry is getter-backed (see config/featureFlags.ts), so this is
        // the state the server is enforcing right now, not a module-load snapshot.
        source: 'effective',
        nodeEnv: env.NODE_ENV,
      });
    } catch (err) {
      return next(err);
    }
  },
);