import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body } from 'express-validator';
import passport from 'passport';
import { ApiError } from '../middleware/errorHandler';
import { validateRequest } from '../middleware/validateRequest';
import {
  buildGoogleRedirectUrl,
  configureGoogleStrategy,
  isGoogleOauthConfigured,
  startForgotPassword,
  login,
  logout,
  refresh,
  register,
  registerArtist,
  resetPassword,
  signInWithSpotify
} from '../services/authService';

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
      };

      const redirectUrl = await buildGoogleRedirectUrl({
        id: authUser.id,
        email: authUser.email,
        displayName: authUser.displayName,
        role: authUser.role
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
