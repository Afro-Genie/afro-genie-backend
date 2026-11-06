import 'dotenv/config';
import { lookup } from 'node:dns/promises';
import { GamePuzzleStatus, GameType, Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { ARTISTS, ARTIST_HINTS, BOARDS, HTML_FORMAT_SOURCES, SONGS, TRIVIA } from './games-html-format';
import { SONGS_EXTRA, SONG_SOURCES_EXTRA } from './games-html-extra-songs';
import { ARTISTS_EXTRA, ARTIST_HINTS_EXTRA, ARTIST_SOURCES_EXTRA } from './games-html-extra-artists';
import { BOARDS_EXTRA, BOARD_SOURCES_EXTRA } from './games-html-extra-boards';
import { TRIVIA_EXTRA, TRIVIA_SOURCES_EXTRA } from './games-html-extra-trivia';
import { parseGameContent } from '../src/services/gameContent';

const LEVELS_PER_GAME = 100;
const games = [
  GameType.LYRIC_GENIE,
  GameType.STAR_SEEKER,
  GameType.RHYTHM_GROUPS,
  GameType.DAILY_BEADS,
] as const;

type TriviaRecord = {
  q: string;
  a: readonly string[];
  c: number;
  f: string;
};

function catalogEntries(): Array<{ id: string; game: GameType; content: Prisma.InputJsonObject }> {
  const entries: Array<{ id: string; game: GameType; content: Prisma.InputJsonObject }> = [];
  const allSongs = [...SONGS, ...SONGS_EXTRA];
  const allSongSources = [...HTML_FORMAT_SOURCES.songs, ...SONG_SOURCES_EXTRA];
  const allArtists = [...ARTISTS, ...ARTISTS_EXTRA];
  const allArtistSources = [...HTML_FORMAT_SOURCES.artists, ...ARTIST_SOURCES_EXTRA];
  const allBoards = [...BOARDS, ...BOARDS_EXTRA];
  const allBoardSources = [...HTML_FORMAT_SOURCES.boards, ...BOARD_SOURCES_EXTRA];
  const allTrivia: ReadonlyArray<ReadonlyArray<TriviaRecord>> = [...TRIVIA, ...TRIVIA_EXTRA];
  const allTriviaSources: ReadonlyArray<ReadonlyArray<string>> = [...HTML_FORMAT_SOURCES.trivia, ...TRIVIA_SOURCES_EXTRA];
  const allArtistHints = { ...ARTIST_HINTS, ...ARTIST_HINTS_EXTRA };
  const add = (game: GameType, level: number, content: Prisma.InputJsonObject) => {
    const puzzleContent = { formatVersion: 1, level, editorialStatus: 'REVIEW_REQUIRED', ...content };
    parseGameContent(game, puzzleContent);
    entries.push({
      id: `${game.toLowerCase()}-${String(level).padStart(3, '0')}`,
      game,
      content: puzzleContent,
    });
  };

  allSongs.forEach((song, index) => add(GameType.LYRIC_GENIE, index + 1, {
    answerTitle: song.title,
    acceptedTitles: [song.title],
    artist: song.artist,
    clues: [...song.clues],
    sources: [allSongSources[index]],
  }));

  allArtists.forEach((artist, index) => {
    const artistId = artist.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    add(GameType.STAR_SEEKER, index + 1, {
      targetArtistId: artistId,
      targetName: artist.name,
      attributes: { ...artist },
      hints: [...allArtistHints[artist.name as keyof typeof allArtistHints]],
      sources: [allArtistSources[index]],
    });
  });

  allBoards.forEach((groups, index) => add(GameType.RHYTHM_GROUPS, index + 1, {
    groups: groups.map((group, groupIndex) => ({
      id: `group-${groupIndex + 1}`,
      label: group.name,
      items: [...group.items],
    })),
    sources: [...allBoardSources[index]],
  }));

  allTrivia.forEach((questions, index) => add(GameType.DAILY_BEADS, index + 1, {
    questions: questions.map((question, questionIndex) => ({
      id: `question-${questionIndex + 1}`,
      prompt: question.q,
      options: question.a.map((label, optionIndex) => ({
        id: `option-${optionIndex + 1}`,
        label,
      })),
      correctOptionId: `option-${question.c + 1}`,
      explanation: question.f,
      source: allTriviaSources[index][questionIndex],
    })),
    sources: [...new Set(allTriviaSources[index])],
  }));

  return entries;
}

function validateHtmlFormatBatch() {
  const allSongs = [...SONGS, ...SONGS_EXTRA];
  const allSongSources = [...HTML_FORMAT_SOURCES.songs, ...SONG_SOURCES_EXTRA];
  const allArtists = [...ARTISTS, ...ARTISTS_EXTRA];
  const allArtistSources = [...HTML_FORMAT_SOURCES.artists, ...ARTIST_SOURCES_EXTRA];
  const allBoards = [...BOARDS, ...BOARDS_EXTRA];
  const allBoardSources = [...HTML_FORMAT_SOURCES.boards, ...BOARD_SOURCES_EXTRA];
  const allTrivia: ReadonlyArray<ReadonlyArray<TriviaRecord>> = [...TRIVIA, ...TRIVIA_EXTRA];
  const allTriviaSources: ReadonlyArray<ReadonlyArray<string>> = [...HTML_FORMAT_SOURCES.trivia, ...TRIVIA_SOURCES_EXTRA];
  const allArtistHints = { ...ARTIST_HINTS, ...ARTIST_HINTS_EXTRA };
  const counts: number[] = [allSongs.length, allArtists.length, allBoards.length, allTrivia.length];
  if (counts.some((count) => count > LEVELS_PER_GAME)) {
    throw new Error(`Each game can have at most ${LEVELS_PER_GAME} authored levels; got ${counts.join(', ')}.`);
  }
  if (
    allSongSources.length !== allSongs.length ||
    allArtistSources.length !== allArtists.length ||
    allBoardSources.length !== allBoards.length ||
    allTriviaSources.length !== allTrivia.length
  ) {
    throw new Error('Each HTML-format record must have a matching source reference.');
  }
  const allQuestions = allTrivia.flatMap((set) => set);
  const boardSignatures = allBoards.map((board) =>
    board.map((group) => group.items.slice().sort().join('|')).sort().join('||'),
  );
  if (
    new Set(allSongs.map((song) => song.title.trim().toLocaleLowerCase())).size !== allSongs.length ||
    new Set(allArtists.map((artist) => artist.name.trim().toLocaleLowerCase())).size !== allArtists.length ||
    new Set(allQuestions.map((question) => question.q.trim().toLocaleLowerCase())).size !== allQuestions.length ||
    new Set(boardSignatures).size !== allBoards.length
  ) {
    throw new Error('Game records must be distinct across all 100 levels.');
  }
  const sources = [
    ...allSongSources,
    ...allArtistSources,
    ...allBoardSources.flat(),
    ...allTriviaSources.flat(),
  ];
  for (const source of sources) {
    let parsedSource: URL;
    try {
      parsedSource = new URL(source);
    } catch {
      throw new Error(`Invalid source URL: ${source}`);
    }
    if (parsedSource.protocol !== 'https:') {
      throw new Error(`Source URLs must use HTTPS: ${source}`);
    }
  }

  allSongs.forEach((song, index) => {
    if (
      !song.title.trim() ||
      !song.artist.trim() ||
      song.clues.length !== 6 ||
      song.clues.some((clue) => !clue.trim()) ||
      !allSongSources[index]
    ) {
      throw new Error(`Invalid Lyric Genie record at level ${index + 1}.`);
    }
  });
  allArtists.forEach((artist, index) => {
    const hints = allArtistHints[artist.name as keyof typeof allArtistHints];
    if (!artist.name.trim() || artist.size < 1 || hints?.length !== 3 || !allArtistSources[index]) {
      throw new Error(`Invalid Star Seeker record at level ${index + 1}.`);
    }
  });
  allBoards.forEach((board, index) => {
    const items = board.flatMap((group) => group.items);
    if (
      board.length !== 4 ||
      board.some((group) => !group.name.trim() || group.items.length !== 4 || group.items.some((item) => !item.trim())) ||
      new Set(items).size !== 16 ||
      allBoardSources[index].some((source) => !source.trim())
    ) {
      throw new Error(`Invalid Rhythm Groups board at level ${index + 1}.`);
    }
  });
  allTrivia.forEach((set, index) => {
    if (
      set.length !== 5 ||
      set.some((question) =>
        !question.q.trim() ||
        !question.f.trim() ||
        question.a.length !== 4 ||
        new Set(question.a.map((option) => option.trim().toLocaleLowerCase())).size !== 4 ||
        question.c < 0 ||
        question.c > 3
      ) ||
      allTriviaSources[index].length !== 5
    ) {
      throw new Error(`Invalid Daily Beads set at level ${index + 1}.`);
    }
  });
}

function buildDraftRecords() {
  return games.flatMap((game) =>
    Array.from({ length: LEVELS_PER_GAME }, (_, index) => {
      const level = index + 1;
      return {
        id: `${game.toLowerCase()}-${String(level).padStart(3, '0')}`,
        game,
        level,
        status: GamePuzzleStatus.DRAFT,
        content: draftContent(game, level),
      };
    }),
  );
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, canonicalizeJson(nestedValue)]),
    );
  }
  return value;
}

function matchesSeedContent(current: Prisma.JsonValue, expected: Prisma.InputJsonObject): boolean {
  if (
    typeof current !== 'object' ||
    current === null ||
    Array.isArray(current) ||
    !('editorialStatus' in current) ||
    !['REVIEW_REQUIRED', 'APPROVED'].includes(String(current.editorialStatus))
  ) {
    return false;
  }
  const normalizedCurrent = { ...current, editorialStatus: 'REVIEW_REQUIRED' };
  return JSON.stringify(canonicalizeJson(normalizedCurrent)) === JSON.stringify(canonicalizeJson(expected));
}

function draftContent(game: GameType, level: number): Prisma.InputJsonObject {
  const common = {
    formatVersion: 1,
    level,
    editorialStatus: 'NOT_AUTHORED',
    sources: [],
  };

  switch (game) {
    case GameType.LYRIC_GENIE:
      return {
        ...common,
        answerTitle: '',
        acceptedTitles: [],
        artist: '',
        clues: [],
      };
    case GameType.STAR_SEEKER:
      return {
        ...common,
        targetArtistId: '',
        comparisonFields: [],
        hints: [],
      };
    case GameType.RHYTHM_GROUPS:
      return {
        ...common,
        groups: [],
      };
    case GameType.DAILY_BEADS:
      return {
        ...common,
        questions: [],
      };
  }
}

async function createDatabasePool(connectionString: string): Promise<Pool> {
  const databaseUrl = new URL(connectionString);
  const addresses = await lookup(databaseUrl.hostname, { all: true });
  const address = addresses.find(({ family }) => family === 4) ?? addresses[0];
  if (!address) {
    throw new Error(`Could not resolve the database host: ${databaseUrl.hostname}`);
  }

  return new Pool({
    host: address.address,
    port: Number(databaseUrl.port || 5432),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    database: decodeURIComponent(databaseUrl.pathname.slice(1)),
    ssl: { servername: databaseUrl.hostname },
  });
}

async function main() {
  validateHtmlFormatBatch();
  const authoredEntries = catalogEntries();
  const publishVerified = process.argv.includes('--publish-verified');
  const records = buildDraftRecords().map((record) => {
    const entry = authoredEntries.find((candidate) => candidate.id === record.id);
    if (!entry || !publishVerified) {
      return record;
    }

    return {
      ...record,
      status: GamePuzzleStatus.PUBLISHED,
      publishedAt: new Date(),
      content: { ...entry.content, editorialStatus: 'APPROVED' },
    };
  });
  if (process.argv.includes('--dry-run')) {
    const authoredCounts = games.map((game) =>
      `${game}: ${authoredEntries.filter((entry) => entry.game === game).length}/${LEVELS_PER_GAME}`,
    );
    console.log(
      `Dry run: ${records.length} catalog slots; ${authoredEntries.length} authored records ready ` +
        `${publishVerified ? 'for publication' : 'as review-required drafts'} ` +
        `(${authoredCounts.join(', ')}). Unauthored slots remain blank drafts.`,
    );
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must point to a verified non-production database.');
  }
  if (process.env.CONFIRM_GAMES_SEED !== 'I_HAVE_VERIFIED_NON_PRODUCTION_DATABASE') {
    throw new Error(
      'Refusing database writes. Set CONFIRM_GAMES_SEED=I_HAVE_VERIFIED_NON_PRODUCTION_DATABASE ' +
        'after verifying the target database is non-production.',
    );
  }

  const pool = await createDatabasePool(process.env.DATABASE_URL);
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const result = await prisma.gamePuzzle.createMany({
      data: records,
      skipDuplicates: true,
    });

    let contentImported = 0;
    for (const entry of authoredEntries) {
      const current = await prisma.gamePuzzle.findUnique({
        where: { id: entry.id },
        select: { status: true, content: true },
      });
      if (
        current?.status !== GamePuzzleStatus.DRAFT ||
        typeof current.content !== 'object' ||
        current.content === null ||
        Array.isArray(current.content)
      ) {
        continue;
      }

      const publishableDraft = publishVerified && matchesSeedContent(current.content, entry.content);
      if (current.content.editorialStatus !== 'NOT_AUTHORED' && !publishableDraft) {
        continue;
      }

      await prisma.gamePuzzle.update({
        where: { id: entry.id },
        data: {
          content: publishVerified
            ? { ...entry.content, editorialStatus: 'APPROVED' }
            : entry.content,
          ...(publishVerified
            ? { status: GamePuzzleStatus.PUBLISHED, publishedAt: new Date() }
            : {}),
        },
      });
      contentImported += 1;
    }

    console.log(
      `Inserted ${result.count} catalog levels. Existing non-seed catalog rows were preserved; ` +
        `${records.length} slots were requested (${games.length} games × ${LEVELS_PER_GAME}).`,
    );
    if (publishVerified) {
      console.log(`Imported and published ${contentImported} verified HTML-format content records.`);
    } else {
      console.log(
        `Imported ${contentImported} HTML-format content records as review-required drafts. ` +
          'No content was published.',
      );
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('Game catalog seeding failed:', error);
    process.exitCode = 1;
  });
}
