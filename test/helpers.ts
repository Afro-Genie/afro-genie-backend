import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';

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
