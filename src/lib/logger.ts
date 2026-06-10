import pino from 'pino';
import { env } from './env';

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  base: {
    service: 'afro-genie-server'
  },
  redact: {
    paths: ['req.headers.authorization'],
    remove: true
  }
});
