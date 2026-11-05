import { GamePlayStatus, type Prisma } from '@prisma/client';
import { z, ZodError } from 'zod';
import {
  dailyBeadsContentSchema,
  lyricGenieContentSchema,
  rhythmGroupsContentSchema,
  starSeekerContentSchema,
  type GameContentType,
} from './gameContent';

const lyricActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('guess'), value: z.string().trim().min(1).max(160) }),
  z.object({ type: z.literal('skip') }),
]);

const starActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('guess'), artistId: z.string().trim().min(1).max(100) }),
  z.object({ type: z.literal('hint') }),
]);

const rhythmActionSchema = z.object({
  type: z.literal('submit-group'),
  items: z.array(z.string().trim().min(1).max(120)).length(4),
}).superRefine(({ items }, context) => {
  if (new Set(items.map((item) => item.toLowerCase())).size !== items.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'Group items must be unique.' });
  }
});

const beadsActionSchema = z.object({
  type: z.literal('answer'),
  questionId: z.string().trim().min(1).max(80),
  optionId: z.string().trim().min(1).max(80),
});

export class GameRuleError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'GameRuleError';
  }
}

export type GameTransition = {
  state: Prisma.InputJsonObject;
  status: GamePlayStatus;
  won: boolean | null;
  score: number | null;
  feedback: Prisma.InputJsonObject;
};

const parseAction = <T>(schema: z.ZodType<T>, action: unknown): T => {
  try {
    return schema.parse(action);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new GameRuleError(error.issues[0]?.message ?? 'Invalid game action', 400);
    }
    throw error;
  }
};

const parseState = <T>(schema: z.ZodType<T>, state: unknown): T => {
  try {
    return schema.parse(state);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new GameRuleError('Stored game state is invalid', 500);
    }
    throw error;
  }
};

const lyricStateSchema = z.object({
  guesses: z.array(z.string()),
  attemptsUsed: z.number().int().min(0).max(6),
  visibleClueCount: z.number().int().min(1).max(6),
});

const starStateSchema = z.object({
  guesses: z.array(z.string()),
  hintsUsed: z.number().int().min(0).max(3),
  hints: z.array(z.string()).max(3),
  guessFeedback: z.array(z.object({
    artistId: z.string(),
    correct: z.boolean(),
    comparison: z.record(z.string()).nullable(),
  })),
});

const rhythmStateSchema = z.object({
  solvedGroupIds: z.array(z.string()),
  solvedGroups: z.array(z.object({
    id: z.string(),
    label: z.string(),
    items: z.array(z.string()),
  })),
  mistakes: z.number().int().min(0).max(4),
  selection: z.array(z.string()),
});

const beadsStateSchema = z.object({
  answers: z.array(z.object({
    questionId: z.string(),
    optionId: z.string(),
    correct: z.boolean(),
  })),
  score: z.number().int().min(0).max(5),
});

const terminal = (status: GamePlayStatus) => status !== GamePlayStatus.IN_PROGRESS;

const normalizeAnswer = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

function transitionLyric(contentValue: unknown, stateValue: unknown, actionValue: unknown): GameTransition {
  const content = lyricGenieContentSchema.parse(contentValue);
  const action = parseAction(lyricActionSchema, actionValue);
  const state = parseState(lyricStateSchema, stateValue);
  if (state.attemptsUsed >= 6) throw new GameRuleError('No attempts remain', 409);

  const guess = action.type === 'guess' ? action.value : '';
  if (guess && state.guesses.some((previous) => normalizeAnswer(previous) === normalizeAnswer(guess))) {
    throw new GameRuleError('That title has already been guessed', 409);
  }

  const isCorrect = action.type === 'guess' && content.acceptedTitles.some(
    (title) => normalizeAnswer(title) === normalizeAnswer(action.value),
  );
  const attemptsUsed = state.attemptsUsed + 1;
  const won = isCorrect;
  const lost = !isCorrect && attemptsUsed >= 6;
  const status = won ? GamePlayStatus.WON : lost ? GamePlayStatus.LOST : GamePlayStatus.IN_PROGRESS;
  const guesses = guess ? [...state.guesses, guess] : state.guesses;

  return {
    state: {
      guesses,
      attemptsUsed,
      visibleClueCount: Math.min(6, state.visibleClueCount + (status === GamePlayStatus.IN_PROGRESS ? 1 : 0)),
    },
    status,
    won: terminal(status) ? won : null,
    score: terminal(status) ? (won ? 6 - attemptsUsed + 1 : 0) : null,
    feedback: {
      correct: isCorrect,
      attemptsUsed,
      clues: status === GamePlayStatus.IN_PROGRESS
        ? content.clues.slice(0, Math.min(6, state.visibleClueCount + 1))
        : content.clues,
      ...(terminal(status) ? { answerTitle: content.answerTitle, artist: content.artist } : {}),
    },
  };
}

export type StarSeekerArtistProfile = z.infer<typeof starSeekerContentSchema>['attributes'];

function attributeComparison(target: StarSeekerArtistProfile, candidate: StarSeekerArtistProfile) {
  const orderedComparison = (guess: number, answer: number): string =>
    guess === answer ? 'MATCH' : guess < answer ? 'EARLIER' : 'LATER';

  return {
    country: target.country === candidate.country ? 'MATCH' : 'NO_MATCH',
    region: target.region === candidate.region ? 'MATCH' : 'NO_MATCH',
    genre: target.genre === candidate.genre ? 'MATCH' : 'NO_MATCH',
    debut: orderedComparison(candidate.debut, target.debut),
    gender: target.gender === candidate.gender ? 'MATCH' : 'NO_MATCH',
    size: orderedComparison(candidate.size, target.size) === 'EARLIER'
      ? 'LOWER'
      : orderedComparison(candidate.size, target.size) === 'LATER'
        ? 'HIGHER'
        : 'MATCH',
  };
}

function transitionStar(
  contentValue: unknown,
  stateValue: unknown,
  actionValue: unknown,
  candidate?: { artistId: string; attributes: StarSeekerArtistProfile },
): GameTransition {
  const content = starSeekerContentSchema.parse(contentValue);
  const action = parseAction(starActionSchema, actionValue);
  const state = parseState(starStateSchema, stateValue);

  if (action.type === 'hint') {
    if (state.hintsUsed >= 3) throw new GameRuleError('No hints remain', 409);
    const hintsUsed = state.hintsUsed + 1;
    const hint = content.hints[hintsUsed - 1];
    return {
      state: { ...state, hintsUsed, hints: [...state.hints, hint] },
      status: GamePlayStatus.IN_PROGRESS,
      won: null,
      score: null,
      feedback: { hint, hintsUsed },
    };
  }

  if (state.guesses.length >= 10) throw new GameRuleError('No guesses remain', 409);
  if (!candidate) throw new GameRuleError('Artist is not in the published guess catalog', 400);
  if (candidate.artistId !== action.artistId) throw new GameRuleError('Artist comparison data is invalid', 500);
  if (state.guesses.includes(action.artistId)) throw new GameRuleError('That artist has already been guessed', 409);

  const won = action.artistId === content.targetArtistId;
  const guesses = [...state.guesses, action.artistId];
  const lost = !won && guesses.length >= 10;
  const status = won ? GamePlayStatus.WON : lost ? GamePlayStatus.LOST : GamePlayStatus.IN_PROGRESS;
  const comparison = won || lost ? null : attributeComparison(content.attributes, candidate.attributes);

  return {
    state: {
      ...state,
      guesses,
      guessFeedback: [...state.guessFeedback, { artistId: action.artistId, correct: won, comparison }],
    },
    status,
    won: terminal(status) ? won : null,
    score: terminal(status) ? (won ? 10 - guesses.length + 1 : 0) : null,
    feedback: {
      correct: won,
      guessesUsed: guesses.length,
      ...(won || lost
        ? { answer: content.targetName, attributes: content.attributes }
        : { comparison }),
    },
  };
}

function transitionRhythm(contentValue: unknown, stateValue: unknown, actionValue: unknown): GameTransition {
  const content = rhythmGroupsContentSchema.parse(contentValue);
  const action = parseAction(rhythmActionSchema, actionValue);
  const state = parseState(rhythmStateSchema, stateValue);
  const normalizedItems = action.items.map((item) => item.toLowerCase());
  const knownItems = new Set(content.groups.flatMap(({ items }) => items.map((item) => item.toLowerCase())));
  if (normalizedItems.some((item) => !knownItems.has(item))) {
    throw new GameRuleError('Submitted items are not on the board', 400);
  }
  const group = content.groups.find((candidate) =>
    candidate.items.length === action.items.length &&
    candidate.items.every((item) => normalizedItems.includes(item.toLowerCase())),
  );
  if (group && state.solvedGroupIds.includes(group.id)) {
    throw new GameRuleError('That group has already been solved', 409);
  }
  const mistakes = group ? state.mistakes : state.mistakes + 1;
  const solvedGroupIds = group ? [...state.solvedGroupIds, group.id] : state.solvedGroupIds;
  const won = solvedGroupIds.length === 4;
  const lost = !won && mistakes >= 4;
  const status = won ? GamePlayStatus.WON : lost ? GamePlayStatus.LOST : GamePlayStatus.IN_PROGRESS;

  return {
    state: {
      solvedGroupIds,
      solvedGroups: group
        ? [...state.solvedGroups, { id: group.id, label: group.label, items: group.items }]
        : state.solvedGroups,
      mistakes,
      selection: [],
    },
    status,
    won: terminal(status) ? won : null,
    score: terminal(status) ? solvedGroupIds.length : null,
    feedback: {
      correct: Boolean(group),
      mistakes,
      ...(group ? { solvedGroup: { label: group.label, items: group.items } } : {}),
      ...(lost ? { groups: content.groups } : {}),
    },
  };
}

function transitionBeads(contentValue: unknown, stateValue: unknown, actionValue: unknown): GameTransition {
  const content = dailyBeadsContentSchema.parse(contentValue);
  const action = parseAction(beadsActionSchema, actionValue);
  const state = parseState(beadsStateSchema, stateValue);
  const nextQuestion = content.questions[state.answers.length];
  if (!nextQuestion) throw new GameRuleError('All questions have been answered', 409);
  if (nextQuestion.id !== action.questionId) throw new GameRuleError('Answer questions in order', 409);
  const option = nextQuestion.options.find(({ id }) => id === action.optionId);
  if (!option) throw new GameRuleError('Unknown answer option', 400);
  const correct = nextQuestion.correctOptionId === option.id;
  const score = state.score + Number(correct);
  const answers = [...state.answers, { questionId: nextQuestion.id, optionId: option.id, correct }];
  const complete = answers.length === content.questions.length;
  const won = complete && score >= 3;
  const status = complete
    ? won ? GamePlayStatus.WON : GamePlayStatus.LOST
    : GamePlayStatus.IN_PROGRESS;

  return {
    state: { answers, score },
    status,
    won: complete ? won : null,
    score: complete ? score : null,
    feedback: {
      questionId: nextQuestion.id,
      optionId: option.id,
      correct,
      correctOptionId: nextQuestion.correctOptionId,
      explanation: nextQuestion.explanation,
      score,
      ...(complete ? { result: won ? 'WON' : 'LOST' } : {}),
    },
  };
}

export function applyGameAction(
  game: GameContentType,
  content: unknown,
  state: unknown,
  action: unknown,
  candidate?: { artistId: string; attributes: StarSeekerArtistProfile },
): GameTransition {
  switch (game) {
    case 'LYRIC_GENIE':
      return transitionLyric(content, state, action);
    case 'STAR_SEEKER':
      return transitionStar(content, state, action, candidate);
    case 'RHYTHM_GROUPS':
      return transitionRhythm(content, state, action);
    case 'DAILY_BEADS':
      return transitionBeads(content, state, action);
    default:
      throw new Error(`Unsupported game type: ${game satisfies never}`);
  }
}
