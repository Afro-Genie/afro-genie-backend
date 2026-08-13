import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ApiError } from '../middleware/errorHandler';

interface PaginationParams {
  page?: number;
  limit?: number;
}

interface FeedParams extends PaginationParams {
  categoryId?: string;
  search?: string;
}

interface ExploreAlbums {
  albumId: string;
  albumName: string;
  artistName: string;
  imageUrl: string | null;
  playCount: number;
}

interface ExploreGenres {
  genreId: string;
  genreName: string;
  playCount: number;
}

interface ExploreTracks {
  songId: string;
  title: string;
  artistName: string;
  imageUrl: string | null;
  playCount: number;
}

interface ExplorePlaylists {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  createdBy: string;
  creatorName: string | null;
  likeCount: number;
  songCount: number;
}

interface ExploreData {
  albums: ExploreAlbums[];
  genres: ExploreGenres[];
  tracks: ExploreTracks[];
  playlists: ExplorePlaylists[];
}

interface RecommendedModerator {
  id: string;
  displayName: string | null;
  photoUrl: string | null;
  role: string;
  tokenBalance: number;
  reportsResolved: number;
  translationsApproved: number;
  correctionsApproved: number;
}

class CommunityRedesignService {
  // ── Feed ────────────────────────────────────────────────────
  async getFeed(params: FeedParams, userId?: string) {
    const page = params.page || 1;
    const limit = Math.min(params.limit || 20, 50);
    const where: Prisma.TopicWhereInput = {
      forumCategoryId: params.categoryId || undefined,
      softDeleted: false,
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
        orderBy: { createdAt: 'desc' },
      }),
      prisma.topic.count({ where }),
    ]);

    let userVotes = new Map<string, string>();
    if (userId) {
      const votes = await prisma.topicVote.findMany({
        where: { userId, topicId: { in: topics.map((t) => t.id) } },
        select: { topicId: true, voteType: true },
      });
      for (const v of votes) {
        userVotes.set(v.topicId, v.voteType);
      }
    }

    const result = topics.map((t) => ({
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
      isModeratorOnly: t.isModeratorOnly,
      viewCount: t.viewCount,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      userVote: userVotes.get(t.id) || null,
    }));

    return { topics: result, total, page, limit };
  }

  // ── Trending ────────────────────────────────────────────────
  async getTrending(params: PaginationParams, userId?: string) {
    const page = params.page || 1;
    const limit = Math.min(params.limit || 20, 50);

    const topics = await prisma.topic.findMany({
      where: { isLocked: false, softDeleted: false },
      include: {
        author: { select: { id: true, displayName: true, photoUrl: true, role: true } },
        forumCategory: { select: { id: true, name: true } },
        _count: { select: { comments: true } },
      },
      take: 200,
    });

    const now = Date.now();
    const scored = topics.map((t) => {
      const hoursAge = (now - new Date(t.createdAt).getTime()) / 3_600_000;
      const hotScore = (t.likes + t.viewCount * 0.5) / Math.pow(hoursAge + 2, 1.5);
      return { ...t, hotScore };
    });

    scored.sort((a, b) => b.hotScore - a.hotScore);
    const paged = scored.slice((page - 1) * limit, page * limit);

    let userVotes = new Map<string, string>();
    if (userId) {
      const votes = await prisma.topicVote.findMany({
        where: { userId, topicId: { in: paged.map((t) => t.id) } },
        select: { topicId: true, voteType: true },
      });
      for (const v of votes) {
        userVotes.set(v.topicId, v.voteType);
      }
    }

    const result = paged.map((t) => ({
      id: t.id,
      title: t.title,
      content: t.content,
      authorId: t.authorId,
      author: t.author,
      category: t.forumCategory,
      likes: t.likes,
      shares: t.shares,
      commentCount: (t as any)._count.comments,
      isPinned: t.isPinned,
      isLocked: t.isLocked,
      isModeratorOnly: t.isModeratorOnly,
      viewCount: t.viewCount,
      hotScore: t.hotScore,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      userVote: userVotes.get(t.id) || null,
    }));

    return { topics: result, total: scored.length, page, limit };
  }

  // ── Moderator's Picks ───────────────────────────────────────
  async getModeratorPicks(params: PaginationParams, userId?: string) {
    const page = params.page || 1;
    const limit = Math.min(params.limit || 20, 50);
    const where: Prisma.TopicWhereInput = { isModeratorOnly: true, softDeleted: false };

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
        orderBy: { createdAt: 'desc' },
      }),
      prisma.topic.count({ where }),
    ]);

    let userVotes = new Map<string, string>();
    if (userId) {
      const votes = await prisma.topicVote.findMany({
        where: { userId, topicId: { in: topics.map((t) => t.id) } },
        select: { topicId: true, voteType: true },
      });
      for (const v of votes) {
        userVotes.set(v.topicId, v.voteType);
      }
    }

    const result = topics.map((t) => ({
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
      isModeratorOnly: t.isModeratorOnly,
      viewCount: t.viewCount,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      userVote: userVotes.get(t.id) || null,
    }));

    return { topics: result, total, page, limit };
  }

  // ── For You ────────────────────────────────────────────────
  async getForYou(userId: string, params: PaginationParams) {
    const page = params.page || 1;
    const limit = Math.min(params.limit || 20, 50);

    const prefs = await prisma.userListeningPreference.findUnique({
      where: { userId },
    });

    if (!prefs || (prefs.genreIds.length === 0 && prefs.languageCodes.length === 0)) {
      return { topics: [], total: 0, page, limit, message: 'Listen to more songs to get personalized recommendations.' };
    }

    const where: Prisma.TopicWhereInput = {
      isLocked: false,
      softDeleted: false,
      OR: [
        ...(prefs.genreIds.length > 0
          ? [{ song: { genres: { some: { genreId: { in: prefs.genreIds } } } } }]
          : []),
        ...(prefs.languageCodes.length > 0
          ? [{ song: { songLanguages: { some: { languageCode: { in: prefs.languageCodes } } } } }]
          : []),
        ...(prefs.listenedArtistIds.length > 0
          ? [{ artistId: { in: prefs.listenedArtistIds } }]
          : []),
      ],
    };

    const [topics, total] = await Promise.all([
      prisma.topic.findMany({
        where,
        include: {
          author: { select: { id: true, displayName: true, photoUrl: true, role: true } },
          forumCategory: { select: { id: true, name: true } },
          song: { select: { id: true, title: true, imageUrl: true } },
          _count: { select: { comments: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.topic.count({ where }),
    ]);

    let userVotes = new Map<string, string>();
    const votes = await prisma.topicVote.findMany({
      where: { userId, topicId: { in: topics.map((t) => t.id) } },
      select: { topicId: true, voteType: true },
    });
    for (const v of votes) {
      userVotes.set(v.topicId, v.voteType);
    }

    const result = topics.map((t) => ({
      id: t.id,
      title: t.title,
      content: t.content,
      authorId: t.authorId,
      author: t.author,
      category: t.forumCategory,
      song: t.song,
      likes: t.likes,
      shares: t.shares,
      commentCount: t._count.comments,
      isPinned: t.isPinned,
      isLocked: t.isLocked,
      isModeratorOnly: t.isModeratorOnly,
      viewCount: t.viewCount,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      userVote: userVotes.get(t.id) || null,
    }));

    return { topics: result, total, page, limit };
  }

  // ── Explore ─────────────────────────────────────────────────
  async getExploreData(): Promise<ExploreData> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [songPlays, playlists] = await Promise.all([
      prisma.songPlay.findMany({
        where: { playedAt: { gte: thirtyDaysAgo } },
        select: { songId: true, country: true },
      }),
      prisma.playlist.findMany({
        where: { isPublic: true },
        include: {
          creator: { select: { displayName: true } },
        },
        orderBy: { likeCount: 'desc' },
        take: 20,
      }),
    ]);

    const songPlayCounts = new Map<string, number>();
    for (const sp of songPlays) {
      songPlayCounts.set(sp.songId, (songPlayCounts.get(sp.songId) || 0) + 1);
    }

    const topSongIds = [...songPlayCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id]) => id);

    const songs = await prisma.song.findMany({
      where: { id: { in: topSongIds } },
      include: {
        artist: { select: { name: true } },
        album: { select: { id: true, name: true, imageUrl: true } },
        genres: { include: { genre: true } },
      },
    });

    const songMap = new Map(songs.map((s) => [s.id, s]));

    const tracks: ExploreTracks[] = topSongIds
      .map((id) => {
        const s = songMap.get(id);
        if (!s) return null;
        return {
          songId: s.id,
          title: s.title,
          artistName: s.artist.name,
          imageUrl: s.imageUrl,
          playCount: songPlayCounts.get(id) || 0,
        };
      })
      .filter((t): t is ExploreTracks => t !== null);

    const albumMap = new Map<string, { album: NonNullable<(typeof songs)[0]['album']>; playCount: number }>();
    for (const s of songs) {
      if (s.album) {
        const existing = albumMap.get(s.album.id);
        if (existing) {
          existing.playCount += songPlayCounts.get(s.id) || 0;
        } else {
          albumMap.set(s.album.id, { album: s.album, playCount: songPlayCounts.get(s.id) || 0 });
        }
      }
    }

    const albums: ExploreAlbums[] = [...albumMap.entries()]
      .sort((a, b) => b[1].playCount - a[1].playCount)
      .slice(0, 10)
      .map(([albumId, { album, playCount }]) => {
        const songForArtist = songs.find((s) => s.albumId === album.id);
        return {
          albumId,
          albumName: album.name,
          artistName: songForArtist?.artist.name || 'Unknown',
          imageUrl: album.imageUrl,
          playCount,
        };
      });

    const genreCounts = new Map<string, number>();
    for (const s of songs) {
      for (const sg of s.genres) {
        genreCounts.set(sg.genreId, (genreCounts.get(sg.genreId) || 0) + (songPlayCounts.get(s.id) || 0));
      }
    }

    const genreIds = [...genreCounts.keys()];
    const genres = await prisma.genre.findMany({
      where: { id: { in: genreIds } },
    });
    const genreNameMap = new Map(genres.map((g) => [g.id, g.name]));

    const genreList: ExploreGenres[] = [...genreCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([genreId, playCount]) => ({
        genreId,
        genreName: genreNameMap.get(genreId) || 'Unknown',
        playCount,
      }));

    const playlistList: ExplorePlaylists[] = playlists.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      imageUrl: p.imageUrl,
      createdBy: p.createdBy,
      creatorName: p.creator.displayName,
      likeCount: p.likeCount,
      songCount: p.songIds.length,
    }));

    return { albums, genres: genreList, tracks, playlists: playlistList };
  }

  // ── Recommended Moderators ─────────────────────────────────
  async getRecommendedModerators(limit = 10): Promise<RecommendedModerator[]> {
    const moderators = await prisma.user.findMany({
      where: { role: 'MODERATOR' },
      select: {
        id: true,
        displayName: true,
        photoUrl: true,
        role: true,
        moderatorPinnedAt: true,
      },
      take: 50,
    });

    const userIds = moderators.map((m) => m.id);
    const tokenBalances = await prisma.tokenLedger.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds } },
      _sum: { amount: true },
    });

    const tokenMap = new Map(tokenBalances.map((t) => [t.userId, t._sum.amount || 0]));

    const actionCounts = await prisma.modActionLog.groupBy({
      by: ['moderatorId'],
      where: {
        moderatorId: { in: userIds },
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      _count: { id: true },
    });

    const actionMap = new Map(actionCounts.map((a) => [a.moderatorId, a._count.id]));

    const scored = moderators.map((m) => {
      const tokenBalance = tokenMap.get(m.id) || 0;
      const recentActions = actionMap.get(m.id) || 0;
      const pinBoost = m.moderatorPinnedAt ? 10000 : 0;
      const score = pinBoost + tokenBalance + recentActions * 10;
      return { ...m, tokenBalance, recentActions, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const result: RecommendedModerator[] = scored.slice(0, limit).map((m) => ({
      id: m.id,
      displayName: m.displayName,
      photoUrl: m.photoUrl,
      role: m.role,
      tokenBalance: m.tokenBalance,
      reportsResolved: 0,
      translationsApproved: 0,
      correctionsApproved: 0,
    }));

    return result;
  }

  // ── Record Topic View ──────────────────────────────────────
  async recordTopicView(topicId: string, userId?: string) {
    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic || topic.softDeleted) {
      throw new ApiError('Topic not found', 'NOT_FOUND', 404);
    }

    await prisma.$transaction(async (tx) => {
      await tx.topic.update({
        where: { id: topicId },
        data: { viewCount: { increment: 1 } },
      });

      await tx.topicView.create({
        data: {
          topicId,
          userId: userId || null,
        },
      });
    });

    return { success: true };
  }

  // ── Compute Listening Preferences ──────────────────────────
  async computeListeningPreferences(userId: string) {
    const history = await prisma.userHistory.findMany({
      where: { userId },
      include: {
        song: {
          include: {
            genres: { include: { genre: true } },
            songLanguages: true,
            artist: true,
          },
        },
      },
      orderBy: { viewedAt: 'desc' },
      take: 50,
    });

    const genreIds = new Set<string>();
    const languageCodes = new Set<string>();
    const listenedArtistIds = new Set<string>();

    for (const h of history) {
      for (const g of h.song.genres) {
        genreIds.add(g.genreId);
      }
      for (const l of h.song.songLanguages) {
        languageCodes.add(l.languageCode);
      }
      listenedArtistIds.add(h.song.artistId);
    }

    const prefs = await prisma.userListeningPreference.upsert({
      where: { userId },
      create: {
        userId,
        genreIds: [...genreIds],
        languageCodes: [...languageCodes],
        listenedArtistIds: [...listenedArtistIds],
      },
      update: {
        genreIds: [...genreIds],
        languageCodes: [...languageCodes],
        listenedArtistIds: [...listenedArtistIds],
        lastComputedAt: new Date(),
      },
    });

    return prefs;
  }
}

export const communityRedesignService = new CommunityRedesignService();
