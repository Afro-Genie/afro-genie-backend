import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { findBestLyricsMatch, plainLyricsFromSyncedLyrics } from '../src/services/lyricsProviders/lyricsMatch';

describe('lyrics provider result matching', () => {
  test('selects a matching title and artist rather than the first search result', () => {
    const result = findBestLyricsMatch([
      { trackId: 'wrong-song', title: 'Lonely', artist: 'Asake' },
      { trackId: 'wrong-artist', title: 'Lonely at the Top', artist: 'Another Artist' },
      { trackId: 'exact', title: 'Lonely at the Top (Official Video)', artist: 'Asake' },
      { trackId: 'collaboration', title: 'Lonely at the Top', artist: 'Asake & Olamide' },
    ], 'Asake', 'Lonely at the Top');

    assert.equal(result?.trackId, 'exact');
  });

  test('matches normalized punctuation and accents but rejects partial title matches', () => {
    assert.equal(findBestLyricsMatch([
      { trackId: 'match', title: 'Coupé-Décalé', artist: 'Aïcha' },
      { trackId: 'partial', title: 'Coupé-Décalé Remix', artist: 'Aïcha' },
    ], 'Aicha', 'Coupe Decale')?.trackId, 'match');
    assert.equal(findBestLyricsMatch([
      { trackId: 'partial', title: 'Coupé-Décalé Remix', artist: 'Aïcha' },
    ], 'Aicha', 'Coupe Decale'), null);
  });

  test('converts synced lines to non-empty plain lyrics', () => {
    assert.equal(
      plainLyricsFromSyncedLyrics('[00:01.20]First line\r\n[00:02.30]Second line'),
      'First line\nSecond line',
    );
    assert.equal(plainLyricsFromSyncedLyrics('[00:01.20]'), '');
  });
});
