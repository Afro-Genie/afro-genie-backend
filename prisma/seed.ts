import 'dotenv/config';
import { Redis } from 'ioredis';
import {
  ArtistApplicationStatus,
  BadgeType,
  CorrectionStatus,
  LicenseStatus,
  NotificationType,
  PrismaClient,
  RequestStatus,
  TopicCategory,
  TranslationStatus,
  UserRole,
  VoteType
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { seedGtBundles } from './seedGtBundles';
import { seedChallenges } from './seed-challenges';
import { seedStoreItems } from './seedStore';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter
});

const languageSeed = [
  { code: 'en', name: 'English', isActive: true },
  { code: 'pcm', name: 'Nigerian Pidgin', isActive: true },
  { code: 'yo', name: 'Yoruba', isActive: true },
  { code: 'ig', name: 'Igbo', isActive: true },
  { code: 'ha', name: 'Hausa', isActive: true },
  { code: 'sw', name: 'Swahili', isActive: true },
  { code: 'fr', name: 'French', isActive: true },
  { code: 'pt', name: 'Portuguese', isActive: false }
];

const genreSeed = [
  { name: 'Afrobeat', imageUrl: '' },
  { name: 'Afrobeats', imageUrl: '' },
  { name: 'Afropop', imageUrl: '' },
  { name: 'Afro-fusion', imageUrl: '' },
  { name: 'Afro-R&B', imageUrl: '' },
  { name: 'African Hip-Hop', imageUrl: '' },
  { name: 'Amapiano', imageUrl: '' },
  { name: 'Highlife', imageUrl: '' },
  { name: 'Banku', imageUrl: '' },
  { name: 'Dancehall', imageUrl: '' },
  { name: 'Fuji', imageUrl: '' },
  { name: 'Juju', imageUrl: '' },
  { name: 'Bongo Flava', imageUrl: '' },
  { name: 'Gengetone', imageUrl: '' },
  { name: 'Gqom', imageUrl: '' },
  { name: 'Coupé-Décalé', imageUrl: '' },
  { name: 'Kizomba', imageUrl: '' },
  { name: 'Kuduro', imageUrl: '' },
  { name: 'Kwaito', imageUrl: '' },
  { name: 'Makossa', imageUrl: '' },
  { name: 'Mbalax', imageUrl: '' },
  { name: 'Ndombolo', imageUrl: '' },
  { name: 'Soukous', imageUrl: '' },
  { name: 'Taarab', imageUrl: '' },
];

const forumCategorySeed = [
  { name: 'Translation Help', description: 'Ask for lyric meaning and translation support', icon: 'book-open', order: 1 },
  { name: 'Song Deep Dives', description: 'Discuss themes, slang, and context by song', icon: 'music-note', order: 2 },
  { name: 'Artist Lounge', description: 'Talk about artists, releases, and interviews', icon: 'user-group', order: 3 },
  { name: 'Community News', description: 'Platform announcements and updates', icon: 'megaphone', order: 4 },
  { name: 'Afrobeats', description: 'Discuss Afrobeats music, artists, and trends', icon: 'music', order: 5 },
  { name: 'Highlife', description: 'Discuss Highlife music, artists, and trends', icon: 'music', order: 6 },
  { name: 'Amapiano', description: 'Discuss Amapiano music, artists, and trends', icon: 'music', order: 7 },
  { name: 'Naija Pop', description: 'Discuss Naija Pop music, artists, and trends', icon: 'music', order: 8 },
  { name: 'Afro-Fusion', description: 'Discuss Afro-Fusion music, artists, and trends', icon: 'music', order: 9 },
  { name: 'Juju Music', description: 'Discuss Juju Music, artists, and trends', icon: 'music', order: 10 },
  { name: 'Fuji', description: 'Discuss Fuji music, artists, and trends', icon: 'music', order: 11 }
];

// ─── Main Seed ───────────────────────────────────────────────────────────────

async function main() {
  const [
    existingSongCount,
    existingArtistCount,
    existingUserCount,
    existingAlbumCount,
    existingGenreCount,
    existingLanguageCount,
    existingForumCategoryCount,
  ] = await Promise.all([
    prisma.song.count(),
    prisma.artist.count(),
    prisma.user.count(),
    prisma.album.count(),
    prisma.genre.count(),
    prisma.language.count(),
    prisma.forumCategory.count(),
  ]);
  const isIdempotentRun = [
    existingSongCount,
    existingArtistCount,
    existingUserCount,
    existingAlbumCount,
    existingGenreCount,
    existingLanguageCount,
    existingForumCategoryCount,
  ].some(count => count > 0);

  if (isIdempotentRun) {
    console.log(
      `\n📊 Existing data found (${existingSongCount} songs, ${existingArtistCount} artists, ` +
      `${existingUserCount} users, ${existingAlbumCount} albums, ${existingGenreCount} genres, ` +
      `${existingLanguageCount} languages, ${existingForumCategoryCount} forum categories).`,
    );
    console.log('   General bootstrap seed skipped to preserve existing records.\n');
  } else {
    console.log('\n🆕 Empty DB detected — running general bootstrap seed...\n');

    // ── Users ──
    const users = await Promise.all([
      prisma.user.create({
        data: {
          email: 'admin@afrogenie.com',
          passwordHash: 'seeded_admin_hash',
          displayName: 'Afro Genie Admin',
          role: UserRole.ADMIN,
          lastLoginAt: new Date()
        }
      }),
      prisma.user.create({
        data: {
          email: 'moderator@afrogenie.com',
          passwordHash: 'seeded_moderator_hash',
          displayName: 'Afro Genie Mod',
          role: UserRole.MODERATOR,
          lastLoginAt: new Date()
        }
      }),
      prisma.user.create({
        data: {
          email: 'artist@afrogenie.com',
          passwordHash: 'seeded_artist_hash',
          displayName: 'Featured Artist',
          role: UserRole.ARTIST,
          lastLoginAt: new Date()
        }
      }),
      prisma.user.create({
        data: {
          email: 'user@afrogenie.com',
          passwordHash: 'seeded_user_hash',
          displayName: 'Community Member',
          role: UserRole.USER,
          lastLoginAt: new Date()
        }
      })
    ]);

    const adminUser = users[0];
    const regularUser = users[3];

    // ── Languages & Genres ──
    await prisma.language.createMany({ data: languageSeed });
    await prisma.genre.createMany({ data: genreSeed });

    // ── Forum Categories ──
    const createdForumCategories = await Promise.all(
      forumCategorySeed.map((item) =>
        prisma.forumCategory.create({
          data: { ...item, topicCount: 0 }
        })
      )
    );

    // ── Community Data ──
    const dbSongs = await prisma.song.findMany({
      take: 16,
      orderBy: { createdAt: 'asc' },
      select: { id: true, title: true },
    });

    if (dbSongs.length >= 2) {
      const topic1 = await prisma.topic.create({
        data: {
          title: `What does "${dbSongs[0].title}" really mean in context?`,
          content: 'I understand the literal translation, but what is the emotional framing in Nigerian Pidgin?',
          authorId: regularUser.id,
          category: TopicCategory.TRANSLATION,
          forumCategoryId: createdForumCategories[0]?.id,
          songId: dbSongs[0].id,
          likes: 12, shares: 3, commentCount: 0, isPinned: true
        }
      });

      const topic2 = await prisma.topic.create({
        data: {
          title: 'Afrobeats hooks that changed global pop',
          content: 'Share songs that made non-African audiences pick up African slang and rhythm patterns.',
          authorId: adminUser.id,
          category: TopicCategory.SONG_DISCUSSION,
          forumCategoryId: createdForumCategories[1]?.id,
          likes: 20, shares: 6, commentCount: 0, isPinned: false
        }
      });

      const topLevelComment = await prisma.topicComment.create({
        data: { topicId: topic1.id, userId: adminUser.id, content: 'In this context, it carries resignation after emotional investment.', likes: 5 }
      });
      await prisma.topicComment.create({
        data: { topicId: topic1.id, userId: regularUser.id, parentCommentId: topLevelComment.id, content: 'That makes sense. I hear that tone in the chorus delivery.', likes: 2 }
      });
      await prisma.topicComment.create({
        data: { topicId: topic2.id, userId: regularUser.id, content: 'Essence is still a perfect entry point for many listeners.', likes: 4 }
      });

      await prisma.topic.update({ where: { id: topic1.id }, data: { commentCount: 2 } });
      await prisma.topic.update({ where: { id: topic2.id }, data: { commentCount: 1 } });
      await prisma.forumCategory.update({ where: { id: createdForumCategories[0].id }, data: { topicCount: 1 } });
      await prisma.forumCategory.update({ where: { id: createdForumCategories[1].id }, data: { topicCount: 1 } });
    }

    const translationSongs = dbSongs.slice(0, 10);
    for (const entry of translationSongs) {
      const translation = await prisma.translation.create({
        data: {
          songId: entry.id, userId: regularUser.id,
          originalLyrics: `Original excerpt for ${entry.title}`,
          translatedLyrics: `Translated excerpt for ${entry.title} in French for demo purposes.`,
          culturalContext: `Context note: ${entry.title} includes slang common in West African pop music scenes.`,
          sourceLang: 'en', targetLang: 'fr', status: TranslationStatus.PUBLISHED,
          aiModel: 'gpt-5.3-codex', promptVersion: 'v1.0'
        }
      });
      await prisma.translationVote.createMany({
        data: [
          { translationId: translation.id, userId: adminUser.id, voteType: VoteType.UPVOTE },
          { translationId: translation.id, userId: regularUser.id, voteType: VoteType.UPVOTE }
        ]
      });
      await prisma.translationCorrection.create({
        data: {
          translationId: translation.id, userId: adminUser.id,
          originalText: 'demo phrase', suggestedText: 'improved demo phrase',
          reason: 'Better cultural nuance', status: CorrectionStatus.APPROVED
        }
      });
    }

    if (dbSongs.length > 0) {
      await prisma.songRequest.createMany({
        data: [
          { songTitle: 'Ozeba', artist: 'Rema', userId: regularUser.id, status: RequestStatus.IN_REVIEW, notes: 'Popular club request from Lagos users.' },
          { songTitle: 'Active', artist: 'Asake', userId: regularUser.id, status: RequestStatus.PENDING, notes: 'Need Yoruba to English translation support.' }
        ]
      });
    }

    await prisma.notification.createMany({
      data: [
        { userId: regularUser.id, title: 'Your translation was published', message: 'A moderator approved your translation contribution.', type: NotificationType.TRANSLATION, read: false },
        { userId: regularUser.id, title: 'New comment on your topic', message: 'A moderator replied with additional cultural context.', type: NotificationType.COMMENT, read: false }
      ]
    });

    await prisma.userBadge.createMany({
      data: [
        { userId: regularUser.id, badgeType: BadgeType.CULTURE_CURATOR },
        { userId: adminUser.id, badgeType: BadgeType.COMMUNITY_HELPER }
      ]
    });

    await prisma.tokenReward.createMany({
      data: [
        { userId: regularUser.id, amount: 100, reason: 'Published translation contribution' },
        { userId: regularUser.id, amount: 25, reason: 'Helpful forum participation' }
      ]
    });

    await prisma.artistApplication.create({
      data: {
        userId: users[2].id, stageName: 'Featured Artist', genre: 'Afrobeats',
        bio: 'Independent artist requesting verified artist profile.',
        socialLinks: { instagram: 'https://instagram.com/featuredartist', tiktok: 'https://tiktok.com/@featuredartist', youtube: 'https://youtube.com/@featuredartist' },
        status: ArtistApplicationStatus.UNDER_REVIEW
      }
    });
  }

  // Song catalog imports run separately through the YouTube Data API seeder.
  console.log('\n🎵 Song catalog seeding is separate; use the YouTube catalog seed commands.');
  await prisma.tokenLedger.createMany({
    data: [
      {
        userId: regularUser.id,
        type: 'EARN',
        amount: 100,
        balanceAfter: 100,
        reason: 'Published translation contribution',
        sourceType: 'LEGACY',
        idempotencyKey: 'legacy:seed-demo-1',
      },
      {
        userId: regularUser.id,
        type: 'EARN',
        amount: 25,
        balanceAfter: 125,
        reason: 'Helpful forum participation',
        sourceType: 'LEGACY',
        idempotencyKey: 'legacy:seed-demo-2',
      },
    ],
    skipDuplicates: true,
  });

  // ── Token economy (Phase 1) ──────────────────────────────────
  // Create wallets for every user and seed tier/streak rows. The legacy
  // TokenReward table was retired in Phase 4; demo balances are seeded
  // directly into the TokenLedger above (idempotent via legacy keys).
  const allUsers = await prisma.user.findMany({ select: { id: true } });
  await prisma.userWallet.createMany({
    data: allUsers.map((u) => ({ userId: u.id })),
    skipDuplicates: true,
  });
  await prisma.userTier.createMany({
    data: allUsers.map((u) => ({ userId: u.id })),
    skipDuplicates: true,
  });
  await prisma.userStreak.createMany({
    data: allUsers.map((u) => ({ userId: u.id })),
    skipDuplicates: true,
  });

  // Keep the seeded demo wallet balance in sync with its ledger rows.
  const demoBalance = await prisma.tokenLedger.aggregate({
    where: { userId: regularUser.id },
    _sum: { amount: true },
  });
  await prisma.userWallet.update({
    where: { userId: regularUser.id },
    data: { balance: demoBalance._sum.amount ?? 0 },
  });

  // ── Store (Phase 3) ─────────────────────────────────────────
  // Digital avatar-border / title perks auto-grant a UserEntitlement on
  // purchase; the signed poster is a manual-fulfillment prize. Idempotent:
  // existing items are updated in place rather than duplicated. Shared with
  // the standalone `npm run seed:store` via prisma/seedStore.ts.
  const storeItemsResult = await seedStoreItems(prisma);

  // ── GT bundles (Phase 2) ────────────────────────────────────
  const gtBundleResult = await seedGtBundles(prisma);

  // ── Challenges (weekly templates) ───────────────────────────
  const challengeResult = await seedChallenges(prisma);

  // ── Summary ──
  const finalSongCount = await prisma.song.count();
  const finalArtistCount = await prisma.artist.count();
  const finalAlbumCount = await prisma.album.count();
  console.log('\n✅ Seed complete:');
  console.log(`   Songs: ${finalSongCount}`);
  console.log(`   Artists: ${finalArtistCount}`);
  console.log(`   Albums: ${finalAlbumCount}`);
  console.log(`   Languages: ${languageSeed.length}`);
  console.log(`   Genres: ${genreSeed.length}`);
  console.log(`   GT bundles: ${gtBundleResult.created} created, ${gtBundleResult.updated} updated`);
  console.log(`   Store items: ${storeItemsResult.created} created, ${storeItemsResult.updated} updated`);
  console.log(`   Challenges: ${challengeResult.upserted} upserted, ${challengeResult.deactivated} expired deactivated`);
}

main()
  .then(async () => {
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      const redis = new Redis(redisUrl);
      try {
        const patterns = ['catalog:homepage:v*'];
        for (const pattern of patterns) {
          const keys = await redis.keys(pattern);
          if (keys.length > 0) {
            await redis.del(...keys);
            console.log(`Cache cleared: ${keys.length} keys matching "${pattern}"`);
          }
        }
      } catch (err) {
        console.warn('Cache invalidation skipped (Redis unavailable):', (err as Error).message);
      } finally {
        await redis.quit();
      }
    } else {
      console.log('No REDIS_URL set — cache invalidation skipped');
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
