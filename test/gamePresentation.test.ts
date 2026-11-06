import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GamePlayStatus } from '@prisma/client';
import {
  getInitialGameState,
  toPublicGamePuzzle,
  toPublicGameState,
} from '../src/services/gamePresentation';

const lyric = {
  formatVersion: 1,
  level: 1,
  editorialStatus: 'APPROVED',
  sources: ['https://example.com/song'],
  answerTitle: 'Private Song Title',
  acceptedTitles: ['Private Song Title', 'Private Song (Remix)'],
  artist: 'Private Artist',
  clues: ['First clue', 'Second clue', 'Third clue', 'Fourth clue', 'Fifth clue', 'Sixth clue'],
};

const trivia = {
  formatVersion: 1,
  level: 1,
  editorialStatus: 'APPROVED',
  sources: ['https://example.com/trivia'],
  questions: Array.from({ length: 5 }, (_, index) => ({
    id: `question-${index}`,
    prompt: `Question ${index}`,
    options: [
      { id: 'a', label: 'Option A' },
      { id: 'b', label: 'Option B' },
      { id: 'c', label: 'Option C' },
      { id: 'd', label: 'Option D' },
    ],
    correctOptionId: 'b',
    explanation: 'Private answer explanation',
    source: 'https://example.com/trivia',
  })),
};

describe('gamePresentation', () => {
  test('exposes only the first Lyric Genie clue, never target or unrevealed clues', () => {
    const puzzle = toPublicGamePuzzle('LYRIC_GENIE', lyric, '2026-10-29', 2);
    const serialized = JSON.stringify(puzzle);

    assert.deepEqual(puzzle.clues, ['First clue']);
    assert.equal(serialized.includes('Private Song Title'), false);
    assert.equal(serialized.includes('Private Artist'), false);
    assert.equal(serialized.includes('Second clue'), false);
  });

  test('restores earned Lyric Genie clues and reveals the answer only after completion', () => {
    const active = toPublicGameState('LYRIC_GENIE', {
      guesses: ['Wrong Guess'],
      attemptsUsed: 1,
      visibleClueCount: 2,
    }, lyric, GamePlayStatus.IN_PROGRESS);
    assert.deepEqual(active.revealedClues, ['First clue', 'Second clue']);
    assert.equal('answerTitle' in active, false);

    const complete = toPublicGameState('LYRIC_GENIE', {
      guesses: ['Private Song Title'],
      attemptsUsed: 1,
      visibleClueCount: 1,
    }, lyric, GamePlayStatus.WON);
    assert.equal(complete.answerTitle, 'Private Song Title');
  });

  test('omits correct answers, explanations, and sources from Daily Beads', () => {
    const puzzle = toPublicGamePuzzle('DAILY_BEADS', trivia, '2026-10-29', 2);
    const serialized = JSON.stringify(puzzle);

    assert.ok('questions' in puzzle);
    if (!('questions' in puzzle) || !puzzle.questions) {
      throw new Error('Expected Daily Beads questions.');
    }
    assert.equal(puzzle.questions.length, 5);
    assert.equal(serialized.includes('correctOptionId'), false);
    assert.equal(serialized.includes('Private answer explanation'), false);
    assert.equal(serialized.includes('https://example.com'), false);
  });

  test('does not expose the Star Seeker target, attributes, or hints', () => {
    const puzzle = toPublicGamePuzzle('STAR_SEEKER', {
      formatVersion: 1,
      level: 1,
      sources: ['https://example.com/artist'],
      targetArtistId: 'private-id',
      targetName: 'Private Artist',
      attributes: {
        name: 'Private Artist',
        country: 'Nigeria',
        region: 'West Africa',
        genre: 'Afrobeats',
        debut: 2010,
        gender: 'Female',
        size: 1,
      },
      hints: ['Private hint one', 'Private hint two', 'Private hint three'],
    }, '2026-10-29', 2);
    const serialized = JSON.stringify(puzzle);

    assert.equal(serialized.includes('Private Artist'), false);
    assert.equal(serialized.includes('Private hint'), false);
    assert.equal(serialized.includes('private-id'), false);
  });

  test('shuffles Rhythm Groups tiles deterministically without returning groups', () => {
    const content = {
      formatVersion: 1,
      level: 1,
      sources: ['https://example.com/board'],
      groups: Array.from({ length: 4 }, (_, groupIndex) => ({
        id: `group-${groupIndex}`,
        label: `Private category ${groupIndex}`,
        items: Array.from({ length: 4 }, (_, itemIndex) => `tile-${groupIndex}-${itemIndex}`),
      })),
    };
    const first = toPublicGamePuzzle('RHYTHM_GROUPS', content, '2026-10-29', 2);
    const second = toPublicGamePuzzle('RHYTHM_GROUPS', content, '2026-10-29', 2);
    const serialized = JSON.stringify(first);

    assert.deepEqual(first, second);
    assert.ok('tiles' in first);
    if (!('tiles' in first) || !first.tiles) {
      throw new Error('Expected Rhythm Groups tiles.');
    }
    assert.equal(first.tiles.length, 16);
    assert.equal(serialized.includes('Private category'), false);
    assert.equal(serialized.includes('"groups"'), false);
  });

  test('initial states contain progress only, not hidden puzzle answers', () => {
    assert.deepEqual(getInitialGameState('LYRIC_GENIE'), { guesses: [], attemptsUsed: 0, visibleClueCount: 1 });
    assert.deepEqual(getInitialGameState('STAR_SEEKER'), {
      guesses: [],
      hintsUsed: 0,
      hints: [],
      guessFeedback: [],
    });
    assert.deepEqual(getInitialGameState('RHYTHM_GROUPS'), {
      solvedGroupIds: [],
      solvedGroups: [],
      mistakes: 0,
      selection: [],
    });
    assert.deepEqual(getInitialGameState('DAILY_BEADS'), { answers: [], score: 0 });
  });
});
