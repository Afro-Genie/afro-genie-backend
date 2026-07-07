import type { Prisma, VoteType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ApiError } from '../middleware/errorHandler';

interface ListTopicsParams {
  categoryId?: string;
  sort?: 'hot' | 'new' | 'top';
  page?: number;
  limit?: number;
  search?: string;
}

interface CreateTopicData {
  title: string;
  content: string;
  forumCategoryId: string;
  songId?: string;
  artistId?: string;
}

interface CreateCommentData {
  topicId: string;
  content: string;
  parentCommentId?: string;
}

class CommunityService {
  // ── Categories ──────────────────────────────────────────────
  async listCategories() {
    const categories = await prisma.forumCategory.findMany({
      orderBy: { order: 'asc' },
      include: {
        _count: {
          select: {
            topics: true,
            memberships: true,
          },
        },
      },
    });

    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      icon: c.icon,
      order: c.order,
      topicCount: c._count.topics,
      memberCount: c._count.memberships,
    }));
  }

  async joinCategory(userId: string, categoryId: string) {
    const membership = await prisma.userCommunityMembership.upsert({
      where: { userId_categoryId: { userId, categoryId } },
      create: { userId, categoryId },
      update: {},
    });
    return membership;
  }

  // ── Topics ──────────────────────────────────────────────────
  async listTopics(params: ListTopicsParams) {
    const page = params.page || 1;
    const limit = Math.min(params.limit || 20, 50);
    const where: Prisma.TopicWhereInput = {
      forumCategoryId: params.categoryId || undefined,
      title: params.search
        ? { contains: params.search, mode: 'insensitive' }
        : undefined,
    };

    const [topics, total] = await Promise.all([
      prisma.topic.findMany({
        where,
        include: {
          author: { select: { id: true, displayName: true, photoUrl: true, role: true } },
          forumCategory: { select: { id: true, name: true } },
          _count: { select: { comments: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: params.sort === 'new' ? { createdAt: 'desc' } : { likes: 'desc' },
      }),
      prisma.topic.count({ where }),
    ]);

    let result = topics.map((t) => ({
      id: t.id,
      title: t.title,
      content: t.content,
      authorId: t.authorId,
      author: t.author,
      category: t.forumCategory,
      likes: t.likes,
      shares: t.shares,
      commentCount: t._count.comments,
      isPinned: t.isPinned,
      isLocked: t.isLocked,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      hotScore: 0,
    }));

    if (params.sort === 'hot') {
      const now = Date.now();
      result = result.map((t) => {
        const hoursAge = (now - new Date(t.createdAt).getTime()) / 3_600_000;
        t.hotScore = t.likes / Math.pow(hoursAge + 2, 1.5);
        return t;
      });
      result.sort((a, b) => b.hotScore - a.hotScore);
    }

    // Pinned topics always first
    result.sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return 0;
    });

    return { topics: result, total, page, limit };
  }

  async createTopic(data: CreateTopicData, userId: string) {
    const topic = await prisma.$transaction(async (tx) => {
      const created = await tx.topic.create({
        data: {
          title: data.title,
          content: data.content,
          authorId: userId,
          category: 'GENERAL',
          forumCategoryId: data.forumCategoryId,
          songId: data.songId || null,
          artistId: data.artistId || null,
        },
      });

      await tx.forumCategory.update({
        where: { id: data.forumCategoryId },
        data: { topicCount: { increment: 1 } },
      });

      return created;
    });

    return topic;
  }

  async getTopic(id: string) {
    const topic = await prisma.topic.findUnique({
      where: { id },
      include: {
        author: { select: { id: true, displayName: true, photoUrl: true, role: true } },
        forumCategory: { select: { id: true, name: true } },
        song: { select: { id: true, title: true, artistId: true, imageUrl: true } },
        artist: { select: { id: true, name: true, imageUrl: true } },
      },
    });

    if (!topic) {
      throw new ApiError('Topic not found', 'NOT_FOUND', 404);
    }

    // Fetch all comments for this topic, build nested tree
    const comments = await prisma.topicComment.findMany({
      where: { topicId: id },
      include: {
        user: { select: { id: true, displayName: true, photoUrl: true, role: true } },
        _count: { select: { replies: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const commentMap = new Map<string, any>();
    const rootComments: any[] = [];

    for (const c of comments) {
      commentMap.set(c.id, { ...c, replies: [], replyCount: c._count.replies });
    }

    for (const c of commentMap.values()) {
      if (c.parentCommentId && commentMap.has(c.parentCommentId)) {
        commentMap.get(c.parentCommentId).replies.push(c);
      } else if (!c.parentCommentId) {
        rootComments.push(c);
      }
    }

    // Limit to first 20 top-level comments
    const sliced = rootComments.slice(0, 20);

    return {
      ...topic,
      comments: sliced,
    };
  }

  async createComment(data: CreateCommentData, userId: string) {
    const topic = await prisma.topic.findUnique({ where: { id: data.topicId } });
    if (!topic) {
      throw new ApiError('Topic not found', 'NOT_FOUND', 404);
    }
    if (topic.isLocked) {
      throw new ApiError('Topic is locked', 'TOPIC_LOCKED', 403);
    }

    // Validate parentCommentId belongs to the same topic
    if (data.parentCommentId) {
      const parent = await prisma.topicComment.findUnique({
        where: { id: data.parentCommentId },
      });
      if (!parent || parent.topicId !== data.topicId) {
        throw new ApiError('Parent comment not found in this topic', 'INVALID_PARENT', 400);
      }
    }

    const comment = await prisma.$transaction(async (tx) => {
      const created = await tx.topicComment.create({
        data: {
          topicId: data.topicId,
          userId,
          content: data.content,
          parentCommentId: data.parentCommentId || null,
        },
      });

      await tx.topic.update({
        where: { id: data.topicId },
        data: { commentCount: { increment: 1 } },
      });

      return created;
    });

    return comment;
  }

  // ── Voting ──────────────────────────────────────────────────
  async voteOnTopic(userId: string, topicId: string, voteType: VoteType) {
    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic) {
      throw new ApiError('Topic not found', 'NOT_FOUND', 404);
    }

    const existing = await prisma.topicVote.findUnique({
      where: { userId_topicId: { userId, topicId } },
    });

    if (existing) {
      if (existing.voteType === voteType) {
        throw new ApiError('Already voted', 'ALREADY_VOTED', 409);
      }

      // Change vote: upsert + adjust likes by +2 (remove -1, add +1)
      await prisma.$transaction(async (tx) => {
        await tx.topicVote.update({
          where: { id: existing.id },
          data: { voteType },
        });

        const delta = voteType === 'UPVOTE' ? 2 : -2;
        await tx.topic.update({
          where: { id: topicId },
          data: { likes: { increment: delta } },
        });
      });
    } else {
      // New vote
      await prisma.$transaction(async (tx) => {
        await tx.topicVote.create({
          data: { userId, topicId, voteType },
        });

        const delta = voteType === 'UPVOTE' ? 1 : -1;
        await tx.topic.update({
          where: { id: topicId },
          data: { likes: { increment: delta } },
        });
      });
    }

    const updated = await prisma.topic.findUnique({
      where: { id: topicId },
      select: { likes: true },
    });

    return { likes: updated!.likes };
  }

  async voteOnComment(userId: string, commentId: string, voteType: VoteType) {
    const comment = await prisma.topicComment.findUnique({ where: { id: commentId } });
    if (!comment) {
      throw new ApiError('Comment not found', 'NOT_FOUND', 404);
    }

    const existing = await prisma.topicCommentVote.findUnique({
      where: { userId_commentId: { userId, commentId } },
    });

    if (existing) {
      if (existing.voteType === voteType) {
        throw new ApiError('Already voted', 'ALREADY_VOTED', 409);
      }

      await prisma.$transaction(async (tx) => {
        await tx.topicCommentVote.update({
          where: { id: existing.id },
          data: { voteType },
        });

        const delta = voteType === 'UPVOTE' ? 2 : -2;
        await tx.topicComment.update({
          where: { id: commentId },
          data: { likes: { increment: delta } },
        });
      });
    } else {
      await prisma.$transaction(async (tx) => {
        await tx.topicCommentVote.create({
          data: { userId, commentId, voteType },
        });

        const delta = voteType === 'UPVOTE' ? 1 : -1;
        await tx.topicComment.update({
          where: { id: commentId },
          data: { likes: { increment: delta } },
        });
      });
    }

    const updated = await prisma.topicComment.findUnique({
      where: { id: commentId },
      select: { likes: true },
    });

    return { likes: updated!.likes };
  }

  // ── Moderation ──────────────────────────────────────────────
  async pinTopic(id: string) {
    const topic = await prisma.topic.findUnique({ where: { id } });
    if (!topic) {
      throw new ApiError('Topic not found', 'NOT_FOUND', 404);
    }

    const updated = await prisma.topic.update({
      where: { id },
      data: { isPinned: !topic.isPinned },
    });

    return { isPinned: updated.isPinned };
  }

  async lockTopic(id: string) {
    const topic = await prisma.topic.findUnique({ where: { id } });
    if (!topic) {
      throw new ApiError('Topic not found', 'NOT_FOUND', 404);
    }

    const updated = await prisma.topic.update({
      where: { id },
      data: { isLocked: !topic.isLocked },
    });

    return { isLocked: updated.isLocked };
  }

  async softDeleteTopic(id: string) {
    const topic = await prisma.topic.findUnique({ where: { id } });
    if (!topic) {
      throw new ApiError('Topic not found', 'NOT_FOUND', 404);
    }

    await prisma.topic.update({
      where: { id },
      data: { title: '[deleted]', content: '[deleted]' },
    });

    return { deleted: true };
  }
}

export const communityService = new CommunityService();
