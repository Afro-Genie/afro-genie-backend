import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManualAfricanSongGenres } from '../src/services/youtubeCatalogPolicy';

describe('manual song African-music policy', () => {
  test('accepts supported genres shared by the artist and song', () => {
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

  test('rejects an unreviewed artist and a genre not allowed for the selected artist', () => {
    assert.throws(
      () => validateManualAfricanSongGenres('Unreviewed Artist', ['Afrobeats']),
      /configured African artist manifest/,
    );
    assert.throws(
      () => validateManualAfricanSongGenres('Asake', ['Fuji']),
      /must match the selected artist/,
    );
  });
});
