import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { env } from './env';
import { logger } from './logger';

const parsedDatabaseUrl = new URL(env.DATABASE_URL);
const schema = parsedDatabaseUrl.searchParams.get('schema') || undefined;

// `channel_binding` is unsupported by node-postgres; strip it before creating the pool.
parsedDatabaseUrl.searchParams.delete('channel_binding');
const cleanUrl = parsedDatabaseUrl.toString();

const pool = new Pool({
  connectionString: cleanUrl,
  // Neon (and any proxy in the path) can drop idle sockets. Keepalive plus a
  // bounded connect timeout makes a dead socket fail fast instead of hanging a
  // request, and the retry extension below re-establishes a fresh connection.
  keepAlive: true,
  connectionTimeoutMillis: 15_000,
});

const adapter = new PrismaPg(pool, {
  schema,
});

/**
 * Transient connectivity failures. These are safe to retry because the query
 * never reached the database: P1001/P1002 are connection/initialisation
 * failures and P2024 is a pool-acquisition timeout.
 *
 * This matters on networks where DNS or the database endpoint blips for a few
 * seconds (mobile hotspots, VPN reconnects, Neon cold starts). Before this,
 * a single dropped packet surfaced to the user as a 503 on login.
 */
const TRANSIENT_CODES = new Set(['P1001', 'P1002', 'P2024']);
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 750];

const isTransientDbError = (error: unknown): boolean => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return TRANSIENT_CODES.has(error.code);
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Can't reach database server") ||
    message.includes('Connection terminated') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ENOTFOUND')
  );
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createPrismaClient = () => {
  const base = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error'],
  });

  return base.$extends({
    query: {
      async $allOperations({ args, query }) {
        let lastError: unknown;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          try {
            return await query(args);
          } catch (error) {
            lastError = error;

            if (attempt === MAX_ATTEMPTS - 1 || !isTransientDbError(error)) {
              throw error;
            }

            const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
            logger.warn(
              { attempt: attempt + 1, delay, err: error },
              'Transient database error, retrying query',
            );
            await sleep(delay);
          }
        }

        throw lastError;
      },
    },
  });
};

type AppPrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as { prisma?: AppPrismaClient };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
