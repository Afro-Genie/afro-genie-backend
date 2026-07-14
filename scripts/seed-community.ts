/**
 * Seed Community Data
 *
 * Creates topics, translations, comments, votes, badges, and notifications.
 * The main seed script only creates these on empty DB — this script adds them
 * regardless, using existing songs and users.
 *
 * Usage: npx tsx scripts/seed-community.ts
 */

import 'dotenv/config';
import { PrismaClient, TranslationStatus, VoteType, CorrectionStatus, TopicCategory, NotificationType, BadgeType, RequestStatus, ArtistApplicationStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('── Seeding Community Data ───────────────────────────────────\n');

  const existingTopics = await prisma.topic.count();
  if (existingTopics > 0) {
    console.log(`  ${existingTopics} topics already exist — skipping community seed.`);
    await prisma.$disconnect();
    await pool.end();
    return;
  }

  // Get users
  const users = await prisma.user.findMany({ select: { id: true, role: true, displayName: true } });
  const adminUser = users.find(u => u.role === 'ADMIN');
  const regularUser = users.find(u => u.role === 'USER');

  if (!adminUser || !regularUser) {
    console.log('  ❌ Need at least admin and user accounts');
    await prisma.$disconnect();
    await pool.end();
    return;
  }

  // Get songs
  const songs = await prisma.song.findMany({
    take: 16,
    orderBy: { createdAt: 'asc' },
    select: { id: true, title: true },
  });

  if (songs.length < 2) {
    console.log('  ❌ Need at least 2 songs');
    await prisma.$disconnect();
    await pool.end();
    return;
  }

  const forumCategories = await prisma.forumCategory.findMany({
    orderBy: { order: 'asc' },
    select: { id: true, name: true },
  });

  console.log(`  Users: ${users.length}, Songs: ${songs.length}, Categories: ${forumCategories.length}`);

  // ── Topics ──
  console.log('  Creating topics...');
  const topic1 = await prisma.topic.create({
    data: {
      title: `What does "${songs[0].title}" really mean in context?`,
      content: 'I understand the literal translation, but what is the emotional framing in Nigerian Pidgin? The way the artist delivers the chorus feels like it carries more weight than the words alone suggest.',
      authorId: regularUser.id,
      category: TopicCategory.TRANSLATION,
      forumCategoryId: forumCategories[0]?.id,
      songId: songs[0].id,
      likes: 12, shares: 3, commentCount: 0, isPinned: true,
    },
  });

  const topic2 = await prisma.topic.create({
    data: {
      title: 'Afrobeats hooks that changed global pop',
      content: 'Share songs that made non-African audiences pick up African slang and rhythm patterns. Which tracks broke through barriers and why?',
      authorId: adminUser.id,
      category: TopicCategory.SONG_DISCUSSION,
      forumCategoryId: forumCategories[1]?.id,
      likes: 20, shares: 6, commentCount: 0, isPinned: false,
    },
  });

  const topic3 = await prisma.topic.create({
    data: {
      title: 'Best Amapiano tracks this month',
      content: 'The Amapiano scene keeps evolving. What are your current favorites? Drop your playlists below.',
      authorId: regularUser.id,
      category: TopicCategory.GENERAL,
      forumCategoryId: forumCategories[6]?.id,
      songId: songs.length > 5 ? songs[5].id : songs[0].id,
      likes: 8, shares: 2, commentCount: 0, isPinned: false,
    },
  });

  const topic4 = await prisma.topic.create({
    data: {
      title: `${songs[1].title} — cultural breakdown`,
      content: `Let's break down the cultural references in "${songs[1].title}". What slang or proverbs is the artist using?`,
      authorId: adminUser.id,
      category: TopicCategory.SONG_DISCUSSION,
      forumCategoryId: forumCategories[1]?.id,
      songId: songs[1].id,
      likes: 15, shares: 4, commentCount: 0, isPinned: false,
    },
  });

  console.log(`  ✅ ${4} topics created`);

  // ── Comments ──
  console.log('  Creating comments...');
  const comment1 = await prisma.topicComment.create({
    data: { topicId: topic1.id, userId: adminUser.id, content: 'In this context, it carries resignation after emotional investment. The Pidgin shifts the tone from formal to intimate.', likes: 5 },
  });
  await prisma.topicComment.create({
    data: { topicId: topic1.id, userId: regularUser.id, parentCommentId: comment1.id, content: 'That makes sense. I hear that tone in the chorus delivery.', likes: 2 },
  });
  await prisma.topicComment.create({
    data: { topicId: topic2.id, userId: regularUser.id, content: 'Essence by Wizkid is still a perfect entry point for many listeners.', likes: 4 },
  });
  await prisma.topicComment.create({
    data: { topicId: topic2.id, userId: adminUser.id, content: 'Completely agree. The collaboration with Tems sealed that crossover moment.', likes: 3 },
  });
  await prisma.topicComment.create({
    data: { topicId: topic3.id, userId: adminUser.id, content: 'Kabza De Small has been on a roll this year. His production style keeps evolving.', likes: 6 },
  });

  // Update comment counts
  await prisma.topic.update({ where: { id: topic1.id }, data: { commentCount: 2 } });
  await prisma.topic.update({ where: { id: topic2.id }, data: { commentCount: 2 } });
  await prisma.topic.update({ where: { id: topic3.id }, data: { commentCount: 1 } });

  // Update forum category topic counts
  if (forumCategories[0]) {
    await prisma.forumCategory.update({ where: { id: forumCategories[0].id }, data: { topicCount: 1 } });
  }
  if (forumCategories[1]) {
    await prisma.forumCategory.update({ where: { id: forumCategories[1].id }, data: { topicCount: 2 } });
  }
  if (forumCategories[6]) {
    await prisma.forumCategory.update({ where: { id: forumCategories[6].id }, data: { topicCount: 1 } });
  }

  console.log('  ✅ 5 comments created');

  // ── Translations ──
  console.log('  Creating translations...');
  const translationSongs = songs.slice(0, 10);
  for (const entry of translationSongs) {
    const translation = await prisma.translation.create({
      data: {
        songId: entry.id, userId: regularUser.id,
        originalLyrics: `Original excerpt for "${entry.title}"`,
        translatedLyrics: `Translated excerpt for "${entry.title}" in French for demo purposes.`,
        culturalContext: `Context note: "${entry.title}" includes slang common in West African pop music scenes.`,
        sourceLang: 'en', targetLang: 'fr',
        status: TranslationStatus.PUBLISHED,
        aiModel: 'gpt-5.3-codex', promptVersion: 'v1.0',
      },
    });

    await prisma.translationVote.createMany({
      data: [
        { translationId: translation.id, userId: adminUser.id, voteType: VoteType.UPVOTE },
        { translationId: translation.id, userId: regularUser.id, voteType: VoteType.UPVOTE },
      ],
    });

    await prisma.translationCorrection.create({
      data: {
        translationId: translation.id, userId: adminUser.id,
        originalText: 'demo phrase', suggestedText: 'improved demo phrase',
        reason: 'Better cultural nuance', status: CorrectionStatus.APPROVED,
      },
    });
  }
  console.log(`  ✅ ${translationSongs.length} translations + votes + corrections created`);

  // ── Song Requests ──
  console.log('  Creating song requests...');
  await prisma.songRequest.createMany({
    data: [
      { songTitle: 'Ozeba', artist: 'Rema', userId: regularUser.id, status: RequestStatus.IN_REVIEW, notes: 'Popular club request from Lagos users.' },
      { songTitle: 'Active', artist: 'Asake', userId: regularUser.id, status: RequestStatus.PENDING, notes: 'Need Yoruba to English translation support.' },
    ],
  });
  console.log('  ✅ 2 song requests created');

  // ── Notifications ──
  await prisma.notification.createMany({
    data: [
      { userId: regularUser.id, title: 'Your translation was published', message: 'A moderator approved your translation contribution.', type: NotificationType.TRANSLATION, read: false },
      { userId: regularUser.id, title: 'New comment on your topic', message: 'A moderator replied with additional cultural context.', type: NotificationType.COMMENT, read: false },
    ],
  });

  // ── Badges ──
  await prisma.userBadge.createMany({
    data: [
      { userId: regularUser.id, badgeType: BadgeType.CULTURE_CURATOR },
      { userId: adminUser.id, badgeType: BadgeType.COMMUNITY_HELPER },
    ],
  });

  // ── Token Rewards ──
  await prisma.tokenReward.createMany({
    data: [
      { userId: regularUser.id, amount: 100, reason: 'Published translation contribution' },
      { userId: regularUser.id, amount: 25, reason: 'Helpful forum participation' },
    ],
  });

  // ── Artist Application ──
  const artistUser = users.find(u => u.role === 'ARTIST');
  if (artistUser) {
    await prisma.artistApplication.create({
      data: {
        userId: artistUser.id, stageName: 'Featured Artist', genre: 'Afrobeats',
        bio: 'Independent artist requesting verified artist profile.',
        socialLinks: { instagram: 'https://instagram.com/featuredartist', tiktok: 'https://tiktok.com/@featuredartist', youtube: 'https://youtube.com/@featuredartist' },
        status: ArtistApplicationStatus.UNDER_REVIEW,
      },
    });
  }

  console.log('  ✅ Notifications, badges, token rewards, artist application created');

  // ── Summary ──
  const finalTopics = await prisma.topic.count();
  const finalComments = await prisma.topicComment.count();
  const finalTranslations = await prisma.translation.count();
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Community Data Complete:`);
  console.log(`  Topics:      ${finalTopics}`);
  console.log(`  Comments:    ${finalComments}`);
  console.log(`  Translations: ${finalTranslations}`);
  console.log(`═══════════════════════════════════════════════════════════`);

  await prisma.$disconnect();
  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
