import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AFRICAN_GENRE_SEARCH_QUERIES,
  YOUTUBE_AFRICAN_CHANNELS,
  YOUTUBE_AFRICAN_PLAYLIST_ARTISTS,
  classifyAfricanGenres,
  getAvailableYouTubeCatalogSources,
  isEligibleYouTubeMusicVideo,
  normalizeVideoTitle,
  validateYouTubeChannelAllowlist,
  validateYouTubePlaylistArtists,
  type YouTubeCatalogChannel,
} from '../scripts/youtubeCatalogPolicy';

const channel: YouTubeCatalogChannel = {
  channelId: 'UC1234567890123456789012',
  artistName: 'Test Artist',
  countryCode: 'NG',
  originBasis: 'nationality',
  sourceType: 'official-biography',
  sourceTitle: 'Artist biography',
  sourceUrl: 'https://example.com/artist-biography',
  reviewedAt: '2026-01-01',
  rationale: 'The official biography documents Nigerian nationality.',
  genres: ['Afrobeats'],
};

const video = {
  videoId: 'abcdefghijk',
  channelId: channel.channelId,
  title: 'Test Artist - New Song (Official Music Video)',
  categoryId: '10',
  embeddable: true,
  durationSeconds: 180,
  publishedAt: '2025-01-01T00:00:00Z',
};

describe('YouTube African catalog policy', () => {
  test('starts default-deny without evidence-backed official channels', () => {
    assert.deepEqual(YOUTUBE_AFRICAN_CHANNELS, []);
    assert.equal(isEligibleYouTubeMusicVideo(video, undefined), false);
  });

  test('maps only exact African genre tags and qualified Dancehall', () => {
    assert.deepEqual(
      classifyAfricanGenres(['AFROBEATS', 'Coupé-Décalé', 'Naija Dancehall', 'Dancehall', 'western pop']),
      ['Afrobeats', 'Coupé-Décalé', 'Dancehall'],
    );
    assert.deepEqual(classifyAfricanGenres(['Dancehall', 'Reggae', 'Pop']), []);
    assert.deepEqual(
      classifyAfricanGenres(['Naija Rap', 'African hip-hop', 'Nigerian Rap']),
      ['African Hip-Hop'],
    );
  });

  test('matches playlist inclusion by configured artist channel ID, not arbitrary name text', () => {
    const asake = YOUTUBE_AFRICAN_PLAYLIST_ARTISTS.find(artist => artist.artistName === 'Asake');
    assert.ok(asake);
    assert.equal(isEligibleYouTubeMusicVideo(
      { ...video, channelId: asake.channelId },
      asake,
    ), true);
    assert.equal(isEligibleYouTubeMusicVideo(
      { ...video, channelId: 'UC9999999999999999999999' },
      asake,
    ), false);
  });

  test('requires an allowlisted channel and a playable music video', () => {
    assert.equal(isEligibleYouTubeMusicVideo(video, channel), true);
    assert.equal(isEligibleYouTubeMusicVideo({ ...video, channelId: 'UC9999999999999999999999' }, channel), false);
    assert.equal(isEligibleYouTubeMusicVideo({ ...video, categoryId: '22' }, channel), false);
    assert.equal(isEligibleYouTubeMusicVideo({ ...video, embeddable: false }, channel), false);
    assert.equal(isEligibleYouTubeMusicVideo({ ...video, durationSeconds: 20 }, channel), false);
  });

  test('removes artist and official-upload suffixes from titles', () => {
    assert.equal(
      normalizeVideoTitle('Test Artist - New Song (Official Music Video)', 'Test Artist'),
      'New Song',
    );
    assert.equal(normalizeVideoTitle('New Song - Test Artist Official Audio', 'Test Artist'), 'New Song');
    assert.equal(normalizeVideoTitle('Official Music Video', 'Test Artist'), '');
  });

  test('rejects invalid and duplicate channel evidence', () => {
    const entry = {
      ...channel,
      channelId: 'UC1234567890123456789012',
    };
    assert.throws(() => validateYouTubeChannelAllowlist([{ ...entry, countryCode: 'US' }]), /African ISO country code/);
    assert.throws(() => validateYouTubeChannelAllowlist([{ ...entry, genres: ['Pop'] }]), /unsupported genres/);
    assert.throws(() => validateYouTubeChannelAllowlist([entry, entry]), /Duplicate YouTube channel ID/);
  });

  test('rejects non-African or unsupported playlist artist rules', () => {
    const entry = YOUTUBE_AFRICAN_PLAYLIST_ARTISTS[0];
    assert.throws(
      () => validateYouTubePlaylistArtists([{ ...entry, countryCode: 'US' }]),
      /African ISO country code/,
    );
    assert.throws(
      () => validateYouTubePlaylistArtists([{ ...entry, genres: ['Pop'] }]),
      /unsupported genres/,
    );
    assert.throws(
      () => validateYouTubePlaylistArtists([entry, entry]),
      /Duplicate YouTube playlist artist channel ID/,
    );
  });

  test('queries only explicitly categorized African music genres', () => {
    assert.ok(AFRICAN_GENRE_SEARCH_QUERIES.some(query => query.genre === 'Afrobeats'));
    assert.ok(AFRICAN_GENRE_SEARCH_QUERIES.some(query => query.query === 'african dancehall'));
    assert.equal(AFRICAN_GENRE_SEARCH_QUERIES.some(query => query.query === 'pop'), false);
  });

  test('exposes only genres with configured African artist channels', () => {
    const sources = getAvailableYouTubeCatalogSources();
    assert.ok(sources.genres.includes('Afrobeats'));
    assert.ok(sources.artists.some((artist) => artist.name === 'Asake'));
    assert.equal(sources.genres.includes('Fuji'), false);
    assert.equal(sources.genres.includes('Afropop'), false);
  });
});
