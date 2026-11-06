import { createHash, randomBytes } from 'node:crypto';
import { GamePlayStatus, GamePuzzleStatus, GameType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError } from '../middleware/errorHandler';
import { getDailyPuzzleSchedule } from './gameSchedule';
import { parseGameContent, starSeekerContentSchema, type GameContentType } from './gameContent';
import { getInitialGameState, toPublicGamePuzzle, toPublicGameState } from './gamePresentation';
import { applyGameAction, GameRuleError, type StarSeekerArtistProfile } from './gameRules';

const GAME_IDS = {
  lyrics: GameType.LYRIC_GENIE,
  'star-seeker': GameType.STAR_SEEKER,
  'rhythm-groups': GameType.RHYTHM_GROUPS,
  'daily-beads': GameType.DAILY_BEADS,
} as const;

export type GameId = keyof typeof GAME_IDS;

const GAME_METADATA: Record<GameId, {
  id: GameId;
  type: GameType;
  name: string;
  description: string;
  attemptLimit: number;
}> = {
  lyrics: {
    id: 'lyrics',
    type: GameType.LYRIC_GENIE,
    name: 'Lyric Genie',
    description: 'Guess the song from its clues.',
    attemptLimit: 6,
  },
  'star-seeker': {
    id: 'star-seeker',
    type: GameType.STAR_SEEKER,
    name: 'Star Seeker',
    description: 'Identify the artist from attribute comparisons.',
    attemptLimit: 10,
  },
  'rhythm-groups': {
    id: 'rhythm-groups',
    type: GameType.RHYTHM_GROUPS,
    name: 'Rhythm Groups',
    description: 'Sort sixteen music tiles into four groups.',
    attemptLimit: 4,
  },
  'daily-beads': {
    id: 'daily-beads',
    type: GameType.DAILY_BEADS,
    name: 'Daily Beads',
    description: 'Answer five African music trivia questions.',
    attemptLimit: 5,
  },
};

type StarSeekerCandidate = {
  artistId: string;
  name: string;
  attributes: StarSeekerArtistProfile;
};

const STAR_CANDIDATE_CACHE_TTL_MS = 5 * 60 * 1000;
let starCandidateCache: { expiresAt: number; candidates: StarSeekerCandidate[] } | undefined;
let starCandidateLoad: Promise<StarSeekerCandidate[]> | undefined;

const parseGameId = (gameId: string): GameId => {
  if (!Object.hasOwn(GAME_IDS, gameId)) {
    throw new ApiError('Unknown game', 'NOT_FOUND', 404);
  }
  return gameId as GameId;
};

const toGameContentType = (game: GameType): GameContentType => {
  switch (game) {
    case GameType.LYRIC_GENIE:
      return 'LYRIC_GENIE';
    case GameType.STAR_SEEKER:
      return 'STAR_SEEKER';
    case GameType.RHYTHM_GROUPS:
      return 'RHYTHM_GROUPS';
    case GameType.DAILY_BEADS:
      return 'DAILY_BEADS';
    default:
      throw new Error(`Unsupported game type: ${game satisfies never}`);
  }
};

const puzzleDateAsUtcDate = (puzzleDate: string): Date =>
  new Date(`${puzzleDate}T00:00:00.000Z`);

async function getPublishedPuzzle(game: GameType, puzzleDate: string) {
  const { level } = getDailyPuzzleSchedule(new Date(`${puzzleDate}T12:00:00.000Z`));
  const puzzle = await prisma.gamePuzzle.findUnique({
    where: { game_level: { game, level } },
    select: { id: true, game: true, level: true, status: true, content: true },
  });

  if (!puzzle || puzzle.status !== GamePuzzleStatus.PUBLISHED) {
    throw new ApiError("Today's game is not available yet", 'GAME_UNAVAILABLE', 404);
  }

  const contentType = toGameContentType(game);
  if (
    typeof puzzle.content !== 'object' ||
    puzzle.content === null ||
    !('editorialStatus' in puzzle.content) ||
    puzzle.content.editorialStatus !== 'APPROVED'
  ) {
    throw new ApiError('Published game content has not been approved', 'INVALID_GAME_CONTENT', 500);
  }
  const validatedContent = parseGameContent(contentType, puzzle.content);
  if (validatedContent.level !== level) {
    throw new ApiError('Published game content has an invalid level', 'INVALID_GAME_CONTENT', 500);
  }
  const projected = toPublicGamePuzzle(contentType, validatedContent, puzzleDate, level);

  return { puzzle, projected };
}

function getApprovedStarProfile(content: Prisma.JsonValue, rowLevel: number) {
  if (
    typeof content !== 'object' ||
    content === null ||
    !('editorialStatus' in content) ||
    content.editorialStatus !== 'APPROVED'
  ) {
    throw new ApiError('Published game content has not been approved', 'INVALID_GAME_CONTENT', 500);
  }
  const parsed = starSeekerContentSchema.parse(content);
  if (parsed.level !== rowLevel) {
    throw new ApiError('Published game content has an invalid level', 'INVALID_GAME_CONTENT', 500);
  }
  return parsed;
}

async function loadPublishedStarCandidates(): Promise<StarSeekerCandidate[]> {
  const rows = await prisma.gamePuzzle.findMany({
    where: { game: GameType.STAR_SEEKER, status: GamePuzzleStatus.PUBLISHED },
    select: { level: true, content: true },
    orderBy: { level: 'asc' },
  });
  const candidates = new Map<string, StarSeekerCandidate>();

  for (const row of rows) {
    const profile = getApprovedStarProfile(row.content, row.level);
    const candidate = {
      artistId: profile.targetArtistId,
      name: profile.targetName,
      attributes: profile.attributes,
    };
    const existing = candidates.get(candidate.artistId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) {
      throw new ApiError('Published artist catalog contains inconsistent records', 'INVALID_GAME_CONTENT', 500);
    }
    candidates.set(candidate.artistId, candidate);
  }

  return [...candidates.values()].sort((left, right) =>
    left.name === right.name
      ? left.artistId === right.artistId
        ? 0
        : left.artistId < right.artistId
          ? -1
          : 1
      : left.name < right.name
        ? -1
        : 1,
  );
}

async function getPublishedStarCandidates() {
  if (starCandidateCache && starCandidateCache.expiresAt > Date.now()) {
    return starCandidateCache.candidates;
  }
  if (!starCandidateLoad) {
    starCandidateLoad = loadPublishedStarCandidates();
  }

  const currentLoad = starCandidateLoad;
  try {
    const candidates = await currentLoad;
    if (starCandidateLoad === currentLoad) {
      starCandidateCache = {
        expiresAt: Date.now() + STAR_CANDIDATE_CACHE_TTL_MS,
        candidates,
      };
    }
    return candidates;
  } catch (error) {
    if (starCandidateLoad === currentLoad) {
      starCandidateLoad = undefined;
    }
    throw error;
  } finally {
    if (starCandidateLoad === currentLoad) {
      starCandidateLoad = undefined;
    }
  }
}

function initialStateFor(game: GameType): Prisma.InputJsonObject {
  return getInitialGameState(toGameContentType(game));
}

function publicPlayState(play: {
  id: string;
  status: GamePlayStatus;
  state: Prisma.JsonValue;
  won: boolean | null;
  score: number | null;
  completedAt: Date | null;
}, game: GameType, content: Prisma.JsonValue) {
  return {
    playId: play.id,
    status: play.status,
    state: toPublicGameState(toGameContentType(game), play.state, content, play.status),
    won: play.won,
    score: play.score,
    completedAt: play.completedAt?.toISOString() ?? null,
  };
}

export function getDailyGameManifest(now = new Date()) {
  const schedule = getDailyPuzzleSchedule(now);
  return {
    ...schedule,
    games: Object.values(GAME_METADATA).map(({ id, name, description, attemptLimit }) => ({
      id,
      name,
      description,
      attemptLimit,
    })),
  };
}

export async function getDailyGame(gameId: string, now = new Date()) {
  const id = parseGameId(gameId);
  const schedule = getDailyPuzzleSchedule(now);
  const { projected } = await getPublishedPuzzle(GAME_IDS[id], schedule.puzzleDate);
  if (GAME_IDS[id] === GameType.STAR_SEEKER) {
    const candidates = await getPublishedStarCandidates();
    return {
      ...schedule,
      puzzle: {
        ...projected,
        candidates: candidates.map(({ artistId, name }) => ({ artistId, name })),
      },
    };
  }
  return {
    ...schedule,
    puzzle: projected,
  };
}

export async function createGuestGameSession(gameId: string, now = new Date()) {
  const id = parseGameId(gameId);
  const game = GAME_IDS[id];
  const schedule = getDailyPuzzleSchedule(now);
  const { puzzle } = await getPublishedPuzzle(game, schedule.puzzleDate);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const play = await prisma.gamePlay.create({
    data: {
      guestTokenHash: tokenHash,
      game,
      puzzleId: puzzle.id,
      puzzleDate: puzzleDateAsUtcDate(schedule.puzzleDate),
      state: initialStateFor(game),
      expiresAt,
    },
    select: { id: true, status: true, state: true, won: true, score: true, completedAt: true },
  });

  return {
    token,
    expiresAt: expiresAt.toISOString(),
    puzzleDate: schedule.puzzleDate,
    play: publicPlayState(play, game, puzzle.content),
  };
}

export async function getGamePlayState(
  gameId: string,
  options: { userId?: string; guestToken?: string },
  now = new Date(),
) {
  const id = parseGameId(gameId);
  if (Boolean(options.userId) === Boolean(options.guestToken)) {
    throw new ApiError('Provide exactly one game-play owner', 'VALIDATION_ERROR', 400);
  }

  const game = GAME_IDS[id];
  const schedule = getDailyPuzzleSchedule(now);
  const { puzzle } = await getPublishedPuzzle(game, schedule.puzzleDate);
  const puzzleDate = puzzleDateAsUtcDate(schedule.puzzleDate);

  if (options.userId) {
    const state = await prisma.gamePlay.upsert({
      where: {
        userId_game_puzzleDate: {
          userId: options.userId,
          game,
          puzzleDate,
        },
      },
      create: {
        userId: options.userId,
        game,
        puzzleId: puzzle.id,
        puzzleDate,
        state: initialStateFor(game),
      },
      update: {},
      select: { id: true, status: true, state: true, won: true, score: true, completedAt: true },
    });
    return { puzzleDate: schedule.puzzleDate, play: publicPlayState(state, game, puzzle.content) };
  }

  const guestTokenHash = createHash('sha256').update(options.guestToken!).digest('hex');
  const state = await prisma.gamePlay.findUnique({
    where: {
      guestTokenHash_game_puzzleDate: {
        guestTokenHash,
        game,
        puzzleDate,
      },
    },
    select: {
      id: true,
      status: true,
      state: true,
      won: true,
      score: true,
      completedAt: true,
      expiresAt: true,
    },
  });

  if (!state || !state.expiresAt || state.expiresAt <= now) {
    throw new ApiError('Game session is invalid or expired', 'UNAUTHORIZED', 401);
  }

  return { puzzleDate: schedule.puzzleDate, play: publicPlayState(state, game, puzzle.content) };
}

export async function getDailyGameStatuses(
  owner: { userId?: string; guestTokens?: Partial<Record<GameId, string>> },
  now = new Date(),
) {
  if (Boolean(owner.userId) === (owner.guestTokens !== undefined)) {
    throw new ApiError('Provide exactly one game-progress owner', 'VALIDATION_ERROR', 400);
  }

  const gameIds = Object.keys(GAME_IDS) as GameId[];
  const schedule = getDailyPuzzleSchedule(now);
  const puzzleDate = puzzleDateAsUtcDate(schedule.puzzleDate);
  const statuses: Partial<Record<GameId, GamePlayStatus>> = {};

  if (owner.userId) {
    const plays = await prisma.gamePlay.findMany({
      where: {
        userId: owner.userId,
        puzzleDate,
        game: { in: gameIds.map((id) => GAME_IDS[id]) },
      },
      select: { game: true, status: true },
    });
    for (const play of plays) {
      const gameId = (Object.keys(GAME_IDS) as GameId[])
        .find((id) => GAME_IDS[id] === play.game);
      if (gameId) statuses[gameId] = play.status;
    }
  } else {
    const tokens = owner.guestTokens ?? {};
    const tokenHashes = new Map(
      Object.entries(tokens).map(([id, token]) => {
        if (
          !Object.hasOwn(GAME_IDS, id) ||
          typeof token !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(token)
        ) {
          throw new ApiError('Invalid guest game session token', 'VALIDATION_ERROR', 400);
        }
        return [
          createHash('sha256').update(token).digest('hex'),
          id as GameId,
        ] as const;
      }),
    );
    if (tokenHashes.size > 0) {
      const plays = await prisma.gamePlay.findMany({
        where: {
          guestTokenHash: { in: [...tokenHashes.keys()] },
          puzzleDate,
          expiresAt: { gt: now },
          game: { in: gameIds.map((id) => GAME_IDS[id]) },
        },
        select: { game: true, guestTokenHash: true, status: true },
      });
      for (const play of plays) {
        const gameId = play.guestTokenHash
          ? tokenHashes.get(play.guestTokenHash)
          : undefined;
        if (gameId && GAME_IDS[gameId] === play.game) statuses[gameId] = play.status;
      }
    }
  }

  return { puzzleDate: schedule.puzzleDate, statuses };
}

const isJsonObject = (value: Prisma.JsonValue): value is Prisma.JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cachedActionResponseSchema = z.object({
  puzzleDate: z.string(),
  play: z.object({
    playId: z.string(),
    status: z.enum(['IN_PROGRESS', 'WON', 'LOST', 'COMPLETED']),
    state: z.unknown(),
    won: z.boolean().nullable(),
    score: z.number().nullable(),
    completedAt: z.string().nullable(),
  }),
  feedback: z.record(z.unknown()),
});

export async function submitGameAction(
  gameId: string,
  owner: { userId?: string; guestToken?: string },
  idempotencyKey: string,
  action: unknown,
  now = new Date(),
) {
  const id = parseGameId(gameId);
  if (Boolean(owner.userId) === Boolean(owner.guestToken)) {
    throw new ApiError('Provide exactly one game-play owner', 'VALIDATION_ERROR', 400);
  }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw new ApiError('A valid Idempotency-Key header is required', 'VALIDATION_ERROR', 400);
  }

  const game = GAME_IDS[id];
  const schedule = getDailyPuzzleSchedule(now);
  const { puzzle } = await getPublishedPuzzle(game, schedule.puzzleDate);
  let candidate: { artistId: string; attributes: StarSeekerArtistProfile } | undefined;
  if (
    game === GameType.STAR_SEEKER &&
    typeof action === 'object' &&
    action !== null &&
    'type' in action &&
    action.type === 'guess' &&
    'artistId' in action &&
    typeof action.artistId === 'string'
  ) {
    candidate = (await getPublishedStarCandidates())
      .find((entry) => entry.artistId === action.artistId);
  }

  const puzzleDate = puzzleDateAsUtcDate(schedule.puzzleDate);
  const guestTokenHash = owner.guestToken
    ? createHash('sha256').update(owner.guestToken).digest('hex')
    : undefined;

  return prisma.$transaction(async (transaction) => {
    let play;
    if (owner.userId) {
      play = await transaction.gamePlay.upsert({
          where: {
            userId_game_puzzleDate: {
              userId: owner.userId,
              game,
              puzzleDate,
            },
          },
          create: {
            userId: owner.userId,
            game,
            puzzleId: puzzle.id,
            puzzleDate,
            state: initialStateFor(game),
          },
          update: {},
        });
    } else {
      if (!guestTokenHash) {
        throw new ApiError('Game session is required', 'UNAUTHORIZED', 401);
      }
      play = await transaction.gamePlay.findUnique({
          where: {
            guestTokenHash_game_puzzleDate: {
              guestTokenHash,
              game,
              puzzleDate,
            },
          },
        });
    }

    if (!play || (play.guestTokenHash && (!play.expiresAt || play.expiresAt <= now))) {
      throw new ApiError('Game session is invalid or expired', 'UNAUTHORIZED', 401);
    }

    if (!isJsonObject(play.actionResults)) {
      throw new ApiError('Stored game action results are invalid', 'INVALID_GAME_STATE', 500);
    }
    const cachedResponse = play.actionResults[idempotencyKey];
    if (cachedResponse !== undefined) {
      const parsed = cachedActionResponseSchema.safeParse(cachedResponse);
      if (!parsed.success) {
        throw new ApiError('Stored game action result is invalid', 'INVALID_GAME_STATE', 500);
      }
      return parsed.data;
    }
    if (play.status !== 'IN_PROGRESS') {
      throw new ApiError('This game is already complete', 'GAME_COMPLETE', 409);
    }

    let transition;
    try {
      transition = applyGameAction(
        toGameContentType(game),
        puzzle.content,
        play.state,
        action,
        candidate,
      );
    } catch (error) {
      if (error instanceof GameRuleError) {
        throw new ApiError(error.message, 'INVALID_GAME_ACTION', error.status);
      }
      throw error;
    }

    const completedAt = transition.status === 'IN_PROGRESS' ? null : now;
    const response: Prisma.InputJsonObject = {
      puzzleDate: schedule.puzzleDate,
      play: {
        playId: play.id,
        status: transition.status,
        state: toPublicGameState(
          toGameContentType(game),
          transition.state,
          puzzle.content,
          transition.status,
        ),
        won: transition.won,
        score: transition.score,
        completedAt: completedAt?.toISOString() ?? null,
      },
      feedback: transition.feedback,
    };
    const nextActionResults: Prisma.InputJsonObject = {
      ...play.actionResults,
      [idempotencyKey]: response,
    };
    const updated = await transaction.gamePlay.updateMany({
      where: { id: play.id, version: play.version, status: 'IN_PROGRESS' },
      data: {
        state: transition.state,
        status: transition.status,
        won: transition.won,
        score: transition.score,
        completedAt,
        actionResults: nextActionResults,
        version: { increment: 1 },
      },
    });

    if (updated.count !== 1) {
      const latest = await transaction.gamePlay.findUnique({
        where: { id: play.id },
        select: { actionResults: true },
      });
      if (latest && isJsonObject(latest.actionResults)) {
        const latestCached = latest.actionResults[idempotencyKey];
        if (latestCached !== undefined) {
          const parsed = cachedActionResponseSchema.safeParse(latestCached);
          if (parsed.success) return parsed.data;
        }
      }
      throw new ApiError('Game state changed; retry with the same idempotency key', 'CONFLICT', 409);
    }

    return response;
  });
}
