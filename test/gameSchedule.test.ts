import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GAME_PUZZLE_EPOCH_UTC,
  getDailyPuzzleSchedule,
  getLevelForPuzzleNumber,
  getPuzzleNumber,
  getUtcPuzzleDate,
} from '../src/services/gameSchedule';

describe('gameSchedule', () => {
  test('uses the documented UTC epoch and puzzle number', () => {
    assert.equal(GAME_PUZZLE_EPOCH_UTC, '2026-01-01');
    assert.deepEqual(getDailyPuzzleSchedule(new Date('2026-10-29T12:00:00.000Z')), {
      puzzleDate: '2026-10-29',
      puzzleNumber: 302,
      level: 2,
      resetsAt: '2026-10-30T00:00:00.000Z',
    });
  });

  test('derives the puzzle date in UTC rather than local time', () => {
    const now = new Date('2026-10-29T23:30:00.000-05:00');
    assert.equal(getUtcPuzzleDate(now), '2026-10-30');
    assert.equal(getPuzzleNumber(now), 303);
  });

  test('rotates through exactly 100 levels in stable order', () => {
    assert.equal(getLevelForPuzzleNumber(1), 1);
    assert.equal(getLevelForPuzzleNumber(100), 100);
    assert.equal(getLevelForPuzzleNumber(101), 1);
    assert.equal(getLevelForPuzzleNumber(302), 2);
  });

  test('rejects dates before the fixed epoch and invalid puzzle numbers', () => {
    assert.throws(() => getPuzzleNumber(new Date('2025-12-31T12:00:00.000Z')), RangeError);
    assert.throws(() => getPuzzleNumber(new Date(Number.NaN)), RangeError);
    assert.throws(() => getLevelForPuzzleNumber(0), RangeError);
    assert.throws(() => getLevelForPuzzleNumber(1.5), RangeError);
  });
});
