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
  return data.access_token;
}

// ─── Curated African Playlists ───────────────────────────────────────────────

const CURATED_PLAYLISTS = [
  '37i9dQZF1DX70RN3TfWWJh', // Afrobeats Hits
  '37i9dQZF1DX48TUlHJFJQy', // African Heat
  '37i9dQZF1DWYn5uZTUxl32', // Amapiano Grooves
  '37i9dQZF1DWZFmyF5TOM5K', // Amapiano Africa
  '37i9dQZF1DX7Q6hK1gDMcS', // Bongo Flava
  '37i9dQZF1DX9tPFwDMEDy1', // Africa Rising
  '37i9dQZF1DX1lVhptIYRsa', // Highlife classics
  '37i9dQZF1DXcFwqoL3JWZR', // Afro Fusion
  '37i9dQZF1DX0SM0LYsmbmt', // Dancehall Official
  '37i9dQZF1DWVqJMsg4Crbp', // African R&B
];

const TARGET_GENRES = [
  'afrobeats',
  'amapiano',
  'afropop',
  'afro fusion',
  'highlife',
  'r&b',
  'hip-hop',
  'dancehall',
];

// ─── Fallback Hardcoded Songs (when Spotify unavailable) ─────────────────────

type SeedSong = {
  title: string;
  artist: string;
  albumName: string;
  releaseYear: number;
  primaryGenre: string;
};

const FALLBACK_SONGS: SeedSong[] = [
  { title: 'Last Last', artist: 'Burna Boy', albumName: 'Love, Damini', releaseYear: 2022, primaryGenre: 'Afrobeats' },
  { title: 'Essence', artist: 'Wizkid', albumName: 'Made in Lagos', releaseYear: 2020, primaryGenre: 'Afropop' },
  { title: 'Free Mind', artist: 'Tems', albumName: 'For Broken Ears', releaseYear: 2020, primaryGenre: 'R&B' },
  { title: 'Fall', artist: 'Davido', albumName: 'A Good Time', releaseYear: 2017, primaryGenre: 'Afropop' },
  { title: 'Calm Down', artist: 'Rema', albumName: 'Rave & Roses', releaseYear: 2022, primaryGenre: 'Afropop' },
  { title: 'Rush', artist: 'Ayra Starr', albumName: '19 & Dangerous Deluxe', releaseYear: 2022, primaryGenre: 'Afropop' },
  { title: 'Lonely At The Top', artist: 'Asake', albumName: 'Work of Art', releaseYear: 2023, primaryGenre: 'Afrobeats' },
  { title: 'Buga', artist: 'Kizz Daniel', albumName: 'Single', releaseYear: 2022, primaryGenre: 'Afrobeats' },
  { title: 'Peru', artist: 'Fireboy DML', albumName: 'Playboy', releaseYear: 2021, primaryGenre: 'Afropop' },
  { title: 'Leg Over', artist: 'Mr Eazi', albumName: 'Life Is Eazi, Vol. 2', releaseYear: 2017, primaryGenre: 'Banku' },
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

async function seedFromSpotifyPlaylists(
  token: string,
  playlistIds: string[],
  limitPerPlaylist: number = 100,
): Promise<{ songsCreated: number; artistsCreated: number }> {
  let songsCreated = 0;
  let artistsCreated = 0;

  for (const playlistId of playlistIds) {
    console.log(`  Importing playlist: ${playlistId}`);
    let offset = 0;
    const playlistTracks: any[] = [];

    while (playlistTracks.length < limitPerPlaylist) {
      const res = await fetch(
        `${SPOTIFY_API}/playlists/${playlistId}/tracks?limit=${Math.min(100, limitPerPlaylist - playlistTracks.length)}&offset=${offset}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        console.warn(`  Failed to fetch playlist ${playlistId}: ${res.status}`);
        break;
      }
      const data = await res.json();
      const items = data.items || [];
      if (!items.length) break;
      playlistTracks.push(...items);
      offset += items.length;
      if (!data.next || playlistTracks.length >= limitPerPlaylist) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    for (const item of playlistTracks.slice(0, limitPerPlaylist)) {
      try {
        const track = item.track;
        if (!track || !track.artists?.[0]) continue;

        const artistData = track.artists[0];
        let artist = await prisma.artist.findFirst({ where: { spotifyId: artistData.id } });
        if (!artist) {
          const aRes = await fetch(`${SPOTIFY_API}/artists/${artistData.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const aData = aRes.ok ? await aRes.json() : {};
          artist = await prisma.artist.create({
            data: {
              name: artistData.name,
              spotifyId: artistData.id,
              imageUrl: aData.images?.[0]?.url || null,
              genres: aData.genres || [],
              popularity: aData.popularity || 0,
              followers: aData.followers?.total || 0,
              verified: false,
            },
          });
          artistsCreated++;
        }

        const albumData = track.album;
        let albumId: string | undefined;
        if (albumData) {
          let album = await prisma.album.findFirst({ where: { spotifyId: albumData.id } });
          if (!album) {
            album = await prisma.album.create({
              data: {
                name: albumData.name,
                artistId: artist.id,
                spotifyId: albumData.id,
                imageUrl: albumData.images?.[0]?.url || null,
                releaseYear: albumData.release_date
                  ? parseInt(albumData.release_date.substring(0, 4), 10)
                  : null,
                totalTracks: albumData.total_tracks || null,
                popularity: 0,
                genres: [],
              },
            });
          }
          albumId = album.id;
        }

        const existingSong = await prisma.song.findUnique({ where: { spotifyId: track.id } });
        if (!existingSong) {
          await prisma.song.create({
            data: {
              title: track.name,
              artistId: artist.id,
              albumId: albumId || null,
              albumName: albumData?.name || null,
              imageUrl: albumData?.images?.[0]?.url || null,
              spotifyId: track.id,
              spotifyPreviewUrl: track.preview_url || null,
              previewAvailable: !!track.preview_url,
              durationMs: track.duration_ms || null,
              trackNumber: track.track_number || null,
              releaseYear: albumData?.release_date
                ? parseInt(albumData.release_date.substring(0, 4), 10)
                : null,
              views: Math.floor(Math.random() * 5000),
            },
          });
          songsCreated++;
        }
      } catch {
        // Skip individual track errors
      }
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  return { songsCreated, artistsCreated };
}

async function seedFromSpotifyGenres(
  token: string,
  genres: string[],
  limitPerGenre: number = 50,
): Promise<{ songsCreated: number; artistsCreated: number }> {
  let songsCreated = 0;
  let artistsCreated = 0;

  for (const genre of genres) {
    console.log(`  Discovering genre: ${genre}`);
    const dedupedTracks = new Map<string, any>();

    for (let offset = 0; dedupedTracks.size < limitPerGenre; offset += 50) {
      const res = await fetch(
        `${SPOTIFY_API}/search?q=genre:${encodeURIComponent(genre)}&type=track&limit=${Math.min(50, limitPerGenre - dedupedTracks.size)}&offset=${offset}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) break;
      const data = await res.json();
      const tracks = data?.tracks?.items || [];
      if (!tracks.length) break;
      for (const track of tracks) {
        if (track?.id) dedupedTracks.set(track.id, track);
      }
      if (tracks.length < 50) break;
    }

    for (const track of dedupedTracks.values()) {
      try {
        if (!track.artists?.[0]) continue;
        const artistData = track.artists[0];
        let artist = await prisma.artist.findFirst({ where: { spotifyId: artistData.id } });
        if (!artist) {
          const aRes = await fetch(`${SPOTIFY_API}/artists/${artistData.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const aData = aRes.ok ? await aRes.json() : {};
          artist = await prisma.artist.create({
            data: {
              name: artistData.name,
              spotifyId: artistData.id,
              imageUrl: aData.images?.[0]?.url || null,
              genres: aData.genres || [],
              popularity: aData.popularity || 0,
              followers: aData.followers?.total || 0,
              verified: false,
            },
          });
          artistsCreated++;
        }

        const albumData = track.album;
        let albumId: string | undefined;
        if (albumData) {
          let album = await prisma.album.findFirst({ where: { spotifyId: albumData.id } });
          if (!album) {
            album = await prisma.album.create({
              data: {
                name: albumData.name,
                artistId: artist.id,
                spotifyId: albumData.id,
                imageUrl: albumData.images?.[0]?.url || null,
                releaseYear: albumData.release_date
                  ? parseInt(albumData.release_date.substring(0, 4), 10)
                  : null,
                totalTracks: albumData.total_tracks || null,
                popularity: 0,
                genres: [],
              },
            });
          }
          albumId = album.id;
        }

        const existingSong = await prisma.song.findUnique({ where: { spotifyId: track.id } });
        if (!existingSong) {
          await prisma.song.create({
            data: {
              title: track.name,
              artistId: artist.id,
              albumId: albumId || null,
              albumName: albumData?.name || null,
              imageUrl: albumData?.images?.[0]?.url || null,
              spotifyId: track.id,
              spotifyPreviewUrl: track.preview_url || null,
              previewAvailable: !!track.preview_url,
              durationMs: track.duration_ms || null,
              trackNumber: track.track_number || null,
              releaseYear: albumData?.release_date
                ? parseInt(albumData.release_date.substring(0, 4), 10)
                : null,
              views: Math.floor(Math.random() * 5000),
            },
          });
          songsCreated++;
        }
      } catch {
        // Skip individual track errors
      }
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  return { songsCreated, artistsCreated };
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

  // ── Songs: Spotify-first or Fallback ──
  let totalSongsCreated = 0;
  let useSpotify = false;
  let token = '';

  try {
    if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
      token = await getSpotifyToken();
      useSpotify = true;
    }
  } catch {
    // Spotify not configured
  }

  if (useSpotify) {
    console.log('\n🎵 Seeding from Spotify (curated playlists + genre discovery)...\n');

    const playlistResult = await seedFromSpotifyPlaylists(token, CURATED_PLAYLISTS, 100);
    console.log(`  Playlists: ${playlistResult.songsCreated} songs, ${playlistResult.artistsCreated} artists`);

    const genreResult = await seedFromSpotifyGenres(token, TARGET_GENRES, 50);
    console.log(`  Genres: ${genreResult.songsCreated} songs, ${genreResult.artistsCreated} artists`);

    totalSongsCreated = playlistResult.songsCreated + genreResult.songsCreated;
    console.log(`\n✅ Total Spotify songs seeded: ${totalSongsCreated}\n`);
  } else {
    console.log('\n⚠️  Spotify not configured — using fallback songs\n');
    console.log('  Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET for full catalog.\n');

    // Create fallback artists
    const artistMap = new Map<string, string>();
    const fallbackArtists = [...new Set(FALLBACK_SONGS.map((s) => s.artist))];
    for (const artistName of fallbackArtists) {
      const created = await prisma.artist.create({
        data: {
          name: artistName,
          genres: ['Afrobeats'],
          popularity: 80,
          followers: 5000000,
          verified: true,
          bio: `${artistName} is a leading voice in African music.`,
        }
      });
      artistMap.set(artistName, created.id);
    }

    const genreMap = new Map<string, string>();
    const allGenres = await prisma.genre.findMany();
    allGenres.forEach((g) => genreMap.set(g.name, g.id));

    for (const item of FALLBACK_SONGS) {
      const artistId = artistMap.get(item.artist);
      if (!artistId) continue;

      const song = await prisma.song.create({
        data: {
          title: item.title,
          artistId,
          albumName: item.albumName,
          releaseYear: item.releaseYear,
          imageUrl: '',
          views: 1000 + Math.floor(Math.random() * 9000),
          requestCount: Math.floor(Math.random() * 200),
        }
      });

      const genreId = genreMap.get(item.primaryGenre);
      if (genreId) {
        await prisma.songGenre.create({ data: { songId: song.id, genreId } });
      }

      totalSongsCreated++;
    }
  }

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
  console.log(`- Source: ${useSpotify ? 'Spotify (curated playlists + genre discovery)' : 'Fallback (hardcoded)'}`);
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
