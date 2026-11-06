const DAY_MS = 24 * 60 * 60 * 1000;

export const GAME_PUZZLE_EPOCH_UTC = '2026-01-01';
export const GAME_LEVEL_COUNT = 100;

const EPOCH_MS = Date.parse(`${GAME_PUZZLE_EPOCH_UTC}T00:00:00.000Z`);

export function getUtcPuzzleDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function getPuzzleNumber(now = new Date()): number {
  const utcDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (!Number.isFinite(utcDayStart)) {
    throw new RangeError('Puzzle date must be a valid Date.');
  }
  const daysSinceEpoch = Math.floor((utcDayStart - EPOCH_MS) / DAY_MS);
  if (daysSinceEpoch < 0) {
    throw new RangeError(`Puzzle dates cannot be earlier than ${GAME_PUZZLE_EPOCH_UTC}.`);
  }
  return daysSinceEpoch + 1;
}

export function getLevelForPuzzleNumber(puzzleNumber: number): number {
  if (!Number.isSafeInteger(puzzleNumber) || puzzleNumber < 1) {
    throw new RangeError('Puzzle number must be a positive safe integer.');
  }
  return ((puzzleNumber - 1) % GAME_LEVEL_COUNT) + 1;
}

export function getDailyPuzzleSchedule(now = new Date()) {
  const puzzleNumber = getPuzzleNumber(now);
  const puzzleDate = getUtcPuzzleDate(now);
  const resetsAt = new Date(`${puzzleDate}T00:00:00.000Z`);
  resetsAt.setUTCDate(resetsAt.getUTCDate() + 1);
  return {
    puzzleDate,
    puzzleNumber,
    level: getLevelForPuzzleNumber(puzzleNumber),
    resetsAt: resetsAt.toISOString(),
  };
}
