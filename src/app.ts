import path from 'path';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import passport from 'passport';
import pinoHttp from 'pino-http';
import { adminSeederRouter } from './routes/admin/seeder';
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
import { spotifyRouter } from './routes/spotify';
import { tokensRouter } from './routes/tokens';
import { translationsRouter } from './routes/translations';
import { usersRouter } from './routes/users';
import { uploadRouter } from './routes/upload';
import { lyricsRouter } from './routes/lyrics';
import { storeRouter } from './routes/store';
import { referralsRouter } from './routes/referrals';
import { leaderboardHistoryRouter } from './routes/leaderboardHistory';
import { moderationRouter } from './routes/moderation';
import { adminModerationRouter } from './routes/admin/moderation';
import { adminTranslationsRouter } from './routes/admin/translations';
import { adminLyricsRouter } from './routes/admin/lyrics';
import { translationModerationRouter } from './routes/translationModeration';
import { notificationsRouter } from './routes/notifications';
import { env } from './lib/env';
import { logger } from './lib/logger';
import { authenticate, requireRole } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
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

app.use(pinoHttp({ logger }));
app.use(helmet());
app.use(
  cors({
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
  })
);
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.resolve(__dirname, '../uploads')));
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
if (featureFlags.STORE) {
  app.use('/api', storeRouter);
}
if (featureFlags.REFERRALS) {
  app.use('/api', referralsRouter);
}
app.use('/api', leaderboardHistoryRouter);
app.use('/api/admin', adminModerationRouter);
app.use('/api/admin', adminTranslationsRouter);
app.use('/api/admin', adminLyricsRouter);
app.use('/api/admin', adminSongsRouter);
app.use('/api/admin', adminSeederRouter);
app.use('/api/admin', adminUsersRouter);
app.use('/api/admin', adminTokensRouter);
app.use('/api/admin', adminStoreRouter);
app.use('/api/admin', adminSyncRouter);
app.use('/api/admin', adminGenresRouter);
app.use('/api/admin', adminRoleRequestsRouter);
app.use('/api/admin', adminArtistApplicationsRouter);
app.use('/api/admin', adminArtistsRouter);
app.use('/api/admin', adminRewardsRouter);
app.use('/api', spotifyRouter);
app.use('/api/roles', roleRequestsRouter);

app.get('/api/admin/ping', authenticate, requireRole('ADMIN'), (_req, res) => {
  res.status(200).json({ ok: true, scope: 'ADMIN' });
});

app.get('/api/artist/ping', authenticate, requireRole('ARTIST'), (_req, res) => {
  res.status(200).json({ ok: true, scope: 'ARTIST' });
});

app.use(notFoundHandler);
app.use(errorHandler);
