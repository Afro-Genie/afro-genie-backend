import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body } from 'express-validator';
import passport from 'passport';
import { ApiError } from '../middleware/errorHandler';
import { validateRequest } from '../middleware/validateRequest';
import {
  buildGoogleRedirectUrl,
  changePassword,
  configureGoogleStrategy,
  getSmtpDebugInfo,
  isGoogleOauthConfigured,
  startForgotPassword,
  login,
  logout,
  refresh,
  register,
  registerArtist,
  resetPassword,
  signInWithSpotify,
  syncSpotifyProduct,
  linkSpotifyToUser
} from '../services/authService';
import { requireAuth } from '../middleware/auth';

export const authRouter = Router();

configureGoogleStrategy();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many login attempts. Please try again later.',
    code: 'RATE_LIMITED'
  }
});

authRouter.post(
  '/auth/register',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('displayName').trim().isLength({ min: 1, max: 80 }).withMessage('Display name is required')
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, displayName } = req.body as {
        email: string;
        password: string;
        displayName: string;
      };

      const auth = await register(email, password, displayName);
      res.status(201).json(auth);
    } catch (error) {
      next(error);
    }
  }
);

authRouter.post(
  '/auth/register-artist',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('stageName').trim().isLength({ min: 1, max: 80 }).withMessage('Stage name is required'),
    body('genre').trim().isLength({ min: 1 }).withMessage('Genre is required'),
    body('bio').trim().isLength({ min: 1 }).withMessage('Bio is required')
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, stageName, genre, bio, location, website, socialLinks, photoURL } = req.body;

      const auth = await registerArtist(email, password, {
        stageName,
        genre,
        bio,
        location,
        website,
        socialLinks,
        photoURL
      });

      res.status(201).json(auth);
    } catch (error) {
      next(error);
    }
  }
);

authRouter.post(
  '/auth/login',
  loginLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isString().notEmpty().withMessage('Password is required')
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body as { email: string; password: string };
      const auth = await login(email, password);
      res.status(200).json(auth);
    } catch (error) {
      next(error);
    }
  }
);

authRouter.post(
  '/auth/refresh',
  [body('refreshToken').isString().notEmpty().withMessage('refreshToken is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body as { refreshToken: string };
      const auth = await refresh(refreshToken);
      res.status(200).json(auth);
    } catch (error) {
      next(error);
    }
  }
);

authRouter.post(
  '/auth/logout',
  [body('refreshToken').isString().notEmpty().withMessage('refreshToken is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body as { refreshToken: string };
      await logout(refreshToken);
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

authRouter.post(
  '/auth/spotify',
  [body('accessToken').isString().notEmpty().withMessage('Access token is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { accessToken } = req.body as { accessToken: string };
      const auth = await signInWithSpotify(accessToken);
      res.status(200).json(auth);
    } catch (error) {
      next(error);
    }
  }
);

authRouter.post(
  '/auth/spotify/sync-product',
  requireAuth,
  [body('spotifyAccessToken').isString().notEmpty().withMessage('Spotify access token is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id;
      const { spotifyAccessToken } = req.body as { spotifyAccessToken: string };
      const result = await syncSpotifyProduct(userId, spotifyAccessToken);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

authRouter.post(
  '/auth/spotify/link',
  requireAuth,
  [body('spotifyAccessToken').isString().notEmpty().withMessage('Spotify access token is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id;
      const { spotifyAccessToken } = req.body as { spotifyAccessToken: string };
      const result = await linkSpotifyToUser(userId, spotifyAccessToken);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

authRouter.get('/auth/google', (req: Request, res: Response, next: NextFunction) => {
  if (!isGoogleOauthConfigured()) {
    next(new ApiError('Google OAuth is not configured on the server', 'SERVICE_UNAVAILABLE', 503));
    return;
  }

  passport.authenticate('google', { scope: ['profile', 'email'], session: false })(req, res, next);
});

authRouter.get(
  '/auth/google/callback',
  (req: Request, res: Response, next: NextFunction) => {
    if (!isGoogleOauthConfigured()) {
      next(new ApiError('Google OAuth is not configured on the server', 'SERVICE_UNAVAILABLE', 503));
      return;
    }

    passport.authenticate('google', { session: false, failureRedirect: '/api/auth/google/failure' })(req, res, next);
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        throw new ApiError('Google authentication failed', 'UNAUTHORIZED', 401);
      }

      const authUser = req.user as {
        id: string;
        email: string;
        displayName: string | null;
        role: 'USER' | 'ADMIN' | 'MODERATOR' | 'ARTIST';
        spotifyId: string | null;
        spotifyProduct: string | null;
      };

      const redirectUrl = await buildGoogleRedirectUrl({
        id: authUser.id,
        email: authUser.email,
        displayName: authUser.displayName,
        role: authUser.role,
        spotifyId: authUser.spotifyId ?? null,
        spotifyProduct: authUser.spotifyProduct ?? null
      });

      res.redirect(redirectUrl);
    } catch (error) {
      next(error);
    }
  }
);

authRouter.get('/auth/google/failure', (_req: Request, res: Response) => {
  res.status(401).json({ error: 'Google authentication failed', code: 'UNAUTHORIZED' });
});

authRouter.post(
  '/auth/forgot-password',
  [body('email').isEmail().withMessage('Valid email is required')],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body as { email: string };
      await startForgotPassword(email);
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

authRouter.post(
  '/auth/reset-password',
  [
    body('token').isString().notEmpty().withMessage('token is required'),
    body('newPassword').isLength({ min: 8 }).withMessage('newPassword must be at least 8 characters')
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token, newPassword } = req.body as { token: string; newPassword: string };
      await resetPassword(token, newPassword);
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

authRouter.post(
  '/auth/change-password',
  requireAuth,
  [
    body('currentPassword').isString().notEmpty().withMessage('currentPassword is required'),
    body('newPassword').isLength({ min: 8 }).withMessage('newPassword must be at least 8 characters')
  ],
  validateRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id;
      const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
      await changePassword(userId, currentPassword, newPassword);
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Diagnostic endpoint: returns Spotify OAuth configuration status.
 * Helps verify that the redirect URI and client ID are configured correctly.
 * No secrets are exposed — only shows whether values are set.
 */
authRouter.get('/auth/spotify/debug', (_req: Request, res: Response) => {
  const clientId = process.env.SPOTIFY_CLIENT_ID || '';
  const configuredRedirectUris = [
    process.env.SPOTIFY_REDIRECT_URI_LOCAL || 'http://127.0.0.1:3000',
    process.env.SPOTIFY_REDIRECT_URI_STAGING || 'https://afro-genie-staging.vercel.app',
  ];

  res.json({
    clientIdConfigured: !!clientId,
    clientIdPrefix: clientId ? `${clientId.slice(0, 6)}...` : 'NOT SET',
    configuredRedirectUris,
    clientUrl: process.env.CLIENT_URL || 'NOT SET',
    corsOrigin: process.env.CORS_ORIGIN || 'NOT SET',
    nodeEnv: process.env.NODE_ENV || 'NOT SET',
    instructions: {
      step1: 'Go to https://developer.spotify.com/dashboard → your app → Settings → Redirect URIs',
      step2: 'Add ALL of these redirect URIs:',
      uris: configuredRedirectUris,
      note: 'Spotify requires EXACT match. Use http://127.0.0.1 (not http://localhost) — localhost was removed Nov 2025.',
    },
  });
});

authRouter.get('/auth/smtp/debug', async (_req: Request, res: Response) => {
  const info = await getSmtpDebugInfo();
  res.json(info);
});
