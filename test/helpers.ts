import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';

// Every service under test may lazily open a Redis connection (e.g. the ledger
// summary cache invalidation). node:test won't exit while the socket is open,
// so make sure it is closed once the file's tests finish.
after(async () => {
  try {
    await redis.quit();
  } catch {
    // already closed
  }
});

let counter = 0;

export const makeEmail = (): string =>
  `r3-test-${Date.now()}-${counter++}-${randomUUID().slice(0, 8)}@afrogenie.local`;

export async function createUser(extra: { role?: string; email?: string } = {}) {
  const user = await prisma.user.create({
    data: {
      email: extra.email ?? makeEmail(),
      displayName: `R3 Test ${randomUUID().slice(0, 6)}`,
      ...(extra.role ? { role: extra.role } : {}),
    },
  });
  return user;
}

export async function cleanupUser(id: string) {
  try {
    await prisma.user.delete({ where: { id } });
  } catch {
    // already gone
  }
}

export const uid = (): string => randomUUID().slice(0, 8);
