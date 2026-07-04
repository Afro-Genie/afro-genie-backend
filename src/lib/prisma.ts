import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { env } from './env';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const parsedDatabaseUrl = new URL(env.DATABASE_URL);
const schema = parsedDatabaseUrl.searchParams.get('schema') || undefined;

// `channel_binding` is unsupported by node-postgres; strip it before creating the pool.
parsedDatabaseUrl.searchParams.delete('channel_binding');
const cleanUrl = parsedDatabaseUrl.toString();

const pool = new Pool({
  connectionString: cleanUrl,
});

const adapter = new PrismaPg(pool, {
  schema,
});

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error']
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
