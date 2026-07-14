import 'dotenv/config';
import { Redis } from 'ioredis';
import {
  ArtistApplicationStatus,
  BadgeType,
  CorrectionStatus,
  LicenseStatus,
  LyricSourceProvider,
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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter
});

const SPOTIFY_API = 'https://api.spotify.com/v1';

// ─── Spotify Auth (Client Credentials) ───────────────────────────────────────

let currentToken = '';

async function getSpotifyToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set');
  }
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify token error: ${res.status}`);
  const data = await res.json();
  currentToken = data.access_token;
  return currentToken;
}

async function refreshSpotifyToken(): Promise<string> {
  console.log('  ⏳ Refreshing Spotify token...');
  return getSpotifyToken();
}

async function spotifyFetch(url: string): Promise<Response> {
  let res = await fetch(url, { headers: { Authorization: `Bearer ${currentToken}` } });
  if (res.status === 401) {
    await refreshSpotifyToken();
    res = await fetch(url, { headers: { Authorization: `Bearer ${currentToken}` } });
  }
  return res;
}

// ─── Search Queries (Client Credentials can't access playlists) ────────────────

const SEARCH_QUERIES = [
  'afrobeats',
  'amapiano',
  'afropop',
  'nigerian music',
  'african music',
  'afro fusion',
  'highlife',
  'bongo flava',
  'gengetone',
  'afro r&b',
  'dancehall africa',
  'naija hits',
  'burna boy',
  'wizkid',
  'davido',
  'tems',
  'asake',
  'rema',
  'fireboy dml',
  'ayra starr',
  'black sherif',
  'tiwa savage',
  'sauti sol',
  'sarkodie',
  'diamond platnumz',
];

// ─── Seed Data ───────────────────────────────────────────────────────────────

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
  { name: 'Afrobeats', imageUrl: '' },
  { name: 'Afropop', imageUrl: '' },
  { name: 'Afro-fusion', imageUrl: '' },
  { name: 'Amapiano', imageUrl: '' },
  { name: 'Alt-R&B', imageUrl: '' },
  { name: 'R&B', imageUrl: '' },
  { name: 'Highlife', imageUrl: '' },
  { name: 'Banku', imageUrl: '' },
  { name: 'Dancehall', imageUrl: '' },
  { name: 'Hip-Hop', imageUrl: '' }
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

// ─── Spotify Seeding Functions ───────────────────────────────────────────────

interface TrackData {
  track: any;
  artistId: string;
  artistName: string;
  artistSpotifyId: string;
  albumId: string | null;
  albumName: string | null;
  albumSpotifyId: string | null;
  albumImage: string | null;
  albumYear: number | null;
}

async function fetchTracksFromSpotify(
  queries: string[],
  limitPerQuery: number = 30,
): Promise<TrackData[]> {
  const seenTrackIds = new Set<string>();
  const artistIdsSeen = new Set<string>();
  const albumIdsSeen = new Set<string>();
  const allTracks: TrackData[] = [];

  for (const query of queries) {
    console.log(`  Searching: "${query}"`);
    let offset = 0;
    let querySongs = 0;

    while (querySongs < limitPerQuery) {
      const limit = 10;
      const url = `${SPOTIFY_API}/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}&offset=${offset}`;
      let res: Response;
      try {
        res = await spotifyFetch(url);
      } catch (err) {
        console.warn(`  Network error for "${query}" at offset ${offset}, retrying in 2s`);
        await new Promise((r) => setTimeout(r, 2000));
        try {
          res = await spotifyFetch(url);
        } catch {
          break;
        }
      }
      if (!res.ok) {
        const errBody = await res.text();
        console.warn(`  Failed "${query}" at offset ${offset}: ${res.status} — ${errBody.substring(0, 200)}`);
        break;
      }
      const data = await res.json();
      const tracks = data?.tracks?.items || [];
      if (!tracks.length) break;

      for (const track of tracks) {
        if (!track?.id || seenTrackIds.has(track.id) || !track.artists?.[0]) continue;
        seenTrackIds.add(track.id);

        const primaryArtist = track.artists[0];
        const albumData = track.album;

        allTracks.push({
          track,
          artistId: primaryArtist.id,
          artistName: primaryArtist.name,
          artistSpotifyId: primaryArtist.id,
          albumId: albumData?.id || null,
          albumName: albumData?.name || null,
          albumSpotifyId: albumData?.id || null,
          albumImage: albumData?.images?.[0]?.url || null,
          albumYear: albumData?.release_date
            ? parseInt(albumData.release_date.substring(0, 4), 10)
            : null,
        });

        artistIdsSeen.add(primaryArtist.id);
        if (albumData?.id) albumIdsSeen.add(albumData.id);
        querySongs++;
      }

      offset += tracks.length;
      if (tracks.length < limit) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`  Fetched ${allTracks.length} tracks from Spotify (${artistIdsSeen.size} unique artists, ${albumIdsSeen.size} unique albums)`);
  return allTracks;
}

async function bulkInsertToDb(allTracks: TrackData[]): Promise<{ songsCreated: number; artistsCreated: number }> {
  if (!allTracks.length) return { songsCreated: 0, artistsCreated: 0 };

  // ── Phase 1: Collect unique artist IDs and fetch their details from Spotify ──
  const artistMap = new Map<string, { name: string; spotifyId: string }>();
  for (const t of allTracks) {
    if (!artistMap.has(t.artistSpotifyId)) {
      artistMap.set(t.artistSpotifyId, { name: t.artistName, spotifyId: t.artistSpotifyId });
    }
  }
  console.log(`  Fetching details for ${artistMap.size} artists...`);

  const artistDetails = new Map<string, any>();
  const artistEntries = [...artistMap.entries()];
  for (let i = 0; i < artistEntries.length; i++) {
    const [spotifyId, info] = artistEntries[i];
    try {
      const res = await spotifyFetch(`${SPOTIFY_API}/artists/${spotifyId}`);
      artistDetails.set(spotifyId, res.ok ? await res.json() : {});
    } catch {
      artistDetails.set(spotifyId, {});
    }
    if (i % 20 === 0 && i > 0) {
      console.log(`    ...${i}/${artistEntries.length} artists fetched`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // ── Phase 2: Bulk upsert artists ──
  console.log(`  Inserting ${artistMap.size} artists into DB...`);
  let artistsCreated = 0;
  const dbArtistMap = new Map<string, string>(); // spotifyId -> dbId

  let artistCount = 0;
  for (const [spotifyId, info] of artistMap) {
    try {
      const existing = await prisma.artist.findFirst({ where: { spotifyId } });
      if (existing) {
        dbArtistMap.set(spotifyId, existing.id);
      } else {
        const details = artistDetails.get(spotifyId) || {};
        const created = await prisma.artist.create({
          data: {
            name: info.name,
            spotifyId,
            imageUrl: details.images?.[0]?.url || null,
            genres: details.genres || [],
            popularity: details.popularity || 0,
            followers: details.followers?.total || 0,
            verified: false,
          },
        });
        dbArtistMap.set(spotifyId, created.id);
        artistsCreated++;
      }
    } catch (err: any) {
      if (err?.code === 'P1001' || err?.message?.includes('terminated') || err?.message?.includes('ECONNRESET')) {
        console.log(`    DB connection lost at artist ${artistCount}, reconnecting in 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
        try {
          await prisma.$queryRaw`SELECT 1`;
        } catch {
          await new Promise((r) => setTimeout(r, 5000));
        }
        continue;
      }
      throw err;
    }
    artistCount++;
    if (artistCount % 50 === 0) {
      console.log(`    ...${artistCount}/${artistMap.size} artists processed`);
    }
  }
  console.log(`  Artists: ${artistsCreated} created, ${artistMap.size - artistsCreated} existed`);

  // ── Phase 3: Bulk upsert albums ──
  const albumMap = new Map<string, { name: string; spotifyId: string; artistSpotifyId: string; image: string | null; year: number | null }>();
  for (const t of allTracks) {
    if (t.albumSpotifyId && !albumMap.has(t.albumSpotifyId)) {
      albumMap.set(t.albumSpotifyId, {
        name: t.albumName || 'Unknown',
        spotifyId: t.albumSpotifyId,
        artistSpotifyId: t.artistSpotifyId,
        image: t.albumImage,
        year: t.albumYear,
      });
    }
  }
  console.log(`  Inserting ${albumMap.size} albums into DB...`);

  let albumCount = 0;
  const dbAlbumMap = new Map<string, string>(); // spotifyId -> dbId
  for (const [spotifyId, info] of albumMap) {
    try {
      const existing = await prisma.album.findFirst({ where: { spotifyId } });
      if (existing) {
        dbAlbumMap.set(spotifyId, existing.id);
      } else {
        const dbArtistId = dbArtistMap.get(info.artistSpotifyId);
        if (dbArtistId) {
          const created = await prisma.album.create({
            data: {
              name: info.name,
              artistId: dbArtistId,
              spotifyId,
              imageUrl: info.image,
              releaseYear: info.year,
              totalTracks: null,
              popularity: 0,
              genres: [],
            },
          });
          dbAlbumMap.set(spotifyId, created.id);
        }
      }
    } catch (err: any) {
      if (err?.code === 'P1001' || err?.message?.includes('terminated') || err?.message?.includes('ECONNRESET')) {
        console.log(`    DB connection lost at album ${albumCount}, reconnecting in 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
        try {
          await prisma.$queryRaw`SELECT 1`;
        } catch {
          await new Promise((r) => setTimeout(r, 5000));
        }
        continue;
      }
      throw err;
    }
    albumCount++;
    if (albumCount % 50 === 0) {
      console.log(`    ...${albumCount}/${albumMap.size} albums`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ── Phase 4: Bulk upsert songs ──
  console.log(`  Inserting songs into DB...`);
  let songsCreated = 0;
  let songAttempt = 0;

  for (const t of allTracks) {
    songAttempt++;
    try {
      const existingSong = await prisma.song.findUnique({ where: { spotifyId: t.track.id } });
      if (existingSong) continue;

      const dbArtistId = dbArtistMap.get(t.artistSpotifyId);
      if (!dbArtistId) continue;
      const dbAlbumId = t.albumSpotifyId ? dbAlbumMap.get(t.albumSpotifyId) || null : null;

      await prisma.song.create({
        data: {
          title: t.track.name,
          artistId: dbArtistId,
          albumId: dbAlbumId || null,
          albumName: t.albumName || null,
          imageUrl: t.albumImage || null,
          spotifyId: t.track.id,
          spotifyPreviewUrl: t.track.preview_url || null,
          previewAvailable: !!t.track.preview_url,
          durationMs: t.track.duration_ms || null,
          trackNumber: t.track.track_number || null,
          releaseYear: t.albumYear,
          views: Math.floor(Math.random() * 5000),
        },
      });
      songsCreated++;
      if (songsCreated % 50 === 0) {
        console.log(`    ...${songsCreated} songs created (${songAttempt}/${allTracks.length} processed)`);
      }
    } catch (err: any) {
      if (err?.code === 'P2002') {
        continue;
      }
      if (err?.code === 'P1001' || err?.message?.includes('terminated') || err?.message?.includes('ECONNRESET')) {
        console.log(`    DB connection lost at song ${songsCreated}, reconnecting in 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
        try {
          await prisma.$queryRaw`SELECT 1`;
        } catch {
          await new Promise((r) => setTimeout(r, 5000));
        }
        continue;
      }
      throw err;
    }
  }

  console.log(`  Songs: ${songsCreated} created`);
  return { songsCreated, artistsCreated };
}

async function seedFromSpotifySearch(
  queries: string[],
  limitPerQuery: number = 30,
): Promise<{ songsCreated: number; artistsCreated: number }> {
  const allTracks = await fetchTracksFromSpotify(queries, limitPerQuery);
  return bulkInsertToDb(allTracks);
}

// ─── Database Reset ──────────────────────────────────────────────────────────

async function resetSeededData() {
  await prisma.translationVote.deleteMany();
  await prisma.translationCorrection.deleteMany();
  await prisma.translation.deleteMany();
  await prisma.translationRequest.deleteMany();
  await prisma.songRequest.deleteMany();
  await prisma.topicCommentVote.deleteMany();
  await prisma.topicVote.deleteMany();
  await prisma.userCommunityMembership.deleteMany();
  await prisma.topicComment.deleteMany();
  await prisma.topic.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.userBadge.deleteMany();
  await prisma.tokenReward.deleteMany();
  await prisma.artistApplication.deleteMany();
  await prisma.songGenre.deleteMany();
  await prisma.songLanguage.deleteMany();
  await prisma.lyric.deleteMany();
  await prisma.album.deleteMany();
  await prisma.song.deleteMany();
  await prisma.genre.deleteMany();
  await prisma.artist.deleteMany();
  await prisma.forumCategory.deleteMany();
  await prisma.language.deleteMany();
  await prisma.user.deleteMany();
}

// ─── Main Seed ───────────────────────────────────────────────────────────────

async function main() {
  const existingSongCount = await prisma.song.count();
  if (existingSongCount > 50) {
    console.warn(
      `\n⚠️  DB already contains ${existingSongCount} songs (>50 threshold).\n` +
      `   Skipping resetSeededData() to protect production data.\n` +
      `   Set FORCE_SEED=true to bypass this guard.\n`
    );
    if (process.env.FORCE_SEED !== 'true') {
      console.log('Set FORCE_SEED=true to bypass this guard and wipe the database.');
      return;
    }
    console.log('FORCE_SEED=true — proceeding with destructive wipe...');
  }

  await resetSeededData();

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

  // ── Songs: Spotify only ──
  let totalSongsCreated = 0;

  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    throw new Error(
      'SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set for seeding.\n' +
      'Fallback songs have been removed — all catalog data comes from Spotify.'
    );
  }

  const token = await getSpotifyToken();
  console.log('\n🎵 Seeding from Spotify (keyword search across African music)...\n');

  const searchResult = await seedFromSpotifySearch(SEARCH_QUERIES, 30);
  console.log(`  Search: ${searchResult.songsCreated} songs, ${searchResult.artistsCreated} artists`);

  totalSongsCreated = searchResult.songsCreated;
  console.log(`\n✅ Total Spotify songs seeded: ${totalSongsCreated}\n`);

  // ── Community Data (uses first songs in DB) ──
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
        likes: 12,
        shares: 3,
        commentCount: 0,
        isPinned: true
      }
    });

    const topic2 = await prisma.topic.create({
      data: {
        title: 'Afrobeats hooks that changed global pop',
        content: 'Share songs that made non-African audiences pick up African slang and rhythm patterns.',
        authorId: adminUser.id,
        category: TopicCategory.SONG_DISCUSSION,
        forumCategoryId: createdForumCategories[1]?.id,
        likes: 20,
        shares: 6,
        commentCount: 0,
        isPinned: false
      }
    });

    const topLevelComment = await prisma.topicComment.create({
      data: {
        topicId: topic1.id,
        userId: adminUser.id,
        content: 'In this context, it carries resignation after emotional investment.',
        likes: 5
      }
    });

    await prisma.topicComment.create({
      data: {
        topicId: topic1.id,
        userId: regularUser.id,
        parentCommentId: topLevelComment.id,
        content: 'That makes sense. I hear that tone in the chorus delivery.',
        likes: 2
      }
    });

    await prisma.topicComment.create({
      data: {
        topicId: topic2.id,
        userId: regularUser.id,
        content: 'Essence is still a perfect entry point for many listeners.',
        likes: 4
      }
    });

    await prisma.topic.update({ where: { id: topic1.id }, data: { commentCount: 2 } });
    await prisma.topic.update({ where: { id: topic2.id }, data: { commentCount: 1 } });
    await prisma.forumCategory.update({ where: { id: createdForumCategories[0].id }, data: { topicCount: 1 } });
    await prisma.forumCategory.update({ where: { id: createdForumCategories[1].id }, data: { topicCount: 1 } });
  }

  // ── Translations (first 10 songs) ──
  const translationSongs = dbSongs.slice(0, 10);
  for (const entry of translationSongs) {
    const translation = await prisma.translation.create({
      data: {
        songId: entry.id,
        userId: regularUser.id,
        originalLyrics: `Original excerpt for ${entry.title}`,
        translatedLyrics: `Translated excerpt for ${entry.title} in French for demo purposes.`,
        culturalContext: `Context note: ${entry.title} includes slang common in West African pop music scenes.`,
        sourceLang: 'en',
        targetLang: 'fr',
        status: TranslationStatus.PUBLISHED,
        aiModel: 'gpt-5.3-codex',
        promptVersion: 'v1.0'
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
        translationId: translation.id,
        userId: adminUser.id,
        originalText: 'demo phrase',
        suggestedText: 'improved demo phrase',
        reason: 'Better cultural nuance',
        status: CorrectionStatus.APPROVED
      }
    });
  }

  // ── Song Requests ──
  if (dbSongs.length > 0) {
    await prisma.songRequest.createMany({
      data: [
        {
          songTitle: 'Ozeba',
          artist: 'Rema',
          userId: regularUser.id,
          status: RequestStatus.IN_REVIEW,
          notes: 'Popular club request from Lagos users.'
        },
        {
          songTitle: 'Active',
          artist: 'Asake',
          userId: regularUser.id,
          status: RequestStatus.PENDING,
          notes: 'Need Yoruba to English translation support.'
        }
      ]
    });
  }

  // ── Notifications ──
  await prisma.notification.createMany({
    data: [
      {
        userId: regularUser.id,
        title: 'Your translation was published',
        message: 'A moderator approved your translation contribution.',
        type: NotificationType.TRANSLATION,
        read: false
      },
      {
        userId: regularUser.id,
        title: 'New comment on your topic',
        message: 'A moderator replied with additional cultural context.',
        type: NotificationType.COMMENT,
        read: false
      }
    ]
  });

  // ── Badges & Tokens ──
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

  // ── Artist Application ──
  await prisma.artistApplication.create({
    data: {
      userId: users[2].id,
      stageName: 'Featured Artist',
      genre: 'Afrobeats',
      bio: 'Independent artist requesting verified artist profile.',
      socialLinks: {
        instagram: 'https://instagram.com/featuredartist',
        tiktok: 'https://tiktok.com/@featuredartist',
        youtube: 'https://youtube.com/@featuredartist'
      },
      status: ArtistApplicationStatus.UNDER_REVIEW
    }
  });

  // ── Summary ──
  const finalSongCount = await prisma.song.count();
  const finalArtistCount = await prisma.artist.count();
  console.log('\nSeed complete:');
  console.log(`- Users: ${users.length}`);
  console.log(`- Artists: ${finalArtistCount}`);
  console.log(`- Songs: ${finalSongCount}`);
  console.log(`- Languages: ${languageSeed.length}`);
  console.log(`- Genres: ${genreSeed.length}`);
  console.log(`- Source: Spotify (curated playlists + genre discovery)`);
  console.log('- Core community and translation tables seeded');
}

main()
  .then(async () => {
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      const redis = new Redis(redisUrl);
      try {
        const patterns = ['catalog:homepage:v*', 'spotify:search:*'];
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
