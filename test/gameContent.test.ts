import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dailyBeadsContentSchema,
  lyricGenieContentSchema,
  parseGameContent,
  rhythmGroupsContentSchema,
  starSeekerContentSchema,
} from '../src/services/gameContent';

const sources = ['https://example.com/source'];
const base = { formatVersion: 1, level: 1, sources };

describe('gameContent schemas', () => {
  test('accepts a complete Lyric Genie record with a canonical accepted title', () => {
    assert.equal(lyricGenieContentSchema.safeParse({
      ...base,
      answerTitle: 'Song',
      acceptedTitles: ['song', 'Song (Remix)'],
      artist: 'Artist',
      clues: ['1', '2', '3', '4', '5', '6'],
    }).success, true);
  });

  test('rejects Lyric Genie content without its answer among accepted titles', () => {
    assert.equal(lyricGenieContentSchema.safeParse({
      ...base,
      answerTitle: 'Song',
      acceptedTitles: ['Different song'],
      artist: 'Artist',
      clues: ['1', '2', '3', '4', '5', '6'],
    }).success, false);
  });

  test('rejects non-HTTPS sources', () => {
    assert.equal(lyricGenieContentSchema.safeParse({
      ...base,
      sources: ['http://example.com/source'],
      answerTitle: 'Song',
      acceptedTitles: ['Song'],
      artist: 'Artist',
      clues: ['1', '2', '3', '4', '5', '6'],
    }).success, false);
  });

  test('rejects Star Seeker metadata that does not match the target', () => {
    assert.equal(starSeekerContentSchema.safeParse({
      ...base,
      targetArtistId: 'target',
      targetName: 'Artist',
      attributes: {
        name: 'Another artist',
        country: 'Nigeria',
        region: 'West',
        genre: 'Afrobeats',
        debut: 2010,
        gender: 'Female',
        size: 1,
      },
      hints: ['hint 1', 'hint 2', 'hint 3'],
    }).success, false);
  });

  test('accepts a complete Star Seeker profile and its hints', () => {
    assert.equal(starSeekerContentSchema.safeParse({
      ...base,
      targetArtistId: 'artist',
      targetName: 'Artist',
      attributes: {
        name: 'Artist',
        country: 'Nigeria',
        region: 'West',
        genre: 'Afrobeats',
        debut: 2010,
        gender: 'Female',
        size: 1,
      },
      hints: ['hint 1', 'hint 2', 'hint 3'],
    }).success, true);
  });

  test('rejects duplicate items across Rhythm Groups', () => {
    assert.equal(rhythmGroupsContentSchema.safeParse({
      ...base,
      groups: [
        { id: 'g1', label: 'One', items: ['a', 'b', 'c', 'd'] },
        { id: 'g2', label: 'Two', items: ['e', 'f', 'g', 'h'] },
        { id: 'g3', label: 'Three', items: ['i', 'j', 'k', 'l'] },
        { id: 'g4', label: 'Four', items: ['m', 'n', 'o', 'a'] },
      ],
    }).success, false);
  });

  test('accepts four complete Rhythm Groups', () => {
    assert.equal(rhythmGroupsContentSchema.safeParse({
      ...base,
      groups: [
        { id: 'g1', label: 'One', items: ['a', 'b', 'c', 'd'] },
        { id: 'g2', label: 'Two', items: ['e', 'f', 'g', 'h'] },
        { id: 'g3', label: 'Three', items: ['i', 'j', 'k', 'l'] },
        { id: 'g4', label: 'Four', items: ['m', 'n', 'o', 'p'] },
      ],
    }).success, true);
  });

  test('rejects Daily Beads questions whose answer key is not a valid option', () => {
    const questions = Array.from({ length: 5 }, (_, index) => ({
      id: `q${index}`,
      prompt: `Question ${index}`,
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D' },
      ],
      correctOptionId: 'missing',
      explanation: 'An explanation',
      source: sources[0],
    }));
    assert.equal(dailyBeadsContentSchema.safeParse({ ...base, questions }).success, false);
  });

  test('accepts five Daily Beads questions with an answer in each option set', () => {
    const questions = Array.from({ length: 5 }, (_, index) => ({
      id: `q${index}`,
      prompt: `Question ${index}`,
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D' },
      ],
      correctOptionId: 'b',
      explanation: 'An explanation',
      source: sources[0],
    }));
    assert.equal(dailyBeadsContentSchema.safeParse({ ...base, questions }).success, true);
  });

  test('dispatches validation using the game discriminator', () => {
    const content = {
      ...base,
      answerTitle: 'Song',
      acceptedTitles: ['Song'],
      artist: 'Artist',
      clues: ['1', '2', '3', '4', '5', '6'],
    };
    assert.equal(parseGameContent('LYRIC_GENIE', content).level, 1);
    assert.throws(() => parseGameContent('DAILY_BEADS', content));
  });
});
