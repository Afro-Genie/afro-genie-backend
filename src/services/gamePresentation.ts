import { createHash } from 'node:crypto';
import { GamePlayStatus, type Prisma } from '@prisma/client';
import {
  dailyBeadsContentSchema,
  lyricGenieContentSchema,
  rhythmGroupsContentSchema,
  starSeekerContentSchema,
  type GameContentType,
} from './gameContent';
import { z } from 'zod';

export function getInitialGameState(game: GameContentType): Prisma.InputJsonObject {
  switch (game) {
    case 'LYRIC_GENIE':
      return { guesses: [], attemptsUsed: 0, visibleClueCount: 1 };
    case 'STAR_SEEKER':
      return { guesses: [], hintsUsed: 0, hints: [], guessFeedback: [] };
    case 'RHYTHM_GROUPS':
      return { solvedGroupIds: [], solvedGroups: [], mistakes: 0, selection: [] };
    case 'DAILY_BEADS':
      return { answers: [], score: 0 };
    default:
      throw new Error(`Unsupported game type: ${game satisfies never}`);
  }
}

export function toPublicGameState(
  game: GameContentType,
  stateValue: unknown,
  contentValue: unknown,
  status: GamePlayStatus,
): Prisma.InputJsonObject {
  switch (game) {
    case 'LYRIC_GENIE': {
      const content = lyricGenieContentSchema.parse(contentValue);
      const state = z.object({
        guesses: z.array(z.string()),
        attemptsUsed: z.number().int().min(0).max(6),
        visibleClueCount: z.number().int().min(1).max(6),
      }).parse(stateValue);
      return {
        ...state,
        revealedClues: content.clues.slice(0, state.visibleClueCount),
        ...(status !== GamePlayStatus.IN_PROGRESS
          ? { answerTitle: content.answerTitle, artist: content.artist }
          : {}),
      };
    }
    case 'STAR_SEEKER': {
      const content = starSeekerContentSchema.parse(contentValue);
      const state = z.object({
        guesses: z.array(z.string()),
        hintsUsed: z.number().int().min(0).max(3),
        hints: z.array(z.string()).max(3),
        guessFeedback: z.array(z.object({
          artistId: z.string(),
          correct: z.boolean(),
          comparison: z.record(z.string()).nullable(),
        })),
      }).parse(stateValue);
      return {
        ...state,
        ...(status !== GamePlayStatus.IN_PROGRESS
          ? { answer: content.targetName, attributes: content.attributes }
          : {}),
      };
    }
    case 'RHYTHM_GROUPS': {
      const content = rhythmGroupsContentSchema.parse(contentValue);
      const state = z.object({
        solvedGroupIds: z.array(z.string()),
        solvedGroups: z.array(z.object({
          id: z.string(),
          label: z.string(),
          items: z.array(z.string()),
        })),
        mistakes: z.number().int().min(0).max(4),
        selection: z.array(z.string()),
      }).parse(stateValue);
      return {
        ...state,
        ...(status === GamePlayStatus.LOST ? { groups: content.groups } : {}),
      };
    }
    case 'DAILY_BEADS': {
      const content = dailyBeadsContentSchema.parse(contentValue);
      const state = z.object({
        answers: z.array(z.object({
          questionId: z.string(),
          optionId: z.string(),
          correct: z.boolean(),
        })),
        score: z.number().int().min(0).max(5),
      }).parse(stateValue);
      return {
        ...state,
        answeredQuestions: state.answers.map((answer) => {
          const question = content.questions.find(({ id }) => id === answer.questionId);
          if (!question) throw new Error('Stored Daily Beads state refers to an unknown question.');
          return {
            ...answer,
            correctOptionId: question.correctOptionId,
            explanation: question.explanation,
          };
        }),
      };
    }
    default:
      throw new Error(`Unsupported game type: ${game satisfies never}`);
  }
}

function stableTileOrder(puzzleDate: string, level: number, item: string): string {
  return createHash('sha256')
    .update(`${puzzleDate}:${level}:${item}`)
    .digest('hex');
}

export function toPublicGamePuzzle(
  game: GameContentType,
  content: unknown,
  puzzleDate: string,
  level: number,
) {
  switch (game) {
    case 'LYRIC_GENIE': {
      const puzzle = lyricGenieContentSchema.parse(content);
      return {
        game,
        level,
        puzzleDate,
        clueCount: puzzle.clues.length,
        attemptLimit: 6,
        clues: [puzzle.clues[0]],
      };
    }
    case 'STAR_SEEKER': {
      starSeekerContentSchema.parse(content);
      return {
        game,
        level,
        puzzleDate,
        attemptLimit: 10,
        hintLimit: 3,
      };
    }
    case 'RHYTHM_GROUPS': {
      const puzzle = rhythmGroupsContentSchema.parse(content);
      const tiles = puzzle.groups.flatMap(({ items }) => items);
      tiles.sort((left, right) => {
        const leftOrder = stableTileOrder(puzzleDate, level, left);
        const rightOrder = stableTileOrder(puzzleDate, level, right);
        return leftOrder === rightOrder ? 0 : leftOrder < rightOrder ? -1 : 1;
      });
      return {
        game,
        level,
        puzzleDate,
        tiles,
        groupCount: puzzle.groups.length,
        mistakesAllowed: 4,
      };
    }
    case 'DAILY_BEADS': {
      const puzzle = dailyBeadsContentSchema.parse(content);
      return {
        game,
        level,
        puzzleDate,
        questions: puzzle.questions.map(({ id, prompt, options }) => ({
          id,
          prompt,
          options,
        })),
        questionCount: puzzle.questions.length,
        winThreshold: 3,
      };
    }
    default:
      throw new Error(`Unsupported game type: ${game satisfies never}`);
  }
}
