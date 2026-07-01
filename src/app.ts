import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import passport from 'passport';
import pinoHttp from 'pino-http';
import { adminSongsRouter } from './routes/admin/songs';
import { artistsRouter } from './routes/artists';
import { authRouter } from './routes/auth';
import { healthRouter } from './routes/health';
import { searchRouter } from './routes/search';
import { songsRouter } from './routes/songs';
import { spotifyRouter } from './routes/spotify';
import { translationsRouter } from './routes/translations';
import { logger } from './lib/logger';
import { authenticate, requireRole } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

export const app = express();

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
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(passport.initialize());
app.use('/api', apiLimiter);

app.use('/api', healthRouter);
app.use('/api', authRouter);
app.use('/api', searchRouter);
app.use('/api', translationsRouter);
app.use('/api', songsRouter);
app.use('/api', artistsRouter);
app.use('/api/admin', adminSongsRouter);
app.use('/api', spotifyRouter);

app.get('/api/admin/ping', authenticate, requireRole('ADMIN'), (_req, res) => {
  res.status(200).json({ ok: true, scope: 'ADMIN' });
});

app.get('/api/artist/ping', authenticate, requireRole('ARTIST'), (_req, res) => {
  res.status(200).json({ ok: true, scope: 'ARTIST' });
});

app.use(notFoundHandler);
app.use(errorHandler);
