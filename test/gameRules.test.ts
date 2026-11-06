import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getInitialGameState } from '../src/services/gamePresentation';
import { applyGameAction, GameRuleError } from '../src/services/gameRules';

const lyric = {
  formatVersion: 1,
  level: 1,
  sources: ['https://example.com/song'],
  answerTitle: 'Burna Boy Song',
  acceptedTitles: ['Burna Boy Song', 'Burna Boy Song (Remix)'],
  artist: 'Burna Boy',
  clues: ['Clue one', 'Clue two', 'Clue three', 'Clue four', 'Clue five', 'Clue six'],
};

const targetAttributes = {
  name: 'Target Artist',
  country: 'Nigeria',
  region: 'West Africa',
  genre: 'Afrobeats',
  debut: 2010,
  gender: 'Female',
  size: 2,
};

const star = {
  formatVersion: 1,
  level: 1,
  sources: ['https://example.com/artist'],
  targetArtistId: 'target-artist',
  targetName: 'Target Artist',
  attributes: targetAttributes,
  hints: ['First private hint', 'Second private hint', 'Third private hint'],
};

const rhythm = {
  formatVersion: 1,
  level: 1,
  sources: ['https://example.com/board'],
  groups: [
    { id: 'group-1', label: 'One', items: ['a', 'b', 'c', 'd'] },
    { id: 'group-2', label: 'Two', items: ['e', 'f', 'g', 'h'] },
    { id: 'group-3', label: 'Three', items: ['i', 'j', 'k', 'l'] },
    { id: 'group-4', label: 'Four', items: ['m', 'n', 'o', 'p'] },
  ],
};

const beads = {
  formatVersion: 1,
  level: 1,
  sources: ['https://example.com/trivia'],
  questions: Array.from({ length: 5 }, (_, index) => ({
    id: `question-${index}`,
    prompt: `Question ${index}`,
    options: [
      { id: 'correct', label: 'Correct' },
      { id: 'wrong-1', label: 'Wrong one' },
      { id: 'wrong-2', label: 'Wrong two' },
      { id: 'wrong-3', label: 'Wrong three' },
    ],
    correctOptionId: 'correct',
    explanation: `Explanation ${index}`,
    source: 'https://example.com/trivia',
  })),
};

describe('authoritative game rules', () => {
  test('Lyric Genie accepts normalized aliases and progressively reveals clues', () => {
    const miss = applyGameAction('LYRIC_GENIE', lyric, getInitialGameState('LYRIC_GENIE'), {
      type: 'guess',
      value: 'wrong title',
    });
    assert.equal(miss.status, 'IN_PROGRESS');
    assert.deepEqual(miss.feedback.clues, ['Clue one', 'Clue two']);

    const win = applyGameAction('LYRIC_GENIE', lyric, miss.state, {
      type: 'guess',
      value: '  BURNA BOY—SONG (REMIX) ',
    });
    assert.equal(win.status, 'WON');
    assert.equal(win.won, true);
    assert.equal(win.feedback.answerTitle, 'Burna Boy Song');
  });

  test('Lyric Genie rejects repeated guesses and reveals the answer only after loss', () => {
    const first = applyGameAction('LYRIC_GENIE', lyric, getInitialGameState('LYRIC_GENIE'), {
      type: 'guess',
      value: 'Unknown',
    });
    assert.throws(() => applyGameAction('LYRIC_GENIE', lyric, first.state, {
      type: 'guess',
      value: 'unknown',
    }), GameRuleError);

    let state = first.state;
    let result = first;
    for (let attempt = 1; attempt < 6; attempt += 1) {
      result = applyGameAction('LYRIC_GENIE', lyric, state, { type: 'skip' });
      state = result.state;
    }
    assert.equal(result.status, 'LOST');
    assert.equal(result.feedback.answerTitle, 'Burna Boy Song');
  });

  test('Star Seeker compares attributes without exposing the target before completion', () => {
    const initial = getInitialGameState('STAR_SEEKER');
    const miss = applyGameAction('STAR_SEEKER', star, initial, {
      type: 'guess',
      artistId: 'candidate',
    }, {
      artistId: 'candidate',
      attributes: { ...targetAttributes, country: 'Ghana', debut: 2012, size: 1 },
    });

    assert.equal(miss.status, 'IN_PROGRESS');
    assert.deepEqual(miss.feedback.comparison, {
      country: 'NO_MATCH',
      region: 'MATCH',
      genre: 'MATCH',
      debut: 'LATER',
      gender: 'MATCH',
      size: 'LOWER',
    });
    assert.equal(JSON.stringify(miss.feedback).includes('Target Artist'), false);

    const hint = applyGameAction('STAR_SEEKER', star, miss.state, { type: 'hint' });
    assert.equal(hint.feedback.hint, 'First private hint');
    assert.deepEqual(hint.state.hints, ['First private hint']);
  });

  test('Star Seeker reveals the target only on a winning guess', () => {
    const win = applyGameAction('STAR_SEEKER', star, getInitialGameState('STAR_SEEKER'), {
      type: 'guess',
      artistId: 'target-artist',
    }, {
      artistId: 'target-artist',
      attributes: targetAttributes,
    });
    assert.equal(win.status, 'WON');
    assert.equal(win.feedback.answer, 'Target Artist');
  });

  test('Rhythm Groups reveals a category only after it is correctly solved', () => {
    const result = applyGameAction('RHYTHM_GROUPS', rhythm, getInitialGameState('RHYTHM_GROUPS'), {
      type: 'submit-group',
      items: ['d', 'b', 'a', 'c'],
    });
    assert.equal(result.feedback.correct, true);
    assert.deepEqual(result.feedback.solvedGroup, { label: 'One', items: ['a', 'b', 'c', 'd'] });
    assert.deepEqual(result.state.solvedGroupIds, ['group-1']);
  });

  test('Rhythm Groups ends after four mistakes and then reveals the solution', () => {
    let state = getInitialGameState('RHYTHM_GROUPS');
    let result = applyGameAction('RHYTHM_GROUPS', rhythm, state, {
      type: 'submit-group',
      items: ['a', 'b', 'c', 'e'],
    });
    state = result.state;
    for (let mistake = 1; mistake < 4; mistake += 1) {
      result = applyGameAction('RHYTHM_GROUPS', rhythm, state, {
        type: 'submit-group',
        items: ['a', 'b', 'c', 'e'],
      });
      state = result.state;
    }
    assert.equal(result.status, 'LOST');
    assert.deepEqual(result.feedback.groups, rhythm.groups);
  });

  test('Daily Beads enforces question order and scores on the server', () => {
    assert.throws(() => applyGameAction('DAILY_BEADS', beads, getInitialGameState('DAILY_BEADS'), {
      type: 'answer',
      questionId: 'question-1',
      optionId: 'correct',
    }), GameRuleError);

    let state = getInitialGameState('DAILY_BEADS');
    let result = applyGameAction('DAILY_BEADS', beads, state, {
      type: 'answer',
      questionId: 'question-0',
      optionId: 'correct',
    });
    state = result.state;
    for (let index = 1; index < 5; index += 1) {
      result = applyGameAction('DAILY_BEADS', beads, state, {
        type: 'answer',
        questionId: `question-${index}`,
        optionId: index < 3 ? 'correct' : 'wrong-1',
      });
      state = result.state;
    }
    assert.equal(result.status, 'WON');
    assert.equal(result.score, 3);
    assert.equal(result.feedback.correctOptionId, 'correct');
  });
});
