import path from 'path';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import type { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import passport from 'passport';
import pinoHttp from 'pino-http';
import { adminSongsRouter } from './routes/admin/songs';
import { adminTokensRouter } from './routes/admin/tokens';
import { adminUsersRouter } from './routes/admin/users';
import { adminSyncRouter } from './routes/admin/sync';
import { adminGenresRouter } from './routes/admin/genres';
import { adminRoleRequestsRouter } from './routes/admin/roleRequests';
import { adminArtistApplicationsRouter } from './routes/admin/artistApplications';
import { adminArtistsRouter } from './routes/admin/artists';
import { adminRewardsRouter } from './routes/admin/rewards';
import { adminStoreRouter } from './routes/admin/store';
import { adminYoutubeRouter } from './routes/admin/youtube';
import { adminYouTubeCatalogImportsRouter } from './routes/admin/youtubeCatalogImports';
import { adminEconomyRouter } from './routes/admin/economy';
import { adminBandwidthRouter } from './routes/admin/bandwidth';
import { adminFeatureFlagsRouter } from './routes/admin/featureFlags';
import { artistPortalRouter } from './routes/artistPortal';
import { roleRequestsRouter } from './routes/roleRequests';
import { artistsRouter } from './routes/artists';
import { authRouter } from './routes/auth';
import { healthRouter } from './routes/health';
import { searchRouter } from './routes/search';
import { catalogRouter } from './routes/catalog';
import { communityRouter } from './routes/community';
import { communityRedesignRouter } from './routes/communityRedesign';
import { languagesRouter } from './routes/languages';
import { songsRouter } from './routes/songs';
import { tokensRouter } from './routes/tokens';
import { translationsRouter } from './routes/translations';
import { usersRouter } from './routes/users';
import { uploadRouter } from './routes/upload';
import { lyricsRouter } from './routes/lyrics';
import { storeRouter } from './routes/store';
import { paymentsRouter } from './routes/payments';
import { playbackRouter } from './routes/playback';
import { referralsRouter } from './routes/referrals';
import { leaderboardHistoryRouter } from './routes/leaderboardHistory';
import { challengesRouter } from './routes/challenges';
import { gamesRouter } from './routes/games';
import { moderationRouter } from './routes/moderation';
import { adminModerationRouter } from './routes/admin/moderation';
import { adminTranslationsRouter } from './routes/admin/translations';
import { adminLyricsRouter } from './routes/admin/lyrics';
import { translationModerationRouter } from './routes/translationModeration';
import { notificationsRouter } from './routes/notifications';
import { env } from './lib/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { authenticate, requireRole } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { bandwidthTrackingMiddleware } from './lib/bandwidthMonitor';
import { featureFlags } from './config/featureFlags';

export const app = express();

const corsAllowList = (env.CORS_ORIGIN || env.CLIENT_URL)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests, please try again later.',
    code: 'RATE_LIMITED'
  }
});

const apiCors = cors({
  origin: (requestOrigin, callback) => {
    if (!requestOrigin) {
      callback(null, true);
      return;
    }

    if (corsAllowList.includes(requestOrigin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
});

const publicMediaCors = cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

app.use(pinoHttp({ logger }));
app.use(helmet());
// Bandwidth tracking must run BEFORE compression so we count the compressed
// (wire) bytes actually served.
app.use(bandwidthTrackingMiddleware);
app.use((req, res, next) => {
  if (req.path.startsWith('/uploads/')) {
    publicMediaCors(req, res, next);
    return;
  }
  apiCors(req, res, next);
});
app.use(compression());
app.use(
  express.json({
    limit: '1mb',
    // Preserve the raw payload so the Paystack webhook can verify its
    // HMAC-SHA512 signature (JSON re-serialization is not byte-stable).
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));
// Uploaded audio is first-party content served under a content-addressed /
// versioned name and never mutated in place, so it is safe to cache
// aggressively (Phase 6 / 7.3.2). Without an explicit header, `express.static`
// falls back to no Cache-Control at all: every play re-validated the file with
// the origin, which was the single largest avoidable egress line item.
// `immutable` is only safe because a replaced upload gets a new filename —
// see `routes/upload.ts` for the write path.
app.use(
  '/uploads',
  express.static(path.resolve(__dirname, '../uploads'), {
    maxAge: '365d',
    immutable: true,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  })
);

const UPLOAD_FILENAME_PATTERN = /^\d{13}-[0-9a-f]{32}\.[a-z0-9]+$/i;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.webm', '.flac', '.opus']);
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
};

const setUploadResponseHeaders = (res: Response, mimeType: string, length: number, etag: string): void => {
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', length);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
};

app.get('/uploads/:filename', async (req, res, next) => {
  const filename = req.params.filename;
  if (!UPLOAD_FILENAME_PATTERN.test(filename)) {
    next();
    return;
  }

  try {
    const record = await prisma.uploadedFile.findUnique({ where: { filename } });
    if (!record) {
      next();
      return;
    }

    const extension = path.extname(filename).toLowerCase();
    const mimeType = record.mimeType || MIME_TYPES[extension] || 'application/octet-stream';
    const data = Buffer.from(record.data);
    const etag = record.checksum ? `"${record.checksum}"` : `"${data.length}-${filename}"`;

    if (req.headers['if-none-match'] === etag) {
      setUploadResponseHeaders(res, mimeType, data.length, etag);
      res.status(304).end();
      return;
    }

    setUploadResponseHeaders(res, mimeType, data.length, etag);
    if (extension === '.svg') {
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    }

    const range = req.headers.range;
    if (range && AUDIO_EXTENSIONS.has(extension)) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : NaN;
      const end = match && match[2] ? Number(match[2]) : data.length - 1;
      if (!Number.isFinite(start) || start >= data.length || end < start) {
        res.setHeader('Content-Range', `bytes */${data.length}`);
        res.status(416).end();
        return;
      }
      const safeEnd = Math.min(end, data.length - 1);
      const chunk = data.subarray(start, safeEnd + 1);
      res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${data.length}`);
      res.setHeader('Content-Length', chunk.length);
      res.status(206).end(chunk);
      return;
    }

    res.status(200).end(data);
  } catch (error) {
    next(error);
  }
});

app.use(passport.initialize());
app.use('/api', apiLimiter);

app.use('/api', healthRouter);
app.use('/api', authRouter);
app.use('/api', searchRouter);
app.use('/api', translationsRouter);
app.use('/api', translationModerationRouter);
app.use('/api', moderationRouter);
app.use('/api', notificationsRouter);
app.use('/api', catalogRouter);
app.use('/api', communityRouter);
app.use('/api', communityRedesignRouter);
app.use('/api', languagesRouter);
app.use('/api', songsRouter);
app.use('/api', artistPortalRouter);
app.use('/api', artistsRouter);
app.use('/api', usersRouter);
app.use('/api', uploadRouter);
app.use('/api', lyricsRouter);
app.use('/api', tokensRouter);
app.use('/api', paymentsRouter);
app.use('/api', playbackRouter);
if (featureFlags.STORE) {
  app.use('/api', storeRouter);
}
if (featureFlags.REFERRALS) {
  app.use('/api', referralsRouter);
}
app.use('/api', leaderboardHistoryRouter);
app.use('/api', challengesRouter);
app.use('/api', gamesRouter);
app.use('/api/admin', adminModerationRouter);
app.use('/api/admin', adminTranslationsRouter);
app.use('/api/admin', adminLyricsRouter);
app.use('/api/admin', adminSongsRouter);
app.use('/api/admin', adminUsersRouter);
app.use('/api/admin', adminTokensRouter);
app.use('/api/admin', adminStoreRouter);
app.use('/api/admin', adminSyncRouter);
app.use('/api/admin', adminGenresRouter);
app.use('/api/admin', adminRoleRequestsRouter);
app.use('/api/admin', adminArtistApplicationsRouter);
app.use('/api/admin', adminArtistsRouter);
app.use('/api/admin', adminRewardsRouter);
app.use('/api/admin', adminYoutubeRouter);
app.use('/api/admin', adminYouTubeCatalogImportsRouter);
app.use('/api/admin', adminEconomyRouter);
app.use('/api/admin', adminBandwidthRouter);
app.use('/api/admin', adminFeatureFlagsRouter);
app.use('/api/roles', roleRequestsRouter);

app.get('/api/admin/ping', authenticate, requireRole('ADMIN'), (_req, res) => {
  res.status(200).json({ ok: true, scope: 'ADMIN' });
});

app.get('/api/artist/ping', authenticate, requireRole('ARTIST'), (_req, res) => {
  res.status(200).json({ ok: true, scope: 'ARTIST' });
});

app.use(notFoundHandler);
app.use(errorHandler);
