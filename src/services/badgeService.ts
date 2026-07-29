import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import type { BadgeType } from '@prisma/client';

const BADGE_DESCRIPTIONS: Record<BadgeType, string> = {
  EARLY_ADOPTER: 'Earned your first approved translation',
  TOP_TRANSLATOR: 'Completed 10 or more approved translations',
  CULTURE_CURATOR: 'Contributed cultural context to 5 or more translations',
  COMMUNITY_HELPER: 'Created 10 or more community topics or comments',
  ARTIST_SPOTLIGHT: 'Verified artist on the platform',
  DAILY_STREAK_7: 'Logged in for 7 consecutive days',
  FIRST_PROFILE: 'Completed profile setup',
  GENEROUS_SUPPORTER: 'Purchased 3 or more items from the store',
  SEASON_CHAMPION: 'Finished in the top 3 on a seasonal leaderboard',
  REFERRAL_STAR: 'Referred 3 or more new users',
  GUARDIAN: 'Resolved 10 or more flagged content reports',
  HELPFUL_VOTER: 'Cast 50 or more upvotes across translations, topics, and comments',
  GENIUS_ARTIST: 'Completed 100 or more approved translations, or 10 or more of your songs have been translated',
  MODERATION_QUEUE: 'Resolved 20 or more flagged content reports',
  PLATINUM_ARTIST: 'Published 10 or more songs as a verified artist',
  FAN_FAVORITE: 'Received 50 or more upvotes on your translations',
};

function logMetric(event: string, data: Record<string, unknown>) {
  logger.info({ metric: event, ...data }, `metric:${event}`);
}

interface UserCounts {
  approvedTranslations: number;
  culturalContextTranslations: number;
  totalTopics: number;
  totalComments: number;
  isVerifiedArtist: boolean;
  storePurchases: number;
  referralCount: number;
  hasProfilePhoto: boolean;
  resolvedReports: number;
  totalVotesCast: number;
  artistCollaborations: number;
  songCount: number;
  translationUpvotesReceived: number;
}

async function fetchUserCounts(userId: string): Promise<UserCounts> {
  const artist = await prisma.artist.findFirst({ where: { userId, verified: true }, select: { id: true } });

  const [
    approvedTranslations,
    culturalContextTranslations,
    totalTopics,
    totalComments,
    storePurchases,
    referralCount,
    user,
    resolvedReports,
    translationVotes,
    topicVotes,
    commentVotes,
    artistSongTranslations,
  ] = await Promise.all([
    prisma.translation.count({ where: { userId, status: 'APPROVED' } }),
    prisma.translation.count({ where: { userId, status: 'APPROVED', culturalContext: { not: null } } }),
    prisma.topic.count({ where: { authorId: userId } }),
    prisma.topicComment.count({ where: { userId } }),
    prisma.storePurchase.count({ where: { userId } }),
    prisma.user.count({ where: { referredByUserId: userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { photoUrl: true, displayName: true } }),
    prisma.contentReport.count({ where: { moderatorId: userId, status: 'RESOLVED' } }),
    prisma.translationVote.count({ where: { userId, voteType: 'UPVOTE' } }),
    prisma.topicVote.count({ where: { userId, voteType: 'UPVOTE' } }),
    prisma.topicCommentVote.count({ where: { userId, voteType: 'UPVOTE' } }),
    // Distinct songs by this artist that have approved translations
    artist
      ? prisma.translation.groupBy({
          by: ['songId'],
          where: {
            status: 'APPROVED',
            song: { artistId: artist.id },
          },
        })
      : Promise.resolve([]),
  ]);

  const songCount = artist
    ? await prisma.song.count({ where: { artistId: artist.id } })
    : 0;

  const translationUpvotesReceived = await prisma.translationVote.count({
    where: { voteType: 'UPVOTE', translation: { userId } },
  });

  return {
    approvedTranslations,
    culturalContextTranslations,
    totalTopics,
    totalComments,
    isVerifiedArtist: artist !== null,
    storePurchases,
    referralCount,
    hasProfilePhoto: !!(user?.photoUrl && user?.displayName),
    resolvedReports,
    totalVotesCast: translationVotes + topicVotes + commentVotes,
    artistCollaborations: artistSongTranslations.length,
    songCount,
    translationUpvotesReceived,
  };
}

const BADGE_CONDITIONS: Partial<Record<BadgeType, (counts: UserCounts) => boolean>> = {
  EARLY_ADOPTER: (c) => c.approvedTranslations === 1,
  TOP_TRANSLATOR: (c) => c.approvedTranslations >= 10,
  CULTURE_CURATOR: (c) => c.culturalContextTranslations >= 5,
  COMMUNITY_HELPER: (c) => c.totalTopics + c.totalComments >= 10,
  ARTIST_SPOTLIGHT: (c) => c.isVerifiedArtist,
  DAILY_STREAK_7: () => false, // Checked separately via login tracking
  FIRST_PROFILE: (c) => c.hasProfilePhoto,
  GENEROUS_SUPPORTER: (c) => c.storePurchases >= 3,
  SEASON_CHAMPION: () => false, // Awarded manually or via snapshot service
  REFERRAL_STAR: (c) => c.referralCount >= 3,
  GUARDIAN: (c) => c.resolvedReports >= 10,
  HELPFUL_VOTER: (c) => c.totalVotesCast >= 200,
  GENIUS_ARTIST: (c) => c.approvedTranslations >= 50 || c.artistCollaborations >= 10,
  MODERATION_QUEUE: (c) => c.resolvedReports >= 20,
  PLATINUM_ARTIST: (c) => c.songCount >= 10,
  FAN_FAVORITE: (c) => c.translationUpvotesReceived >= 50,
};

export async function checkAndAwardBadges(userId: string, _event?: string): Promise<BadgeType[]> {
  const newlyEarned: BadgeType[] = [];

  const [existingBadges, counts] = await Promise.all([
    prisma.userBadge.findMany({ where: { userId }, select: { badgeType: true } }),
    fetchUserCounts(userId),
  ]);

  const earnedTypes = new Set(existingBadges.map((b) => b.badgeType));

  for (const [badgeType, checkFn] of Object.entries(BADGE_CONDITIONS) as [BadgeType, (counts: UserCounts) => boolean][]) {
    if (earnedTypes.has(badgeType)) continue;

    try {
      if (!checkFn(counts)) continue;

      await prisma.userBadge.create({
        data: { userId, badgeType },
      });

      await prisma.notification.create({
        data: {
          userId,
          title: 'Badge Earned!',
          message: `You earned the ${BADGE_DESCRIPTIONS[badgeType]} badge!`,
          type: 'REWARD',
        },
      });

      newlyEarned.push(badgeType);
      logMetric('badge_awarded', { userId, badgeType });
    } catch (err) {
      logger.error({ err, userId, badgeType }, 'Failed to check/award badge');
    }
  }

  if (newlyEarned.length > 0) {
    logMetric('badges_batch_evaluated', { userId, newlyEarned, queriesRun: 2 });
  }

  return newlyEarned;
}

export async function getUserBadges(userId: string) {
  return prisma.userBadge.findMany({
    where: { userId },
    orderBy: { earnedAt: 'desc' },
  });
}
