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

type SeedSong = {
  title: string;
  artist: string;
  albumName: string;
  releaseYear: number;
  primaryGenre: string;
  languageProfile: Array<{ code: string; percentage: number }>;
};

const languageProfiles = {
  englishPidgin: [
    { code: 'en', percentage: 55 },
    { code: 'pcm', percentage: 45 }
  ],
  englishYoruba: [
    { code: 'en', percentage: 60 },
    { code: 'yo', percentage: 40 }
  ],
  englishIgbo: [
    { code: 'en', percentage: 65 },
    { code: 'ig', percentage: 35 }
  ],
  englishSwahili: [
    { code: 'en', percentage: 60 },
    { code: 'sw', percentage: 40 }
  ],
  englishFrench: [
    { code: 'en', percentage: 62 },
    { code: 'fr', percentage: 38 }
  ]
} as const;

const artistSeed = [
  { name: 'Burna Boy', genres: ['Afrobeats', 'Afro-fusion'], popularity: 95, followers: 12000000, verified: true },
  { name: 'Wizkid', genres: ['Afrobeats', 'Afropop'], popularity: 94, followers: 15000000, verified: true },
  { name: 'Tems', genres: ['Alt-R&B', 'Afropop'], popularity: 91, followers: 8500000, verified: true },
  { name: 'Davido', genres: ['Afrobeats', 'Afropop'], popularity: 93, followers: 17000000, verified: true },
  { name: 'Asake', genres: ['Afrobeats', 'Amapiano'], popularity: 90, followers: 7000000, verified: true },
  { name: 'Rema', genres: ['Afrobeats', 'Afropop'], popularity: 92, followers: 10000000, verified: true },
  { name: 'Ayra Starr', genres: ['Afropop', 'R&B'], popularity: 89, followers: 6500000, verified: true },
  { name: 'Tiwa Savage', genres: ['Afropop', 'R&B'], popularity: 90, followers: 13000000, verified: true },
  { name: 'Yemi Alade', genres: ['Afropop', 'Highlife'], popularity: 85, followers: 9000000, verified: true },
  { name: 'Omah Lay', genres: ['Afrobeats', 'R&B'], popularity: 88, followers: 6000000, verified: true },
  { name: 'Fireboy DML', genres: ['Afropop', 'Afrobeats'], popularity: 87, followers: 5500000, verified: true },
  { name: 'Mr Eazi', genres: ['Afrobeat', 'Banku'], popularity: 84, followers: 5000000, verified: true },
  { name: 'Kizz Daniel', genres: ['Afropop', 'Afrobeats'], popularity: 89, followers: 8000000, verified: true }
];

const genreSeed = [
  { name: 'Afrobeats', imageUrl: 'https://images.afrogenie.dev/genres/afrobeats.jpg' },
  { name: 'Afropop', imageUrl: 'https://images.afrogenie.dev/genres/afropop.jpg' },
  { name: 'Afro-fusion', imageUrl: 'https://images.afrogenie.dev/genres/afro-fusion.jpg' },
  { name: 'Amapiano', imageUrl: 'https://images.afrogenie.dev/genres/amapiano.jpg' },
  { name: 'Alt-R&B', imageUrl: 'https://images.afrogenie.dev/genres/alt-rnb.jpg' },
  { name: 'R&B', imageUrl: 'https://images.afrogenie.dev/genres/rnb.jpg' },
  { name: 'Highlife', imageUrl: 'https://images.afrogenie.dev/genres/highlife.jpg' },
  { name: 'Banku', imageUrl: 'https://images.afrogenie.dev/genres/banku.jpg' },
  { name: 'Dancehall', imageUrl: 'https://images.afrogenie.dev/genres/dancehall.jpg' },
  { name: 'Hip-Hop', imageUrl: 'https://images.afrogenie.dev/genres/hiphop.jpg' }
];

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

const forumCategorySeed = [
  { name: 'Translation Help', description: 'Ask for lyric meaning and translation support', icon: 'book-open', order: 1 },
  { name: 'Song Deep Dives', description: 'Discuss themes, slang, and context by song', icon: 'music-note', order: 2 },
  { name: 'Artist Lounge', description: 'Talk about artists, releases, and interviews', icon: 'user-group', order: 3 },
  { name: 'Community News', description: 'Platform announcements and updates', icon: 'megaphone', order: 4 }
];

const songs: SeedSong[] = [
  { title: 'Last Last', artist: 'Burna Boy', albumName: 'Love, Damini', releaseYear: 2022, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },
  { title: 'Ye', artist: 'Burna Boy', albumName: 'Outside', releaseYear: 2018, primaryGenre: 'Afro-fusion', languageProfile: languageProfiles.englishYoruba },
  { title: 'On The Low', artist: 'Burna Boy', albumName: 'African Giant', releaseYear: 2019, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },
  { title: 'Gbona', artist: 'Burna Boy', albumName: 'Outside', releaseYear: 2018, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishYoruba },
  { title: 'City Boys', artist: 'Burna Boy', albumName: 'I Told Them...', releaseYear: 2023, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },
  { title: "Sittin' On Top Of The World", artist: 'Burna Boy', albumName: 'I Told Them...', releaseYear: 2023, primaryGenre: 'Afro-fusion', languageProfile: languageProfiles.englishPidgin },

  { title: 'Essence', artist: 'Wizkid', albumName: 'Made in Lagos', releaseYear: 2020, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Ojuelegba', artist: 'Wizkid', albumName: 'Ayo', releaseYear: 2014, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishYoruba },
  { title: 'Come Closer', artist: 'Wizkid', albumName: 'Sounds from the Other Side', releaseYear: 2017, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Joro', artist: 'Wizkid', albumName: 'Made in Lagos', releaseYear: 2019, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishYoruba },
  { title: 'Mood', artist: 'Wizkid', albumName: 'Made in Lagos', releaseYear: 2020, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Ginger', artist: 'Wizkid', albumName: 'Made in Lagos', releaseYear: 2020, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },

  { title: 'Free Mind', artist: 'Tems', albumName: 'For Broken Ears', releaseYear: 2020, primaryGenre: 'Alt-R&B', languageProfile: languageProfiles.englishPidgin },
  { title: 'Higher', artist: 'Tems', albumName: 'If Orange Was a Place', releaseYear: 2021, primaryGenre: 'Alt-R&B', languageProfile: languageProfiles.englishPidgin },
  { title: 'Crazy Tings', artist: 'Tems', albumName: 'If Orange Was a Place', releaseYear: 2021, primaryGenre: 'Alt-R&B', languageProfile: languageProfiles.englishPidgin },
  { title: 'Me & U', artist: 'Tems', albumName: 'Single', releaseYear: 2023, primaryGenre: 'R&B', languageProfile: languageProfiles.englishPidgin },
  { title: 'Damages', artist: 'Tems', albumName: 'For Broken Ears', releaseYear: 2020, primaryGenre: 'R&B', languageProfile: languageProfiles.englishPidgin },
  { title: 'Found', artist: 'Tems', albumName: 'If Orange Was a Place', releaseYear: 2021, primaryGenre: 'R&B', languageProfile: languageProfiles.englishPidgin },

  { title: 'Fall', artist: 'Davido', albumName: 'A Good Time', releaseYear: 2017, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'If', artist: 'Davido', albumName: 'A Good Time', releaseYear: 2017, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },
  { title: 'FEM', artist: 'Davido', albumName: 'A Better Time', releaseYear: 2020, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },
  { title: 'Unavailable', artist: 'Davido', albumName: 'Timeless', releaseYear: 2023, primaryGenre: 'Amapiano', languageProfile: languageProfiles.englishPidgin },
  { title: 'Feel', artist: 'Davido', albumName: 'Timeless', releaseYear: 2023, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishYoruba },
  { title: 'Assurance', artist: 'Davido', albumName: 'A Good Time', releaseYear: 2018, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },

  { title: 'Lonely At The Top', artist: 'Asake', albumName: 'Work of Art', releaseYear: 2023, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishYoruba },
  { title: 'Organise', artist: 'Asake', albumName: 'Mr. Money With The Vibe', releaseYear: 2022, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishYoruba },
  { title: 'Joha', artist: 'Asake', albumName: 'Mr. Money With The Vibe', releaseYear: 2022, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishYoruba },
  { title: 'Sungba', artist: 'Asake', albumName: 'Mr. Money With The Vibe', releaseYear: 2022, primaryGenre: 'Amapiano', languageProfile: languageProfiles.englishYoruba },
  { title: 'Peace Be Unto You', artist: 'Asake', albumName: 'Mr. Money With The Vibe', releaseYear: 2022, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishYoruba },
  { title: '2:30', artist: 'Asake', albumName: 'Work of Art', releaseYear: 2023, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishYoruba },

  { title: 'Calm Down', artist: 'Rema', albumName: 'Rave & Roses', releaseYear: 2022, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Dumebi', artist: 'Rema', albumName: 'Rema', releaseYear: 2019, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },
  { title: 'Soundgasm', artist: 'Rema', albumName: 'Rave & Roses', releaseYear: 2021, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Holiday', artist: 'Rema', albumName: 'Rave & Roses Ultra', releaseYear: 2023, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Charm', artist: 'Rema', albumName: 'Rave & Roses Ultra', releaseYear: 2023, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },
  { title: 'Woman', artist: 'Rema', albumName: 'Rave & Roses', releaseYear: 2022, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },

  { title: 'Rush', artist: 'Ayra Starr', albumName: '19 & Dangerous Deluxe', releaseYear: 2022, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Bloody Samaritan', artist: 'Ayra Starr', albumName: '19 & Dangerous', releaseYear: 2021, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Commas', artist: 'Ayra Starr', albumName: 'Single', releaseYear: 2024, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Sability', artist: 'Ayra Starr', albumName: 'Single', releaseYear: 2023, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },
  { title: 'Beggie Beggie', artist: 'Ayra Starr', albumName: '19 & Dangerous Deluxe', releaseYear: 2022, primaryGenre: 'R&B', languageProfile: languageProfiles.englishPidgin },
  { title: 'Away', artist: 'Ayra Starr', albumName: 'Ayra Starr', releaseYear: 2021, primaryGenre: 'R&B', languageProfile: languageProfiles.englishPidgin },

  { title: 'Koroba', artist: 'Tiwa Savage', albumName: 'Celia', releaseYear: 2020, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishYoruba },
  { title: "Somebody's Son", artist: 'Tiwa Savage', albumName: 'Water & Garri', releaseYear: 2021, primaryGenre: 'R&B', languageProfile: languageProfiles.englishPidgin },
  { title: 'All Over', artist: 'Tiwa Savage', albumName: 'Sugarcane EP', releaseYear: 2017, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishYoruba },
  { title: '49-99', artist: 'Tiwa Savage', albumName: 'Single', releaseYear: 2019, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },
  { title: 'Eminado', artist: 'Tiwa Savage', albumName: 'Once Upon a Time', releaseYear: 2013, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishYoruba },
  { title: 'Ma Lo', artist: 'Tiwa Savage', albumName: 'Sugarcane EP', releaseYear: 2017, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },

  { title: 'Johnny', artist: 'Yemi Alade', albumName: 'King of Queens', releaseYear: 2013, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Shekere', artist: 'Yemi Alade', albumName: 'Empress', releaseYear: 2020, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishFrench },
  { title: 'Oh My Gosh', artist: 'Yemi Alade', albumName: 'Mama Africa', releaseYear: 2016, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Na Gode', artist: 'Yemi Alade', albumName: 'Mama Africa', releaseYear: 2016, primaryGenre: 'Highlife', languageProfile: languageProfiles.englishPidgin },
  { title: 'Ferrari', artist: 'Yemi Alade', albumName: 'Single', releaseYear: 2024, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishFrench },
  { title: 'Africa', artist: 'Yemi Alade', albumName: 'Woman of Steel', releaseYear: 2019, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishFrench },

  { title: 'Soso', artist: 'Omah Lay', albumName: 'Boy Alone', releaseYear: 2022, primaryGenre: 'R&B', languageProfile: languageProfiles.englishPidgin },
  { title: 'Understand', artist: 'Omah Lay', albumName: 'Single', releaseYear: 2021, primaryGenre: 'R&B', languageProfile: languageProfiles.englishPidgin },
  { title: 'Godly', artist: 'Omah Lay', albumName: 'What Have We Done', releaseYear: 2020, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Attention', artist: 'Omah Lay', albumName: 'Boy Alone', releaseYear: 2022, primaryGenre: 'R&B', languageProfile: languageProfiles.englishPidgin },
  { title: 'Damn', artist: 'Omah Lay', albumName: 'Get Layd', releaseYear: 2020, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },
  { title: 'Holy Ghost', artist: 'Omah Lay', albumName: 'Single', releaseYear: 2023, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },

  { title: 'Peru', artist: 'Fireboy DML', albumName: 'Playboy', releaseYear: 2021, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Vibration', artist: 'Fireboy DML', albumName: 'Laughter, Tears & Goosebumps', releaseYear: 2019, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishYoruba },
  { title: 'Scatter', artist: 'Fireboy DML', albumName: 'Laughter, Tears & Goosebumps', releaseYear: 2019, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishYoruba },
  { title: 'Playboy', artist: 'Fireboy DML', albumName: 'Playboy', releaseYear: 2022, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Tattoo', artist: 'Fireboy DML', albumName: 'Apollo', releaseYear: 2020, primaryGenre: 'R&B', languageProfile: languageProfiles.englishPidgin },
  { title: 'Bandana', artist: 'Fireboy DML', albumName: 'Playboy', releaseYear: 2022, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },

  { title: 'Leg Over', artist: 'Mr Eazi', albumName: 'Life Is Eazi, Vol. 2', releaseYear: 2017, primaryGenre: 'Banku', languageProfile: languageProfiles.englishPidgin },
  { title: 'Pour Me Water', artist: 'Mr Eazi', albumName: 'Life Is Eazi, Vol. 1', releaseYear: 2016, primaryGenre: 'Banku', languageProfile: languageProfiles.englishPidgin },
  { title: 'Skin Tight', artist: 'Mr Eazi', albumName: 'Life Is Eazi, Vol. 1', releaseYear: 2016, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Property', artist: 'Mr Eazi', albumName: 'Lagos to London', releaseYear: 2018, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Patek', artist: 'Mr Eazi', albumName: 'Single', releaseYear: 2022, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },
  { title: 'Hollup', artist: 'Mr Eazi', albumName: 'Single', releaseYear: 2023, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },

  { title: 'Buga', artist: 'Kizz Daniel', albumName: 'Single', releaseYear: 2022, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },
  { title: 'Cough', artist: 'Kizz Daniel', albumName: 'Maverick', releaseYear: 2022, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Lie', artist: 'Kizz Daniel', albumName: 'Barnabas', releaseYear: 2021, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishPidgin },
  { title: 'Twe Twe', artist: 'Kizz Daniel', albumName: 'Single', releaseYear: 2023, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },
  { title: "Pak 'n' Go", artist: 'Kizz Daniel', albumName: 'Maverick', releaseYear: 2023, primaryGenre: 'Afrobeats', languageProfile: languageProfiles.englishPidgin },
  { title: 'Woju', artist: 'Kizz Daniel', albumName: 'New Era', releaseYear: 2014, primaryGenre: 'Afropop', languageProfile: languageProfiles.englishYoruba }
];

async function resetSeededData() {
  await prisma.translationVote.deleteMany();
  await prisma.translationCorrection.deleteMany();
  await prisma.translation.deleteMany();
  await prisma.translationRequest.deleteMany();
  await prisma.songRequest.deleteMany();
  await prisma.topicComment.deleteMany();
  await prisma.topic.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.userBadge.deleteMany();
  await prisma.tokenReward.deleteMany();
  await prisma.artistApplication.deleteMany();
  await prisma.songGenre.deleteMany();
  await prisma.songLanguage.deleteMany();
  await prisma.lyric.deleteMany();
  await prisma.song.deleteMany();
  await prisma.genre.deleteMany();
  await prisma.artist.deleteMany();
  await prisma.forumCategory.deleteMany();
  await prisma.language.deleteMany();
  await prisma.user.deleteMany();
}

async function main() {
  if (songs.length !== 78) {
    throw new Error(`Expected 78 songs in seed data, found ${songs.length}.`);
  }

  await resetSeededData();

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

  await prisma.language.createMany({ data: languageSeed });
  await prisma.genre.createMany({ data: genreSeed });

  const createdForumCategories = await Promise.all(
    forumCategorySeed.map((item) =>
      prisma.forumCategory.create({
        data: {
          ...item,
          topicCount: 0
        }
      })
    )
  );

  const artistMap = new Map<string, string>();
  for (const item of artistSeed) {
    const created = await prisma.artist.create({
      data: {
        name: item.name,
        genres: item.genres,
        popularity: item.popularity,
        followers: item.followers,
        externalUrl: `https://open.spotify.com/search/${encodeURIComponent(item.name)}`,
        verified: item.verified,
        bio: `${item.name} is one of the leading voices in contemporary African music.`
      }
    });
    artistMap.set(item.name, created.id);
  }

  const genreMap = new Map<string, string>();
  const allGenres = await prisma.genre.findMany();
  allGenres.forEach((item) => genreMap.set(item.name, item.id));

  const createdSongs = new Array<{ id: string; title: string; artist: string }>();

  for (const item of songs) {
    const artistId = artistMap.get(item.artist);
    if (!artistId) {
      throw new Error(`Artist not found for song ${item.title}`);
    }

    const song = await prisma.song.create({
      data: {
        title: item.title,
        artistId,
        albumName: item.albumName,
        releaseYear: item.releaseYear,
        imageUrl: `https://images.afrogenie.dev/songs/${encodeURIComponent(item.artist.toLowerCase())}/${encodeURIComponent(item.title.toLowerCase())}.jpg`,
        views: 1000 + Math.floor(Math.random() * 9000),
        requestCount: Math.floor(Math.random() * 200)
      }
    });

    createdSongs.push({ id: song.id, title: item.title, artist: item.artist });

    const genreId = genreMap.get(item.primaryGenre);
    if (genreId) {
      await prisma.songGenre.create({
        data: {
          songId: song.id,
          genreId
        }
      });
    }

    // Only language buckets over 30% are saved for category surfacing.
    const qualifyingLanguages = item.languageProfile.filter((part) => part.percentage > 30);
    await prisma.songLanguage.createMany({
      data: qualifyingLanguages.map((part) => ({
        songId: song.id,
        languageCode: part.code,
        percentage: part.percentage
      }))
    });

    await prisma.lyric.create({
      data: {
        songId: song.id,
        content: `[Verse]\nSample licensed-safe placeholder lyrics for ${item.title} by ${item.artist}.\n\n[Chorus]\nAfro Genie seed content for development and testing workflows.`,
        sourceProvider: LyricSourceProvider.MANUAL,
        licenseStatus: LicenseStatus.UNKNOWN
      }
    });
  }

  const firstTenSongs = createdSongs.slice(0, 10);
  for (const entry of firstTenSongs) {
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
        {
          translationId: translation.id,
          userId: adminUser.id,
          voteType: VoteType.UPVOTE
        },
        {
          translationId: translation.id,
          userId: regularUser.id,
          voteType: VoteType.UPVOTE
        }
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

  await prisma.translationRequest.createMany({
    data: createdSongs.slice(10, 16).map((entry) => ({
      songId: entry.id,
      userId: regularUser.id,
      status: RequestStatus.PENDING,
      notes: `Please add a Portuguese translation for ${entry.title}.`
    }))
  });

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

  const topic1 = await prisma.topic.create({
    data: {
      title: 'What does "Last Last" really mean in context?',
      content: 'I understand the literal translation, but what is the emotional framing in Nigerian Pidgin?',
      authorId: regularUser.id,
      category: TopicCategory.TRANSLATION,
      forumCategoryId: createdForumCategories[0]?.id,
      songId: createdSongs[0]?.id,
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

  await prisma.topic.update({
    where: { id: topic1.id },
    data: { commentCount: 2 }
  });
  await prisma.topic.update({
    where: { id: topic2.id },
    data: { commentCount: 1 }
  });

  await prisma.forumCategory.update({
    where: { id: createdForumCategories[0].id },
    data: { topicCount: 1 }
  });
  await prisma.forumCategory.update({
    where: { id: createdForumCategories[1].id },
    data: { topicCount: 1 }
  });

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

  await prisma.userBadge.createMany({
    data: [
      {
        userId: regularUser.id,
        badgeType: BadgeType.CULTURE_CURATOR
      },
      {
        userId: adminUser.id,
        badgeType: BadgeType.COMMUNITY_HELPER
      }
    ]
  });

  await prisma.tokenReward.createMany({
    data: [
      {
        userId: regularUser.id,
        amount: 100,
        reason: 'Published translation contribution'
      },
      {
        userId: regularUser.id,
        amount: 25,
        reason: 'Helpful forum participation'
      }
    ]
  });

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

  console.log('Seed complete:');
  console.log(`- Users: ${users.length}`);
  console.log(`- Artists: ${artistSeed.length}`);
  console.log(`- Songs: ${songs.length}`);
  console.log(`- Languages: ${languageSeed.length}`);
  console.log(`- Genres: ${genreSeed.length}`);
  console.log('- Core community and translation tables seeded');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
