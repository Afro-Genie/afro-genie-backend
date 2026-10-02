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
  BREVO_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  OPENAI_API_KEY: z.string().optional(),
  AI_PROVIDER: z.string().optional(),
  AI_TRANSLATION_PROVIDER: z.string().default('gemini'),
  TRANSLATION_RATE_LIMIT_PER_DAY: z.coerce.number().int().positive().default(20),
  TRANSLATION_DAILY_BUDGET_USD: z.coerce.number().positive().default(5.0),
  SYNC_STALE_THRESHOLD_HOURS: z.coerce.number().int().positive().default(168),
  SYNC_MAX_BATCH: z.coerce.number().int().positive().default(50),
  SYNC_RETRY_AFTER_MAX_SECONDS: z.coerce.number().int().positive().default(60),
  APP_VERSION: z.string().default('1.0.0'),
  ENABLE_WORKERS: z.string().default('true').transform((v) => v === 'true' || v === '1'),
  // GT payments (Paystack). Optional at the schema level so dev and test can run
  // without keys; REQUIRED in production by the cross-field check below. See
  // `assertPaymentsConfigured` for why a runtime 503 is not good enough.
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),
  PAYSTACK_CALLBACK_URL: z.string().url().optional(),
  // YouTube Data API v3 (Phase 3 playback fallback). Optional so the app boots
  // without it; YouTube matching/playback degrades to preview source.
  YOUTUBE_API_KEY: z.string().optional(),
  // Phase 4 playback rollout flag. OFF by default (legacy Spotify player + no
  // library enrichment) until the YouTube tier is validated per environment.
  FLAG_PLAYBACK_YOUTUBE: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
});

// ---------------------------------------------------------------------------
// Payments are required in production, optional everywhere else.
//
// A runtime 503 (see paymentService.requireConfigured) is the right answer for
// a developer laptop with no keys. It is the wrong answer for a production
// deploy: the app boots, health checks pass, traffic is served, and the failure
// only appears when a customer reaches the Buy GT button. So production refuses
// to start instead, and the deploy fails with a readable reason.
// ---------------------------------------------------------------------------
const PAYSTACK_REQUIRED_KEYS = [
  'PAYSTACK_SECRET_KEY',
  'PAYSTACK_PUBLIC_KEY',
  'PAYSTACK_CALLBACK_URL',
] as const;

const paymentsConfigured = PAYSTACK_REQUIRED_KEYS.every(
  (key) => Boolean(process.env[key]),
);

if (process.env.NODE_ENV === 'production' && !paymentsConfigured) {
  const missing = PAYSTACK_REQUIRED_KEYS.filter((key) => !process.env[key]);
  throw new Error(
    `Invalid environment configuration: ${missing.join(', ')} required when NODE_ENV=production. ` +
      'GT payments are live for this deploy, so an unconfigured instance would ' +
      'serve traffic and then 503 at the checkout button. Set them, or deploy ' +
      'with NODE_ENV != production if payments are genuinely disabled.',
  );
}

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

/**
 * Startup self-check (task 1.9). Returns the list of missing Paystack keys.
 *
 * A warning rather than a throw, because dev and staging legitimately run
 * without payments and must still serve audio, auth and the rest of the economy.
 * Production already hard-failed above, so reaching the warning in production
 * would mean the keys are present but empty-ish — worth surfacing anyway.
 */
export function missingPaymentKeys(): string[] {
  const source: Record<string, string | undefined> = {
    PAYSTACK_SECRET_KEY: env.PAYSTACK_SECRET_KEY,
    PAYSTACK_PUBLIC_KEY: env.PAYSTACK_PUBLIC_KEY,
    PAYSTACK_CALLBACK_URL: env.PAYSTACK_CALLBACK_URL,
  };
  return PAYSTACK_REQUIRED_KEYS.filter((key) => !source[key]);
}

/** True when GT payments can actually be attempted. */
export function paymentsAreConfigured(): boolean {
  return missingPaymentKeys().length === 0;
}
