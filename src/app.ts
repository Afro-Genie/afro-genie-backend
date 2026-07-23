import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import passport from 'passport';
import pinoHttp from 'pino-http';
import { adminSeederRouter } from './routes/admin/seeder';
import { adminSongsRouter } from './routes/admin/songs';
import { adminUsersRouter } from './routes/admin/users';
import { adminSyncRouter } from './routes/admin/sync';
import { adminGenresRouter } from './routes/admin/genres';
import { adminRoleRequestsRouter } from './routes/admin/roleRequests';
import { adminArtistApplicationsRouter } from './routes/admin/artistApplications';
import { adminArtistsRouter } from './routes/admin/artists';
import { artistPortalRouter } from './routes/artistPortal';
import { roleRequestsRouter } from './routes/roleRequests';
import { artistsRouter } from './routes/artists';
import { authRouter } from './routes/auth';
import { healthRouter } from './routes/health';
import { searchRouter } from './routes/search';
import { catalogRouter } from './routes/catalog';
import { communityRouter } from './routes/community';
import { languagesRouter } from './routes/languages';
import { songsRouter } from './routes/songs';
import { spotifyRouter } from './routes/spotify';
import { translationsRouter } from './routes/translations';
import { usersRouter } from './routes/users';
import { lyricsRouter } from './routes/lyrics';
import { env } from './lib/env';
import { logger } from './lib/logger';
import { authenticate, requireRole } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

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
app.use(passport.initialize());
app.use('/api', apiLimiter);

app.use('/api', healthRouter);
app.use('/api', authRouter);
app.use('/api', searchRouter);
app.use('/api', translationsRouter);
app.use('/api', catalogRouter);
app.use('/api', communityRouter);
app.use('/api', languagesRouter);
app.use('/api', songsRouter);
app.use('/api', artistPortalRouter);
app.use('/api', artistsRouter);
app.use('/api', usersRouter);
app.use('/api', lyricsRouter);
app.use('/api/admin', adminSongsRouter);
app.use('/api/admin', adminSeederRouter);
app.use('/api/admin', adminUsersRouter);
app.use('/api/admin', adminSyncRouter);
app.use('/api/admin', adminGenresRouter);
app.use('/api/admin', adminRoleRequestsRouter);
app.use('/api/admin', adminArtistApplicationsRouter);
app.use('/api/admin', adminArtistsRouter);
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
