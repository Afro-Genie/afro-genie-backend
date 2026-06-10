import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import passport from 'passport';
import { Strategy as GoogleStrategy, type Profile } from 'passport-google-oauth20';
import { UserRole, type User } from '@prisma/client';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { ApiError } from '../middleware/errorHandler';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '7d';
const RESET_PASSWORD_TTL_SECONDS = 60 * 60;
const BCRYPT_ROUNDS = 12;
const REFRESH_JWT_SECRET = env.JWT_REFRESH_SECRET ?? env.JWT_SECRET;

interface TokenPayload {
  userId: string;
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

interface AuthUserDto {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends AuthTokens {
  user: AuthUserDto;
}

let googleStrategyInitialized = false;

const hashToken = (token: string): string => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

const refreshKey = (userId: string): string => `refresh:${userId}`;

const resetKey = (tokenHash: string): string => `reset:${tokenHash}`;

const toAuthUser = (user: Pick<User, 'id' | 'email' | 'displayName' | 'role'>): AuthUserDto => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName ?? user.email.split('@')[0],
  role: user.role
});

const signAccessToken = (payload: Omit<TokenPayload, 'iat' | 'exp'>): string => {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
};

const signRefreshToken = (payload: Omit<TokenPayload, 'iat' | 'exp'>): string => {
  return jwt.sign(payload, REFRESH_JWT_SECRET, { expiresIn: REFRESH_TOKEN_TTL });
};

const verifyRefreshTokenJwt = (refreshToken: string): TokenPayload => {
  try {
    return jwt.verify(refreshToken, REFRESH_JWT_SECRET) as unknown as TokenPayload;
  } catch {
    throw new ApiError('Invalid or expired refresh token', 'UNAUTHORIZED', 401);
  }
};

const persistRefreshToken = async (userId: string, refreshToken: string) => {
  const hashed = hashToken(refreshToken);
  await redis.set(refreshKey(userId), hashed, 'EX', 60 * 60 * 24 * 7);
};

const issueTokenPair = async (user: Pick<User, 'id' | 'email' | 'role'>): Promise<AuthTokens> => {
  const payload = {
    userId: user.id,
    email: user.email,
    role: user.role
  };

  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  await persistRefreshToken(user.id, refreshToken);

  return { accessToken, refreshToken };
};

const buildAuthResult = async (
  user: Pick<User, 'id' | 'email' | 'displayName' | 'role'>
): Promise<AuthResult> => {
  const tokens = await issueTokenPair(user);
  return {
    user: toAuthUser(user),
    ...tokens
  };
};

const createMailTransporter = () => {
  if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_USER || !env.SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS
    }
  });
};

export const register = async (email: string, password: string, displayName: string): Promise<AuthResult> => {
  const normalizedEmail = email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    throw new ApiError('Email is already registered', 'CONFLICT', 409);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      passwordHash,
      displayName: displayName.trim(),
      role: UserRole.USER
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true
    }
  });

  return buildAuthResult(user);
};

export const login = async (email: string, password: string): Promise<AuthResult> => {
  const normalizedEmail = email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      passwordHash: true
    }
  });

  if (!user || !user.passwordHash) {
    throw new ApiError('Invalid email or password', 'UNAUTHORIZED', 401);
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    throw new ApiError('Invalid email or password', 'UNAUTHORIZED', 401);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() }
  });

  return buildAuthResult(user);
};

export const refresh = async (refreshToken: string): Promise<AuthResult> => {
  const claims = verifyRefreshTokenJwt(refreshToken);

  if (!claims.userId || !claims.email || !claims.role) {
    throw new ApiError('Invalid token claims', 'UNAUTHORIZED', 401);
  }

  const storedHash = await redis.get(refreshKey(claims.userId));
  const incomingHash = hashToken(refreshToken);

  if (!storedHash || storedHash !== incomingHash) {
    throw new ApiError('Refresh token is revoked', 'UNAUTHORIZED', 401);
  }

  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    select: { id: true, email: true, displayName: true, role: true }
  });

  if (!user) {
    throw new ApiError('User not found', 'NOT_FOUND', 404);
  }

  return buildAuthResult(user);
};

export const logout = async (refreshToken: string): Promise<void> => {
  const claims = verifyRefreshTokenJwt(refreshToken);
  if (!claims.userId) {
    throw new ApiError('Invalid refresh token', 'UNAUTHORIZED', 401);
  }

  await redis.del(refreshKey(claims.userId));
};

export const startForgotPassword = async (email: string): Promise<void> => {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true, displayName: true }
  });

  if (!user) {
    return;
  }

  const resetToken = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashToken(resetToken);

  await redis.set(resetKey(tokenHash), user.id, 'EX', RESET_PASSWORD_TTL_SECONDS);

  const transporter = createMailTransporter();
  const resetUrl = `${env.CLIENT_URL}/reset-password?token=${encodeURIComponent(resetToken)}`;

  if (!transporter || !env.SMTP_FROM_EMAIL) {
    logger.warn({ email: user.email, resetUrl }, 'SMTP not configured; password reset email was not sent');
    return;
  }

  await transporter.sendMail({
    from: env.SMTP_FROM_EMAIL,
    to: user.email,
    subject: 'Reset your Afro Genie password',
    text: `Hi ${user.displayName ?? 'there'}, use this link to reset your password: ${resetUrl}`,
    html: `<p>Hi ${user.displayName ?? 'there'},</p><p>Use this link to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour.</p>`
  });
};

export const resetPassword = async (token: string, newPassword: string): Promise<void> => {
  const tokenHash = hashToken(token);
  const userId = await redis.get(resetKey(tokenHash));

  if (!userId) {
    throw new ApiError('Invalid or expired reset token', 'UNAUTHORIZED', 401);
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash }
  });

  await redis.del(resetKey(tokenHash));
  await redis.del(refreshKey(userId));
};

export const configureGoogleStrategy = () => {
  if (googleStrategyInitialized) {
    return;
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    logger.warn('Google OAuth is not configured; google auth endpoints will fail until env vars are set');
    return;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        callbackURL: env.GOOGLE_CALLBACK_URL
      },
      async (_accessToken: string, _refreshToken: string, profile: Profile, done) => {
        try {
          const email = profile.emails?.[0]?.value?.toLowerCase();

          if (!email) {
            return done(new ApiError('Google account email is required', 'UNAUTHORIZED', 401));
          }

          let user = await prisma.user.findFirst({
            where: {
              OR: [{ googleId: profile.id }, { email }]
            },
            select: {
              id: true,
              email: true,
              displayName: true,
              role: true,
              googleId: true
            }
          });

          if (!user) {
            user = await prisma.user.create({
              data: {
                email,
                googleId: profile.id,
                displayName: profile.displayName || email.split('@')[0],
                photoUrl: profile.photos?.[0]?.value,
                role: UserRole.USER,
                lastLoginAt: new Date()
              },
              select: {
                id: true,
                email: true,
                displayName: true,
                role: true,
                googleId: true
              }
            });
          } else {
            user = await prisma.user.update({
              where: { id: user.id },
              data: {
                googleId: user.googleId ?? profile.id,
                photoUrl: profile.photos?.[0]?.value,
                lastLoginAt: new Date()
              },
              select: {
                id: true,
                email: true,
                displayName: true,
                role: true,
                googleId: true
              }
            });
          }

          return done(null, user);
        } catch (error) {
          return done(error as Error);
        }
      }
    )
  );

  googleStrategyInitialized = true;
};

export const buildGoogleRedirectUrl = async (user: Pick<User, 'id' | 'email' | 'displayName' | 'role'>): Promise<string> => {
  const auth = await buildAuthResult(user);
  const query = new URLSearchParams({
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    userId: auth.user.id,
    email: auth.user.email,
    displayName: auth.user.displayName,
    role: auth.user.role
  });

  return `${env.CLIENT_URL}/auth/callback?${query.toString()}`;
};
