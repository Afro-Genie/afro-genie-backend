import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import passport from 'passport';
import { Strategy as GoogleStrategy, type Profile, type VerifyCallback } from 'passport-google-oauth20';
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
  spotifyId?: string | null;
  spotifyProduct?: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends AuthTokens {
  user: AuthUserDto;
}

let googleStrategyInitialized = false;

export const isGoogleOauthConfigured = (): boolean => {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
};

const hashToken = (token: string): string => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

const refreshKey = (userId: string): string => `refresh:${userId}`;

const resetKey = (tokenHash: string): string => `reset:${tokenHash}`;

const toAuthUser = (user: Pick<User, 'id' | 'email' | 'displayName' | 'role' | 'spotifyId' | 'spotifyProduct'>): AuthUserDto => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName ?? user.email.split('@')[0],
  role: user.role,
  spotifyId: user.spotifyId ?? null,
  spotifyProduct: user.spotifyProduct ?? null,
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
  user: Pick<User, 'id' | 'email' | 'displayName' | 'role' | 'spotifyId' | 'spotifyProduct'>
): Promise<AuthResult> => {
  const tokens = await issueTokenPair(user);
  return {
    user: toAuthUser(user),
    ...tokens
  };
};

const SMTP_SEND_TIMEOUT_MS = 15_000;

interface BrevoMailPayload {
  sender: { email: string; name?: string };
  to: Array<{ email: string; name?: string }>;
  subject: string;
  htmlContent: string;
  textContent: string;
}

const sendViaBrevoApi = async (options: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> => {
  const apiKey = env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not set');
  }

  const payload: BrevoMailPayload = {
    sender: { email: options.from, name: 'Afro Genie' },
    to: [{ email: options.to }],
    subject: options.subject,
    htmlContent: options.html,
    textContent: options.text,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMTP_SEND_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Brevo API ${res.status}: ${body}`);
    }
  } finally {
    clearTimeout(timer);
  }
};

const createMailTransporter = () => {
  if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_USER || !env.SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    requireTLS: env.SMTP_PORT !== 465,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS
    }
  });
};

const sendMailWithTimeout = (
  transporter: nodemailer.Transporter,
  mailOptions: nodemailer.SendMailOptions
): Promise<unknown> => {
  return Promise.race([
    transporter.sendMail(mailOptions),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`SMTP send timed out after ${SMTP_SEND_TIMEOUT_MS}ms`)), SMTP_SEND_TIMEOUT_MS)
    )
  ]);
};

const sendPasswordResetEmail = async (options: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> => {
  if (env.BREVO_API_KEY) {
    logger.info({ method: 'brevo_api', to: options.to }, 'Sending email via Brevo HTTP API');
    await sendViaBrevoApi(options);
    return;
  }

  const transporter = createMailTransporter();
  if (!transporter) {
    throw new Error('No email transport available: set BREVO_API_KEY or SMTP_* env vars');
  }

  logger.info({ method: 'smtp', to: options.to }, 'Sending email via SMTP');
  await sendMailWithTimeout(transporter, options);
};

export const getSmtpDebugInfo = async (): Promise<Record<string, unknown>> => {
  const hasAllVars = Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS);
  const hasApiKey = Boolean(env.BREVO_API_KEY);

  const result: Record<string, unknown> = {
    brevoApiKeySet: hasApiKey,
    transportMethod: hasApiKey ? 'brevo_http_api' : (hasAllVars ? 'smtp' : 'none'),
    hostSet: !!env.SMTP_HOST,
    portSet: !!env.SMTP_PORT,
    userSet: !!env.SMTP_USER,
    passSet: !!env.SMTP_PASS,
    fromEmail: env.SMTP_FROM_EMAIL || 'NOT SET',
    clientUrl: env.CLIENT_URL,
  };

  if (hasApiKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': env.BREVO_API_KEY!,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { email: env.SMTP_FROM_EMAIL || 'test@test.com' },
          to: [{ email: env.SMTP_FROM_EMAIL || 'test@test.com' }],
          subject: 'SMTP Debug Test',
          textContent: 'test',
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 401) {
        result.status = 'FAILED — Brevo API key is invalid (401 Unauthorized)';
      } else if (res.status === 400) {
        result.status = 'OK — Brevo API reachable, key is valid (400 = test payload rejected, expected)';
      } else if (res.ok) {
        result.status = 'OK — Brevo HTTP API connected and working';
      } else {
        const body = await res.text();
        result.status = `BREVO API ${res.status}: ${body}`;
      }
    } catch (err: any) {
      result.status = `FAILED — ${err.message}`;
    }
    return result;
  }

  if (!hasAllVars) {
    result.status = 'INCOMPLETE — set BREVO_API_KEY (preferred) or all SMTP_* vars';
    return result;
  }

  const transporter = createMailTransporter();
  if (!transporter) {
    result.status = 'UNEXPECTED — transporter is null despite all vars present';
    return result;
  }

  try {
    await Promise.race([
      transporter.verify(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('SMTP verify timed out after 10s')), 10_000)
      )
    ]);
    result.status = 'OK — SMTP connection and auth verified';
  } catch (err: any) {
    result.status = `FAILED — ${err.message}`;
  }

  return result;
};

export const registerArtist = async (
  email: string,
  password: string,
  artistData: {
    stageName: string;
    genre: string;
    bio: string;
    location?: string;
    website?: string;
    socialLinks?: Record<string, string | undefined>;
    photoURL?: string;
  }
): Promise<AuthResult> => {
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
      displayName: artistData.stageName.trim(),
      photoUrl: artistData.photoURL,
      role: UserRole.ARTIST
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      spotifyId: true,
      spotifyProduct: true
    }
  });

  await prisma.artistApplication.create({
    data: {
      userId: user.id,
      stageName: artistData.stageName.trim(),
      genre: artistData.genre,
      bio: artistData.bio,
      socialLinks: artistData.socialLinks ?? {}
    }
  });

  return buildAuthResult(user);
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
      role: true,
      spotifyId: true,
      spotifyProduct: true
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
      passwordHash: true,
      spotifyId: true,
      spotifyProduct: true
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
    select: { id: true, email: true, displayName: true, role: true, spotifyId: true, spotifyProduct: true }
  });

  if (!user) {
    throw new ApiError('User not found', 'NOT_FOUND', 404);
  }

  await redis.del(refreshKey(claims.userId));
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
    logger.warn({ email: normalizedEmail }, 'Password reset requested for non-existent email');
    return;
  }

  const resetToken = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashToken(resetToken);

  await redis.set(resetKey(tokenHash), user.id, 'EX', RESET_PASSWORD_TTL_SECONDS);

  if (!env.SMTP_FROM_EMAIL) {
    logger.warn({ email: user.email }, 'SMTP_FROM_EMAIL not set; password reset email was not sent');
    return;
  }

  const resetUrl = `${env.CLIENT_URL}/#/reset-password?token=${encodeURIComponent(resetToken)}`;

  try {
    await sendPasswordResetEmail({
      from: env.SMTP_FROM_EMAIL,
      to: user.email,
      subject: 'Reset your Afro Genie password',
      text: `Hi ${user.displayName ?? 'there'}, use this link to reset your password: ${resetUrl}`,
      html: `<p>Hi ${user.displayName ?? 'there'},</p><p>Use this link to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour.</p>`,
    });

    logger.info({ email: user.email }, 'Password reset email sent successfully');
  } catch (err) {
    logger.error({ err, email: user.email }, 'Failed to send password reset email');
  }
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

export const changePassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true }
  });

  if (!user) {
    throw new ApiError('User not found', 'NOT_FOUND', 404);
  }

  if (!user.passwordHash) {
    throw new ApiError(
      'This account does not have a password. Use your provider to sign in.',
      'CONFLICT',
      409
    );
  }

  const matches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!matches) {
    throw new ApiError('Current password is incorrect', 'UNAUTHORIZED', 401);
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash }
  });

  // Revoke all existing refresh tokens to force re-login on other sessions
  await redis.del(refreshKey(userId));
};

export const configureGoogleStrategy = () => {
  if (googleStrategyInitialized) {
    return;
  }

  if (!isGoogleOauthConfigured()) {
    logger.warn('Google OAuth is not configured; google auth endpoints will fail until env vars are set');
    return;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        callbackURL: env.GOOGLE_CALLBACK_URL
      },
      async (_accessToken: string, _refreshToken: string, profile: Profile, done: VerifyCallback) => {
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
              googleId: true,
              spotifyId: true,
              spotifyProduct: true
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
                googleId: true,
                spotifyId: true,
                spotifyProduct: true
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
                googleId: true,
                spotifyId: true,
                spotifyProduct: true
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

export const signInWithSpotify = async (accessToken: string): Promise<AuthResult> => {
  const spotifyRes = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!spotifyRes.ok) {
    throw new ApiError('Failed to authenticate with Spotify', 'UNAUTHORIZED', 401);
  }

  const profile = await spotifyRes.json() as {
    id: string;
    display_name?: string;
    email?: string;
    images?: Array<{ url: string }>;
    product?: string;
  };

  if (!profile.id) {
    throw new ApiError('Invalid Spotify profile', 'UNAUTHORIZED', 401);
  }

  const email = profile.email?.toLowerCase();
  const spotifyProduct = profile.product ?? null;

  let user = await prisma.user.findFirst({
    where: {
      OR: [
        { spotifyId: profile.id },
        ...(email ? [{ email }] : []),
      ],
    },
    select: { id: true, email: true, displayName: true, role: true, spotifyId: true, spotifyProduct: true },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        email: email ?? `${profile.id}@spotify.afrogenie.app`,
        spotifyId: profile.id,
        spotifyProduct,
        displayName: profile.display_name || email?.split('@')[0] || 'Spotify User',
        photoUrl: profile.images?.[0]?.url,
        role: UserRole.USER,
        lastLoginAt: new Date(),
      },
      select: { id: true, email: true, displayName: true, role: true, spotifyId: true, spotifyProduct: true },
    });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        spotifyId: user.spotifyId ?? profile.id,
        spotifyProduct,
        photoUrl: profile.images?.[0]?.url,
        lastLoginAt: new Date(),
        ...(email && !user.email.includes('@spotify.afrogenie.app') ? {} : { email }),
      },
      select: { id: true, email: true, displayName: true, role: true, spotifyId: true, spotifyProduct: true },
    });
  }

  return buildAuthResult({ id: user.id, email: user.email, displayName: user.displayName, role: user.role, spotifyId: user.spotifyId, spotifyProduct: user.spotifyProduct });
};

export const syncSpotifyProduct = async (userId: string, spotifyAccessToken: string): Promise<{ spotifyProduct: string | null }> => {
  // Guard: only sync for users who have an active Spotify link
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { spotifyId: true },
  });

  if (!user || !user.spotifyId) {
    return { spotifyProduct: null };
  }

  const spotifyRes = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${spotifyAccessToken}` },
  });

  if (!spotifyRes.ok) {
    // If the Spotify token is invalid/expired, do not blindly clear the product.
    // Return the current state so the client can decide what to do.
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { spotifyProduct: true },
    });
    return { spotifyProduct: current?.spotifyProduct ?? null };
  }

  const profile = await spotifyRes.json() as { id?: string; product?: string };

  // Safety: ensure the Spotify profile matches the linked account
  if (profile.id && profile.id !== user.spotifyId) {
    throw new ApiError(
      'Spotify profile does not match the linked account',
      'CONFLICT',
      409,
    );
  }

  const spotifyProduct = profile.product ?? null;

  await prisma.user.update({
    where: { id: userId },
    data: { spotifyProduct },
  });

  return { spotifyProduct };
};

export const linkSpotifyToUser = async (
  userId: string,
  spotifyAccessToken: string,
): Promise<{ spotifyProduct: string | null; linked: boolean }> => {
  const spotifyRes = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${spotifyAccessToken}` },
  });

  if (!spotifyRes.ok) {
    throw new ApiError('Failed to fetch Spotify profile', 'SPOTIFY_API_ERROR', 502);
  }

  const profile = await spotifyRes.json() as {
    id: string;
    display_name?: string;
    email?: string;
    images?: Array<{ url: string }>;
    product?: string;
  };

  if (!profile.id) {
    throw new ApiError('Invalid Spotify profile', 'UNAUTHORIZED', 401);
  }

  // Check if this Spotify ID is already linked to a different account
  const existingUser = await prisma.user.findUnique({
    where: { spotifyId: profile.id },
    select: { id: true },
  });

  if (existingUser && existingUser.id !== userId) {
    throw new ApiError(
      'This Spotify account is already linked to another user',
      'CONFLICT',
      409,
    );
  }

  const spotifyProduct = profile.product ?? null;

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      spotifyId: profile.id,
      spotifyProduct,
      photoUrl: profile.images?.[0]?.url || undefined,
    },
    select: { id: true, spotifyProduct: true },
  });

  return { spotifyProduct: updatedUser.spotifyProduct, linked: true };
};

export const buildGoogleRedirectUrl = async (user: Pick<User, 'id' | 'email' | 'displayName' | 'role' | 'spotifyId' | 'spotifyProduct'>): Promise<string> => {
  const auth = await buildAuthResult(user);
  const query = new URLSearchParams({
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    userId: auth.user.id,
    email: auth.user.email,
    displayName: auth.user.displayName,
    role: auth.user.role,
    spotifyId: auth.user.spotifyId ?? '',
    spotifyProduct: auth.user.spotifyProduct ?? ''
  });

  return `${env.CLIENT_URL}/auth/callback?${query.toString()}`;
};
