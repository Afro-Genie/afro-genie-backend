import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../lib/env';
import { ApiError } from './errorHandler';
import type { AuthUser, JwtClaims, UserRole } from '../types/auth';

const extractBearerToken = (authHeader?: string): string | null => {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
};

export const authenticate = (req: Request, _res: Response, next: NextFunction) => {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    return next(new ApiError('Authentication required', 'UNAUTHORIZED', 401));
  }

  try {
    const claims = jwt.verify(token, env.JWT_SECRET) as JwtClaims;
    const userId = claims.userId ?? claims.sub;

    if (!userId || !claims.email || !claims.role) {
      return next(new ApiError('Invalid token claims', 'INVALID_TOKEN', 401));
    }

    req.user = {
      id: userId,
      email: claims.email,
      role: claims.role
    };

    return next();
  } catch {
    return next(new ApiError('Invalid or expired token', 'UNAUTHORIZED', 401));
  }
};

export const requireAuth = authenticate;

export const requireRole = (requiredRole: UserRole) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const currentUser = req.user as AuthUser | undefined;

    if (!currentUser) {
      return next(new ApiError('Authentication required', 'UNAUTHORIZED', 401));
    }

    if (currentUser.role !== requiredRole) {
      return next(new ApiError('Forbidden', 'FORBIDDEN', 403));
    }

    return next();
  };
};
