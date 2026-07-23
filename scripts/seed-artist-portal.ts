import 'dotenv/config';
import { PrismaClient, ReleaseType, ReleaseStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── Sample Artist Profiles ──────────────────────────────────────────────────

interface ArtistSeed {
  name: string;
  bio: string;
  profileImageUrl: string;
  bannerImageUrl: string;
  socialLinks: Record<string, string>;
  spotifyArtistId: string;
  genres: string[];
  verified: boolean;
  isFeatured: boolean;
  releases: {
    title: string;
    type: ReleaseType;
    coverImageUrl: string;
    daysFromNow: number; // negative = past, positive = future
    status: ReleaseStatus;
    tracks: { title: string; trackNumber: number }[];
  }[];
}

const SAMPLE_ARTISTS: ArtistSeed[] = [
  {
    name: 'Amara Lights',
    bio: 'Nigerian-born Afrobeats singer-songwriter blending highlife guitar riffs with modern electronic production. Known for emotionally charged vocals and pan-African storytelling.',
    profileImageUrl: 'https://i.scdn.co/image/ab6761610000e5eb6a224073987b930f1c3e7e43',
    bannerImageUrl: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=1200',
    socialLinks: {
      instagram: 'https://instagram.com/amaralights',
      twitter: 'https://twitter.com/amaralights',
      youtube: 'https://youtube.com/@amaralights',
      tiktok: 'https://tiktok.com/@amaralights',
      website: 'https://amaralights.com',
    },
    spotifyArtistId: '0eDvMst7XKl3YSavwBKJkK',
    genres: ['Afrobeats', 'Afro Fusion', 'Highlife'],
    verified: true,
    isFeatured: true,
    releases: [
      {
        title: 'Golden Hour',
        type: ReleaseType.SINGLE,
        coverImageUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400',
        daysFromNow: -30,
        status: ReleaseStatus.PUBLISHED,
        tracks: [{ title: 'Golden Hour', trackNumber: 1 }],
      },
      {
        title: 'Rhythms of Home',
        type: ReleaseType.EP,
        coverImageUrl: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400',
        daysFromNow: 14,
        status: ReleaseStatus.SCHEDULED,
        tracks: [
          { title: 'Rhythms of Home', trackNumber: 1 },
          { title: 'Lagos Nights', trackNumber: 2 },
          { title: 'Motherland Call', trackNumber: 3 },
          { title: 'Sunrise on the Lagoon', trackNumber: 4 },
        ],
      },
    ],
  },
  {
    name: 'Kofi Blaze',
    bio: 'Ghanaian Amapiano disruptor fusing log drums with hilife melodies. His tracks dominate club playlists across West Africa and the diaspora.',
    profileImageUrl: 'https://i.scdn.co/image/ab6761610000e5ebc6b4e0fcf2997a8b98d5f24f',
    bannerImageUrl: 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=1200',
    socialLinks: {
      instagram: 'https://instagram.com/kblaze',
      twitter: 'https://twitter.com/kblaze',
      website: 'https://kofiblaze.com',
    },
    spotifyArtistId: '1Xyo4u8uXC1ZmMpatF05PJ',
    genres: ['Amapiano', 'Afrobeats', 'Dancehall'],
    verified: true,
    isFeatured: true,
    releases: [
      {
        title: 'Piano to the World',
        type: ReleaseType.ALBUM,
        coverImageUrl: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=400',
        daysFromNow: -60,
        status: ReleaseStatus.PUBLISHED,
        tracks: [
          { title: 'Piano to the World', trackNumber: 1 },
          { title: 'Log Drum Symphony', trackNumber: 2 },
          { title: 'Accra Heat', trackNumber: 3 },
          { title: 'Basement Groove', trackNumber: 4 },
          { title: 'Midnight Shaker', trackNumber: 5 },
        ],
      },
      {
        title: 'Fire & Bass',
        type: ReleaseType.SINGLE,
        coverImageUrl: 'https://images.unsplash.com/photo-1571330735066-03aaa9429d89?w=400',
        daysFromNow: -7,
        status: ReleaseStatus.PUBLISHED,
        tracks: [{ title: 'Fire & Bass', trackNumber: 1 }],
      },
    ],
  },
  {
    name: 'Zuri Waves',
    bio: 'East African Afro-R&B vocalist from Nairobi. Her ethereal voice layered over bongo flava and amapiano production has earned her a loyal global fanbase.',
    profileImageUrl: 'https://i.scdn.co/image/ab6761610000e5ebe6b46d5e8b0f7b0a4e5c8d2a',
    bannerImageUrl: 'https://images.unsplash.com/photo-1514320291840-2e0a9bf2a9ae?w=1200',
    socialLinks: {
      instagram: 'https://instagram.com/zuriwaves',
      twitter: 'https://twitter.com/zuriwaves',
      youtube: 'https://youtube.com/@zuriwaves',
    },
    spotifyArtistId: '4cOdK2wGhgzRfEJKFIRFES',
    genres: ['Afro R&B', 'Bongo Flava', 'Afropop'],
    verified: true,
    isFeatured: false,
    releases: [
      {
        title: 'Tidal',
        type: ReleaseType.EP,
        coverImageUrl: 'https://images.unsplash.com/photo-1516223725307-6f76b9182f7c?w=400',
        daysFromNow: -45,
        status: ReleaseStatus.PUBLISHED,
        tracks: [
          { title: 'Tidal', trackNumber: 1 },
          { title: 'Nairobi Rain', trackNumber: 2 },
          { title: 'Coastal Dreams', trackNumber: 3 },
        ],
      },
      {
        title: 'Moonlit',
        type: ReleaseType.SINGLE,
        coverImageUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400',
        daysFromNow: -14,
        status: ReleaseStatus.PUBLISHED,
        tracks: [{ title: 'Moonlit', trackNumber: 1 }],
      },
    ],
  },
  {
    name: 'King Soleil',
    bio: 'Cameroonian producer-DJ blending makossa basslines with futuristic electronic beats. Three-time AFRIMA nominee and festival headliner.',
    profileImageUrl: 'https://i.scdn.co/image/ab6761610000e5eb3b6e4b5e8c0f7b0a4e5c8d2a',
    bannerImageUrl: 'https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?w=1200',
    socialLinks: {
      instagram: 'https://instagram.com/kingsoliel',
      twitter: 'https://twitter.com/kingsoliel',
      tiktok: 'https://tiktok.com/@kingsoliel',
      website: 'https://kingsoliel.com',
    },
    spotifyArtistId: '6eUKZXaKkcviH0Ku9w2n3V',
    genres: ['Afro Electronic', 'Makossa', 'Afrobeats'],
    verified: true,
    isFeatured: true,
    releases: [
      {
        title: 'Solar System',
        type: ReleaseType.ALBUM,
        coverImageUrl: 'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=400',
        daysFromNow: -90,
        status: ReleaseStatus.PUBLISHED,
        tracks: [
          { title: 'Solar System', trackNumber: 1 },
          { title: 'Equatorial Groove', trackNumber: 2 },
          { title: 'Douala Sunrise', trackNumber: 3 },
          { title: 'Neon Makossa', trackNumber: 4 },
          { title: 'Orbit', trackNumber: 5 },
          { title: 'Gravity Pull', trackNumber: 6 },
        ],
      },
      {
        title: 'Supernova',
        type: ReleaseType.SINGLE,
        coverImageUrl: 'https://images.unsplash.com/photo-1571330735066-03aaa9429d89?w=400',
        daysFromNow: 30,
        status: ReleaseStatus.DRAFT,
        tracks: [{ title: 'Supernova', trackNumber: 1 }],
      },
    ],
  },
  {
    name: 'Nia Soul',
    bio: 'South African songbird rooted in Afro-soul and jazz. Her debut album earned critical acclaim for its raw vulnerability and sonic richness.',
    profileImageUrl: 'https://i.scdn.co/image/ab6761610000e5ebb7e8e80c8b0f7b0a4e5c8d2a',
    bannerImageUrl: 'https://images.unsplash.com/photo-1511192336575-5a79af67a629?w=1200',
    socialLinks: {
      instagram: 'https://instagram.com/niasoul',
      youtube: 'https://youtube.com/@niasoul',
    },
    spotifyArtistId: '23EAwjA3KoEbgKMnQ2uVwn',
    genres: ['Afro Soul', 'Jazz', 'Afropop'],
    verified: true,
    isFeatured: false,
    releases: [
      {
        title: 'Rooted',
        type: ReleaseType.ALBUM,
        coverImageUrl: 'https://images.unsplash.com/photo-1514320291840-2e0a9bf2a9ae?w=400',
        daysFromNow: -120,
        status: ReleaseStatus.PUBLISHED,
        tracks: [
          { title: 'Rooted', trackNumber: 1 },
          { title: 'Soil & Soul', trackNumber: 2 },
          { title: 'Johannesburg Blues', trackNumber: 3 },
          { title: 'Mama\'s Lullaby', trackNumber: 4 },
        ],
      },
    ],
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Seed Function ───────────────────────────────────────────────────────────

async function seedArtistPortalData() {
  console.log('\n🎨 Seeding artist portal data (verified artists, releases, analytics)...\n');

  // Find existing users with ARTIST role to link
  const artistUsers = await prisma.user.findMany({
    where: { role: 'ARTIST' },
    select: { id: true, displayName: true },
  });

  let userIndex = 0;

  for (const artistData of SAMPLE_ARTISTS) {
    console.log(`  Creating artist: ${artistData.name}...`);

    // Link to existing ARTIST user if available, otherwise create a dedicated user
    let userId: string | null = null;
    if (userIndex < artistUsers.length) {
      userId = artistUsers[userIndex].id;
      userIndex++;
    } else {
      const newUser = await prisma.user.create({
        data: {
          email: `${artistData.name.toLowerCase().replace(/\s+/g, '.')}@afrogenie.com`,
          passwordHash: 'seeded_artist_portal_hash',
          displayName: artistData.name,
          role: 'ARTIST',
          lastLoginAt: new Date(),
        },
      });
      userId = newUser.id;
    }

    // Upsert artist by name
    const artist = await prisma.artist.upsert({
      where: { name: artistData.name },
      update: {
        userId,
        bio: artistData.bio,
        profileImageUrl: artistData.profileImageUrl,
        bannerImageUrl: artistData.bannerImageUrl,
        socialLinks: artistData.socialLinks,
        spotifyArtistId: artistData.spotifyArtistId,
        verified: artistData.verified,
        isFeatured: artistData.isFeatured,
        genres: artistData.genres,
      },
      create: {
        name: artistData.name,
        userId,
        bio: artistData.bio,
        profileImageUrl: artistData.profileImageUrl,
        bannerImageUrl: artistData.bannerImageUrl,
        socialLinks: artistData.socialLinks,
        spotifyArtistId: artistData.spotifyArtistId,
        genres: artistData.genres,
        verified: artistData.verified,
        isFeatured: artistData.isFeatured,
        popularity: randomInt(40, 90),
        followers: randomInt(10000, 500000),
      },
    });

    // Create releases
    for (const releaseData of artistData.releases) {
      const release = await prisma.release.create({
        data: {
          artistId: artist.id,
          title: releaseData.title,
          type: releaseData.type,
          coverImageUrl: releaseData.coverImageUrl,
          releaseDate: daysAgo(releaseData.daysFromNow),
          status: releaseData.status,
        },
      });

      console.log(`    Release: ${release.title} (${releaseData.type}, ${releaseData.status})`);

      // Create songs linked to this release
      for (const track of releaseData.tracks) {
        const songTitle = `${track.title} - ${artistData.name}`;
        const existingSong = await prisma.song.findFirst({
          where: { title: track.title, artistId: artist.id },
        });

        if (!existingSong) {
          await prisma.song.create({
            data: {
              title: track.title,
              artistId: artist.id,
              releaseId: release.id,
              trackNumber: track.trackNumber,
              imageUrl: releaseData.coverImageUrl,
              views: randomInt(100, 50000),
              requestCount: randomInt(5, 200),
              releaseYear: release.releaseDate.getFullYear(),
            },
          });
        } else {
          // Link existing song to release
          await prisma.song.update({
            where: { id: existingSong.id },
            data: { releaseId: release.id, trackNumber: track.trackNumber },
          });
        }
      }
    }

    // Generate 30 days of analytics backfill
    const analyticsData: {
      artistId: string;
      date: Date;
      plays: number;
      translationViews: number;
      uniqueListeners: number;
    }[] = [];

    for (let i = 29; i >= 0; i--) {
      const date = daysAgo(i);
      // Simulate growth trend with some randomness
      const basePlays = randomInt(200, 2000);
      const growthFactor = 1 + (30 - i) * 0.02;
      analyticsData.push({
        artistId: artist.id,
        date,
        plays: Math.round(basePlays * growthFactor),
        translationViews: randomInt(10, 200),
        uniqueListeners: randomInt(50, 800),
      });
    }

    await prisma.artistAnalyticsDaily.createMany({
      data: analyticsData,
      skipDuplicates: true,
    });

    console.log(`    Analytics: 30 days backfilled`);

    // Create sample notifications
    const notificationMessages = [
      { type: 'PLAY_MILESTONE', message: `Your song reached ${randomInt(1000, 10000)} plays this week!` },
      { type: 'TRANSLATION_REQUEST', message: 'A fan requested a translation for one of your songs.' },
      { type: 'FEATURED', message: artistData.isFeatured ? 'Congratulations! You have been featured on the homepage.' : 'Keep releasing great music to get featured!' },
      { type: 'NEW_FOLLOWER', message: `You gained ${randomInt(10, 100)} new followers today.` },
    ];

    await prisma.artistNotification.createMany({
      data: notificationMessages.map((n) => ({
        artistId: artist.id,
        type: n.type,
        message: n.message,
        isRead: Math.random() > 0.5,
      })),
    });

    console.log(`    Notifications: ${notificationMessages.length} created`);
  }

  // Summary
  const totalArtists = await prisma.artist.count({ where: { verified: true } });
  const totalReleases = await prisma.release.count();
  const totalAnalytics = await prisma.artistAnalyticsDaily.count();
  const totalNotifications = await prisma.artistNotification.count();

  console.log('\n✅ Artist portal seed complete:');
  console.log(`   Verified Artists: ${totalArtists}`);
  console.log(`   Releases: ${totalReleases}`);
  console.log(`   Analytics Rows: ${totalAnalytics}`);
  console.log(`   Notifications: ${totalNotifications}`);
}

seedArtistPortalData()
  .catch((error) => {
    console.error('Artist portal seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
