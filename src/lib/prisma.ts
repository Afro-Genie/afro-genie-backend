import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { env } from './env';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Strip unsupported query parameters like channel_binding which pg may not parse
const cleanUrl = env.DATABASE_URL.replace(/&?channel_binding=[^&]+/g, '');

const pool = new Pool({
  connectionString: cleanUrl,
});

const adapter = new PrismaPg(pool);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error']
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
