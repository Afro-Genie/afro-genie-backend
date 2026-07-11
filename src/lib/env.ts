import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  TYPESENSE_HOST: z.string().min(1, 'TYPESENSE_HOST is required'),
  TYPESENSE_PORT: z.coerce.number().int().positive().default(8108),
  TYPESENSE_PROTOCOL: z.enum(['http', 'https']).default('http'),
  TYPESENSE_API_KEY: z.string().min(1, 'TYPESENSE_API_KEY is required'),
  TYPESENSE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_REFRESH_SECRET: z.string().optional(),
  CLIENT_URL: z.string().url().default('http://localhost:5173'),
  FRONTEND_URL: z.string().url().optional(),
  CORS_ORIGIN: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().url().default('http://localhost:4000/api/auth/google/callback'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM_EMAIL: z.string().email().optional(),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  OPENAI_API_KEY: z.string().optional(),
  AI_PROVIDER: z.string().optional(),
  AI_TRANSLATION_PROVIDER: z.string().default('gemini'),
  TRANSLATION_RATE_LIMIT_PER_DAY: z.coerce.number().int().positive().default(20),
  TRANSLATION_DAILY_BUDGET_USD: z.coerce.number().positive().default(5.0),
  SYNC_STALE_THRESHOLD_HOURS: z.coerce.number().int().positive().default(72),
  SYNC_MAX_BATCH: z.coerce.number().int().positive().default(50),
  SYNC_RETRY_AFTER_MAX_SECONDS: z.coerce.number().int().positive().default(60),
  APP_VERSION: z.string().default('1.0.0'),
  ENABLE_WORKERS: z.coerce.boolean().default(false)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');

  throw new Error(`Invalid environment configuration: ${details}`);
}

export const env = parsed.data;

if (env.FRONTEND_URL) {
  env.CLIENT_URL = env.FRONTEND_URL;
}

if (!env.CORS_ORIGIN) {
  env.CORS_ORIGIN = env.CLIENT_URL;
}

if (!env.JWT_REFRESH_SECRET) {
  env.JWT_REFRESH_SECRET = env.JWT_SECRET;
}
