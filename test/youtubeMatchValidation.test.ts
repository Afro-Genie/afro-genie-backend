import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText,
  tokenize,
  scoreCandidate,
  selectBestCandidate,
  summarizeRejections,
  STRICT_THRESHOLDS,
  LOOSE_THRESHOLDS,
  type MatchCandidate,
} from '../src/services/youtubeMatchValidation';

// Phase B — match validation.
//
// Every case below is a real observation from the production catalog probe or a
// regression the old `items[0]` behaviour would have shipped. The unit under
// test is pure, so none of this needs a network, a database, or an API key.

const candidate = (over: Partial<MatchCandidate> = {}): MatchCandidate => ({
  videoId: 'vid0000001',
  title: 'Soweto',
  channelTitle: 'Burna Boy',
  durationSeconds: 165,
  embeddable: true,
  ...over,
});

describe('normalizeText / tokenize', () => {
  test('drops upload-describing tokens but keeps identity tokens', () => {
    assert.deepEqual(tokenize('Turbulence Official Video by Wizkid'), ['turbulence', 'wizkid']);
    assert.deepEqual(tokenize('Turbulence (Official Music Video) [4K]'), ['turbulence']);
  });

  // Regression: an earlier version stripped bracketed segments, which erased the
  // artist name whenever it appeared in a feature credit — and credits are where
  // it lives. That made the Soweto remix look artist-less and got it rejected by
  // the wrong gate, for the wrong reason.
  test('keeps names that appear inside feature credits', () => {
    assert.deepEqual(
      tokenize('Soweto, Tshwala Bam (Feat. Victony, Rema, Omah Lay) REMIX'),
      ['soweto', 'tshwala', 'bam', 'victony', 'rema', 'omah', 'lay', 'remix'],
      'credited artists must survive tokenization',
    );
    assert.deepEqual(tokenize('Soweto (feat. Omah Lay)'), ['soweto', 'omah', 'lay']);
  });

  test('folds diacritics and & to "and"', () => {
    assert.equal(normalizeText('Simón & Adé'), 'simon and ade');
  });

  test('is empty-safe', () => {
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize('   '), []);
  });
});

describe('scoreCandidate — the Soweto incident', () => {
  // The exact video a live search returned for the query
  // "Soweto Victony ft. Burna Boy official audio". It is embeddable, public, and
  // not the song. `items[0]` accepted it.
  const sowetoRemix = candidate({
    videoId: 'remix00001',
    title: 'Burna Boy - Soweto, Tshwala Bam (Feat. Victony, Rema, Omah Lay, TitoM & Yuppe) REMIX',
    channelTitle: 'Soundkravt Music',
    durationSeconds: 187,
  });

  test('rejects the six-artist remix for a song titled "Soweto"', () => {
    const s = scoreCandidate(
      { title: 'Soweto', artist: 'Victony', durationMs: 165_000 },
      sowetoRemix,
    );
    assert.equal(s.accepted, false);
    // Title overlap is 1.0 here — the word "Soweto" really is in the title. What
    // disqualifies it is the derivative marker, which is why that gate exists:
    // token overlap alone cannot tell a song from a remix of it.
    assert.equal(s.derivative, 'remix');
    assert.equal(s.reason, 'derivative_content');
  });

  test('rejects it against the credited artist as well as the lead one', () => {
    // Victony is credited in the remix title; Burna Boy leads it. Neither
    // ownership should make a six-artist remix acceptable for "Soweto".
    for (const artist of ['Victony', 'Burna Boy']) {
      const s = scoreCandidate({ title: 'Soweto', artist, durationMs: 165_000 }, sowetoRemix);
      assert.equal(s.accepted, false, `must reject for artist ${artist}`);
    }
  });
});

describe('scoreCandidate — hard gates', () => {
  test('a non-embeddable video is rejected before scoring', () => {
    const s = scoreCandidate(
      { title: 'Soweto', artist: 'Burna Boy', durationMs: 165_000 },
      candidate({ embeddable: false }),
    );
    assert.equal(s.reason, 'not_embeddable');
    assert.equal(s.accepted, false);
  });

  test('an unchecked embeddable flag is flagged, not rejected', () => {
    // The channel-enumeration path cannot see `status.embeddable`. A missing
    // lookup is not evidence of a bad match, so it must not silently fail.
    const s = scoreCandidate(
      { title: 'Soweto', artist: 'Burna Boy', durationMs: 165_000 },
      candidate({ embeddable: null }),
    );
    assert.equal(s.needsEmbeddableCheck, true);
    assert.equal(s.accepted, true, 'an unknown embeddability must not be treated as a rejection');
  });

  test('a title from a different song is rejected', () => {
    const s = scoreCandidate(
      { title: 'Soweto', artist: 'Burna Boy', durationMs: 165_000 },
      candidate({ title: 'Last Last', channelTitle: 'Burna Boy' }),
    );
    assert.equal(s.reason, 'title_mismatch');
  });

  test('an unrelated channel and title are rejected even at the right duration', () => {
    const s = scoreCandidate(
      { title: 'Soweto', artist: 'Burna Boy', durationMs: 165_000 },
      candidate({ title: 'Soweto karaoke night', channelTitle: 'RandomFan99' }),
    );
    assert.equal(s.accepted, false);
  });

  test('a remix is allowed when the song itself is a remix', () => {
    const s = scoreCandidate(
      { title: 'Soweto (Remix)', artist: 'Victony', durationMs: 187_000 },
      sowetoRemixFixture(),
    );
    assert.equal(s.derivative, null, 'the marker is part of the song title, so it is not derivative');
    assert.equal(s.accepted, true);
  });

  test('duration drift beyond the threshold is rejected', () => {
    // 2Factor: Spotify says 226s, the video is 184s — a different edit.
    const s = scoreCandidate(
      { title: '2Factor', artist: 'Young Jonn', durationMs: 226_283 },
      candidate({ title: '2Factor', channelTitle: 'Young Jonn', durationSeconds: 184 }),
    );
    assert.equal(s.reason, 'duration_mismatch');
    assert.ok(Math.abs(s.durationDrift!) > STRICT_THRESHOLDS.maxDurationDrift);
  });

  test('duration drift within the threshold is accepted', () => {
    // Turbulence: 150s video vs 145s catalog — inside 15%.
    const s = scoreCandidate(
      { title: 'Turbulence', artist: 'Wizkid', durationMs: 145_492 },
      candidate({ title: 'Turbulence', channelTitle: 'Wizkid', durationSeconds: 150 }),
    );
    assert.equal(s.reason, null);
    assert.equal(s.accepted, true);
  });

  test('an unknown duration is not treated as a mismatch', () => {
    const withUnknownVideo = scoreCandidate(
      { title: 'City Boys', artist: 'Burna Boy', durationMs: null },
      candidate({ title: 'City Boys', channelTitle: 'Burna Boy', durationSeconds: null }),
    );
    const withUnknownCatalog = scoreCandidate(
      { title: 'City Boys', artist: 'Burna Boy', durationMs: null },
      candidate({ title: 'City Boys', channelTitle: 'Burna Boy', durationSeconds: 154 }),
    );
    assert.equal(withUnknownVideo.accepted, true);
    assert.equal(withUnknownVideo.durationKnown, false);
    assert.equal(withUnknownCatalog.accepted, true);
  });

  // Regression: official upload channels concatenate the artist name
  // ("WizkidVEVO"), which tokenizes to a single token that equals no artist
  // token. Without prefix handling, a correct official upload of any single-word
  // artist was rejected by the artist gate.
  test('recognizes an artist name concatenated into an official channel', () => {
    const s = scoreCandidate(
      { title: 'Essence', artist: 'Wizkid', durationMs: 167_000 },
      candidate({ title: 'Wizkid - Essence (Official Video)', channelTitle: 'WizkidVEVO', durationSeconds: 167 }),
    );
    assert.equal(s.artistInChannel, true);
    assert.equal(s.officialChannel, true);
    assert.equal(s.reason, null);
    assert.equal(s.accepted, true);
  });

  test('does not let prefix matching open up arbitrary channels', () => {
    // "Remake Channel" must not read as the artist "Rema".
    const s = scoreCandidate(
      { title: 'Calm Down', artist: 'Rema', durationMs: null },
      candidate({ title: 'Calm Down', channelTitle: 'Remake Channel' }),
    );
    assert.equal(s.artistInChannel, false);
    assert.equal(s.accepted, false);
  });

  test('an unknown artist does not gate on artist presence', () => {
    const s = scoreCandidate(
      { title: 'Untitled Demo', artist: '', durationMs: null },
      candidate({ title: 'Untitled Demo', channelTitle: 'Some Channel' }),
    );
    assert.equal(s.accepted, true);
  });
});

describe('selectBestCandidate', () => {
  const song = { title: 'Soweto', artist: 'Victony', durationMs: 165_000 };

  test('skips a rejected leading result and takes a valid later one', () => {
    const { match } = selectBestCandidate(song, [
      sowetoRemixFixture(),
      candidate({ videoId: 'good000001', title: 'Victony - Soweto (Official Video)', channelTitle: 'Victony' }),
    ]);
    assert.equal(match?.videoId, 'good000001');
  });

  test('returns null when nothing survives, rather than the best invalid one', () => {
    const { match, signals } = selectBestCandidate(song, [sowetoRemixFixture()]);
    assert.equal(match, null);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].accepted, false);
  });

  test('prefers an exact title over a higher-scoring partial', () => {
    const { match } = selectBestCandidate(
      { title: 'Soweto', artist: 'Victony', durationMs: 165_000 },
      [
        candidate({ videoId: 'partial1', title: 'Soweto feat. Someone (Official Video)', channelTitle: 'Victony' }),
        candidate({ videoId: 'exact001', title: 'Soweto', channelTitle: 'Victony' }),
      ],
    );
    assert.equal(match?.videoId, 'exact001');
  });

  test('prefers an official channel when titles are otherwise equal', () => {
    const { match } = selectBestCandidate(
      { title: 'Turbulence', artist: 'Wizkid', durationMs: 145_492 },
      [
        candidate({ videoId: 'fanupload', title: 'Turbulence', channelTitle: 'Some Fan Channel' }),
        candidate({ videoId: 'vevo00001', title: 'Turbulence', channelTitle: 'WizkidVEVO' }),
      ],
    );
    assert.equal(match?.videoId, 'vevo00001');
  });

  test('is deterministic: the same input yields the same video', () => {
    const candidates = [
      candidate({ videoId: 'aaa000001', title: 'Soweto', channelTitle: 'Victony' }),
      candidate({ videoId: 'bbb000002', title: 'Soweto', channelTitle: 'Victony' }),
    ];
    assert.equal(selectBestCandidate(song, candidates).match?.videoId, selectBestCandidate(song, candidates).match?.videoId);
  });

  test('an empty candidate list yields no match', () => {
    assert.equal(selectBestCandidate(song, []).match, null);
  });
});

describe('strictness', () => {
  // 2Factor is the measured case: a 184s video against a 226s catalog duration.
  // Strict rejects it, loose accepts it — which is exactly the trade-off the
  // threshold parameter exists to make explicit and measurable.
  const twoFactor = {
    song: { title: '2Factor', artist: 'Young Jonn', durationMs: 226_283 },
    video: candidate({ title: '2Factor (Official Video)', channelTitle: 'Young Jonn', durationSeconds: 184 }),
  };

  test('strict rejects a drifted duration', () => {
    assert.equal(scoreCandidate(twoFactor.song, twoFactor.video, STRICT_THRESHOLDS).accepted, false);
  });

  test('loose accepts the same candidate, and says so', () => {
    assert.equal(scoreCandidate(twoFactor.song, twoFactor.video, LOOSE_THRESHOLDS).accepted, true);
  });

  test('loose does not disable the embeddable gate', () => {
    const s = scoreCandidate(
      twoFactor.song,
      { ...twoFactor.video, embeddable: false },
      LOOSE_THRESHOLDS,
    );
    assert.equal(s.accepted, false, 'a video the player cannot embed is never acceptable');
  });
});

describe('summarizeRejections', () => {
  test('counts only rejections, most frequent first', () => {
    const signals = [
      // accepted
      scoreCandidate({ title: 'A', artist: 'X', durationMs: null }, candidate({ title: 'A', channelTitle: 'X' })),
      // two different embeddability rejections
      scoreCandidate({ title: 'B', artist: 'X', durationMs: null }, candidate({ title: 'B', embeddable: false })),
      scoreCandidate({ title: 'C', artist: 'X', durationMs: null }, candidate({ title: 'C', embeddable: false })),
      // accepted
      scoreCandidate({ title: 'D', artist: 'X', durationMs: null }, candidate({ title: 'D', channelTitle: 'X' })),
    ];
    assert.deepEqual(summarizeRejections(signals), { not_embeddable: 2 });
  });

  test('reports each distinct rejection reason separately', () => {
    const signals = [
      scoreCandidate({ title: 'Soweto', artist: 'Victony', durationMs: 165_000 }, sowetoRemixFixture()),
      scoreCandidate({ title: 'City Boys', artist: 'Burna Boy', durationMs: null }, candidate({ title: 'Last Last', channelTitle: 'Burna Boy' })),
      scoreCandidate({ title: 'X', artist: 'Y', durationMs: 100_000 }, candidate({ title: 'X', channelTitle: 'Y', durationSeconds: 300 })),
    ];
    const summary = summarizeRejections(signals);
    assert.equal(summary.derivative_content, 1);
    assert.equal(summary.title_mismatch, 1);
    assert.equal(summary.duration_mismatch, 1);
  });
});

// Regression, from the Phase 1 live dry run. A catalog artist named "Dj Chizzy"
// satisfied the artist gate against a DIFFERENT DJ's channel, because the raw
// artist token list contained "dj". The song was a compil DJ's full mix, it
// scored 75 (above the strict threshold of 70), and it would have been written
// to production as the playback source for Chizzy's track.
describe('artist role tokens are not artist identity', () => {
  const chizzyMix = candidate({
    videoId: 'djchizzy00001',
    title: 'Party Mixtape 2026 (Full Mix) DJ 2EFFECTS - Topic',
    channelTitle: 'DJ 2EFFECTS - Topic',
    durationSeconds: 3600,
  });

  test('a role token alone cannot satisfy the artist gate', () => {
    const signals = scoreCandidate(
      { title: '2026 Party Mixtape Vol 4', artist: 'Dj Chizzy', durationMs: 3_600_000 },
      chizzyMix,
    );

    assert.equal(signals.artistInChannel, false, '"dj" in the channel is not Chizzy');
    assert.equal(signals.accepted, false, 'the wrong DJ mix must not become the playback source');
    assert.equal(signals.reason, 'artist_not_found');
  });

  test('the same candidate still matches when the artist name is really present', () => {
    const signals = scoreCandidate(
      { title: '2026 Party Mixtape Vol 4', artist: 'Dj Chizzy', durationMs: 3_600_000 },
      candidate({
        videoId: 'djchizzy00002',
        title: 'Dj Chizzy - 2026 Party Mixtape Vol 4',
        channelTitle: 'DJ Chizzy Official',
        durationSeconds: 3600,
      }),
    );

    assert.equal(signals.artistInChannel, true);
    assert.equal(signals.accepted, true);
  });

  test('an artist name made only of role tokens does not gate on the artist', () => {
    // Nothing meaningful to compare against, so the artist gate must stand
    // aside rather than reject everything. Same treatment as an unknown artist.
    const signals = scoreCandidate(
      { title: 'Amapiano', artist: 'DJ', durationMs: 180_000 },
      candidate({ title: 'Amapiano', channelTitle: 'Some Channel', durationSeconds: 180 }),
    );

    assert.equal(signals.artistInChannel, true);
    assert.equal(signals.accepted, true);
  });

  test('role tokens are dropped from the artist gate but not from title overlap', () => {
    // "Burna Boy" -> identity "burna". A title of just "Boy" must not satisfy
    // the gate, but the word still counts when scoring title overlap.
    const signals = scoreCandidate(
      { title: 'Last Last', artist: 'Burna Boy', durationMs: 165_000 },
      candidate({ title: 'Boy - Last Last', channelTitle: 'Boy Music', durationSeconds: 165 }),
    );

    assert.equal(signals.artistInChannel, false, '"boy" alone is not "Burna Boy"');
    assert.equal(signals.accepted, false);
  });
});

// Shared fixture, declared once and reused by the "song is itself a remix" and
// `selectBestCandidate` cases above.
function sowetoRemixFixture(): MatchCandidate {
  return candidate({
    videoId: 'remix00001',
    title: 'Burna Boy - Soweto, Tshwala Bam (Feat. Victony, Rema, Omah Lay, TitoM & Yuppe) REMIX',
    channelTitle: 'Soundkravt Music',
    durationSeconds: 187,
  });
}