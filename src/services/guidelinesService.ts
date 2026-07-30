import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export async function getGuidelines(): Promise<{ id: string; content: string; version: number; updatedBy: string | null; updatedAt: Date; createdAt: Date } | null> {
  const guideline = await prisma.communityGuideline.findFirst({
    orderBy: { version: 'desc' },
  });
  return guideline;
}

export async function upsertGuidelines(
  content: string,
  updatedBy: string,
): Promise<{ id: string; content: string; version: number; updatedBy: string | null; updatedAt: Date; createdAt: Date }> {
  const existing = await prisma.communityGuideline.findFirst({
    orderBy: { version: 'desc' },
  });

  if (existing) {
    return prisma.communityGuideline.update({
      where: { id: existing.id },
      data: {
        content,
        version: existing.version + 1,
        updatedBy,
      },
    });
  }

  return prisma.communityGuideline.create({
    data: { content, version: 1, updatedBy },
  });
}
