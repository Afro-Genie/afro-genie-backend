import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManualAfricanSongGenres } from '../src/services/youtubeCatalogPolicy';

describe('manual song African-music policy', () => {
  test('accepts supported African genre aliases', () => {
    assert.deepEqual(
      validateManualAfricanSongGenres('Asake', ['Afro Beats']),
      ['Afrobeats'],
    );
  });

  test('rejects songs without an approved African genre', () => {
    assert.throws(
      () => validateManualAfricanSongGenres('Asake', ['Western Pop']),
      /approved African music genres/,
    );
    assert.throws(
      () => validateManualAfricanSongGenres('Asake', []),
      /approved African music genres/,
    );
  });

  test('normalizes any approved African genre alias regardless of artist name', () => {
    assert.deepEqual(
      validateManualAfricanSongGenres('Unreviewed Artist', ['Afrobeats']),
      ['Afrobeats'],
    );
    assert.deepEqual(
      validateManualAfricanSongGenres('Asake', ['Fuji']),
      ['Fuji'],
    );
  });
});
