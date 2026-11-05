import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { body, header, param } from 'express-validator';
import { optionalAuth } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import { validateRequest } from '../middleware/validateRequest';
import type { AuthUser } from '../types/auth';
import {
  createGuestGameSession,
  getDailyGameStatuses,
  getDailyGame,
  getDailyGameManifest,
  getGamePlayState,
  submitGameAction,
} from '../services/gamesService';

export const gamesRouter = Router();

gamesRouter.get('/games/daily', (_req: Request, res: Response) => {
  return res.status(200).json(getDailyGameManifest());
});

gamesRouter.post(
  '/games/progress',
  optionalAuth,
  [body('guestTokens').optional().isObject(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedUser = req.user as AuthUser | undefined;
      const guestTokens = req.body?.guestTokens;
      if (authenticatedUser && guestTokens !== undefined) {
        throw new ApiError('Use either account or guest progress', 'VALIDATION_ERROR', 400);
      }
      const result = await getDailyGameStatuses(authenticatedUser
        ? { userId: authenticatedUser.id }
        : { guestTokens: guestTokens ?? {} });
      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  },
);

gamesRouter.get(
  '/games/daily/:gameId',
  [param('gameId').isString().notEmpty(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.status(200).json(await getDailyGame(req.params.gameId));
    } catch (error) {
      return next(error);
    }
  },
);

gamesRouter.post(
  '/games/:gameId/session',
  [param('gameId').isString().notEmpty(), validateRequest],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.status(201).json(await createGuestGameSession(req.params.gameId));
    } catch (error) {
      return next(error);
    }
  },
);

gamesRouter.post(
  '/games/:gameId/actions',
  optionalAuth,
  [
    param('gameId').isString().notEmpty(),
    header('x-game-session')
      .optional()
      .isString()
      .isLength({ min: 43, max: 43 })
      .matches(/^[A-Za-z0-9_-]+$/)
      .withMessage('Invalid game session token'),
    header('idempotency-key')
      .isString()
      .matches(/^[A-Za-z0-9._:-]{8,128}$/)
      .withMessage('A valid Idempotency-Key header is required'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedUser = req.user as AuthUser | undefined;
      const guestToken = authenticatedUser ? undefined : req.header('x-game-session');
      if (!authenticatedUser && !guestToken) {
        throw new ApiError('Game session required', 'UNAUTHORIZED', 401);
      }
      if (authenticatedUser && req.header('x-game-session')) {
        throw new ApiError('Use either account or guest state', 'VALIDATION_ERROR', 400);
      }
      const idempotencyKey = req.header('idempotency-key');
      if (!idempotencyKey) {
        throw new ApiError('A valid Idempotency-Key header is required', 'VALIDATION_ERROR', 400);
      }
      const result = await submitGameAction(
        req.params.gameId,
        { userId: authenticatedUser?.id, guestToken },
        idempotencyKey,
        req.body,
      );
      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  },
);

gamesRouter.get(
  '/games/:gameId/state',
  optionalAuth,
  [
    param('gameId').isString().notEmpty(),
    header('x-game-session')
      .optional()
      .isString()
      .isLength({ min: 43, max: 43 })
      .matches(/^[A-Za-z0-9_-]+$/)
      .withMessage('Invalid game session token'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedUser = req.user as AuthUser | undefined;
      const guestToken = authenticatedUser ? undefined : req.header('x-game-session');
      if (!authenticatedUser && !guestToken) {
        throw new ApiError('Game session required', 'UNAUTHORIZED', 401);
      }
      if (authenticatedUser && req.header('x-game-session')) {
        throw new ApiError('Use either account or guest state', 'VALIDATION_ERROR', 400);
      }
      const state = await getGamePlayState(req.params.gameId, {
        userId: authenticatedUser?.id,
        guestToken,
      });
      return res.status(200).json(state);
    } catch (error) {
      return next(error);
    }
  },
);
