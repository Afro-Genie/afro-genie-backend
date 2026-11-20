import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../src/lib/env';
import {
  discoverYouTubeSearch,
  discoverYouTubePlaylist,
  estimateYouTubeCatalogQuota,
  parseYouTubePlaylistId,
  resolveYouTubeCatalogImportSource,
} from '../src/services/youtubeCatalogImportService';

describe('YouTube catalog import inputs', () => {
  test('accepts a playlist ID or supported YouTube playlist URL', () => {
    assert.equal(parseYouTubePlaylistId('PL1234567890'), 'PL1234567890');
    assert.equal(
      parseYouTubePlaylistId('https://www.youtube.com/playlist?list=PL1234567890'),
      'PL1234567890',
    );
  });

  test('rejects non-YouTube URLs and missing playlist IDs', () => {
    assert.throws(
      () => parseYouTubePlaylistId('https://example.com/playlist?list=PL1234567890'),
      /must be from YouTube/,
    );
    assert.throws(
      () => parseYouTubePlaylistId('https://www.youtube.com/watch?v=abcdefghijk'),
      /must include a valid playlist ID/,
    );
  });

  test('search sources accept known or new artists and approved African genres', () => {
    assert.deepEqual(resolveYouTubeCatalogImportSource('artist', '  aSaKe  '), {
      type: 'artist',
      value: 'Asake',
      maxResults: 50,
    });
    assert.deepEqual(resolveYouTubeCatalogImportSource('genre', 'afro beats'), {
      type: 'genre',
      value: 'Afrobeats',
      maxResults: 50,
    });
    assert.deepEqual(resolveYouTubeCatalogImportSource('artist', 'unknown artist'), {
      type: 'artist',
      value: 'unknown artist',
      maxResults: 50,
    });
    assert.throws(
      () => resolveYouTubeCatalogImportSource('genre', 'western pop'),
      /not an approved African music genre/,
    );
  });

  test('search quota estimates stay within one search and one details call', () => {
    assert.deepEqual(
      estimateYouTubeCatalogQuota(resolveYouTubeCatalogImportSource('song', 'African song title')),
      {
        estimatedUnits: 101,
        maxUnits: 101,
        searchListCalls: 1,
        playlistItemsListCalls: 0,
        videosListCalls: 1,
      },
    );
    assert.equal(
      estimateYouTubeCatalogQuota(resolveYouTubeCatalogImportSource('playlist', 'PL1234567890', 80)).maxUnits,
      160,
    );
  });

  test('song search excludes unreviewed channels and reports them for review', async () => {
    const savedKey = env.YOUTUBE_API_KEY;
    const savedFetch = globalThis.fetch;
    const approvedChannelId = 'UCCjfbcoH0ZYT0r1jScDHJMg';
    const unreviewedChannelId = `UC${'x'.repeat(22)}`;
    env.YOUTUBE_API_KEY = 'test-placeholder-key';
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('/search')) {
        return new Response(JSON.stringify({
          items: [
            {
              id: { videoId: 'abcdefghijk' },
              snippet: {
                channelId: approvedChannelId,
                channelTitle: 'Asake',
                title: 'Asake - Lonely at the Top (Official Video)',
              },
            },
            {
              id: { videoId: 'lmnopqrstuv' },
              snippet: {
                channelId: unreviewedChannelId,
                channelTitle: 'Unreviewed Artist',
                title: 'Unknown African Track',
              },
            },
          ],
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/videos')) {
        return new Response(JSON.stringify({
          items: [{
            id: 'abcdefghijk',
            snippet: { title: 'Asake - Lonely at the Top (Official Video)', categoryId: '10', channelId: approvedChannelId },
            contentDetails: { duration: 'PT3M0S' },
            status: { embeddable: true },
          }],
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected YouTube endpoint: ${url.pathname}`);
    };

    try {
      const result = await discoverYouTubeSearch('song', 'Lonely at the Top', 50);
      assert.deepEqual(result.candidates.map((candidate) => candidate.video.videoId), ['abcdefghijk']);
      assert.equal(result.discovery.rejectedChannel, 1);
      assert.deepEqual(result.discovery.unreviewedChannels, [{
        channelId: unreviewedChannelId,
        channelTitle: 'Unreviewed Artist',
        videos: 1,
        sampleTitles: ['Unknown African Track'],
      }]);
    } finally {
      env.YOUTUBE_API_KEY = savedKey;
      globalThis.fetch = savedFetch;
    }
  });

  test('playlist discovery checkpoints each completed page and resumes at its next token', async () => {
    const savedKey = env.YOUTUBE_API_KEY;
    const savedFetch = globalThis.fetch;
    const channelId = 'UCCjfbcoH0ZYT0r1jScDHJMg';
    const checkpoints: Array<{ candidates: Array<{ video: { videoId: string } }>; nextPageToken: string | null }> = [];
    env.YOUTUBE_API_KEY = 'test-placeholder-key';
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('/playlistItems')) {
        const secondPage = url.searchParams.get('pageToken') === 'next-page';
        const videoId = secondPage ? 'lmnopqrstuv' : 'abcdefghijk';
        const payload = {
          items: [{
            snippet: {
              resourceId: { videoId },
              videoOwnerChannelId: channelId,
              videoOwnerChannelTitle: 'Asake',
              title: `Asake - Song ${secondPage ? 'Two' : 'One'}`,
            },
          }],
          ...(!secondPage ? { nextPageToken: 'next-page' } : {}),
        };
        return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname.endsWith('/videos')) {
        const id = url.searchParams.get('id')?.split(',')[0] || '';
        return new Response(JSON.stringify({
          items: [{
            id,
            snippet: {
              title: `Asake - Song ${id === 'abcdefghijk' ? 'One' : 'Two'}`,
              categoryId: '10',
              channelId,
            },
            contentDetails: { duration: 'PT3M0S' },
            status: { embeddable: true },
          }],
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected YouTube endpoint: ${url.pathname}`);
    };

    try {
      const firstPage = await discoverYouTubePlaylist(
        'PL1234567890',
        1,
        undefined,
        undefined,
        (checkpoint) => { checkpoints.push(checkpoint); },
      );
      assert.equal(firstPage.complete, false);
      assert.equal(firstPage.nextPageToken, 'next-page');
      assert.deepEqual(checkpoints[0].candidates.map((candidate) => candidate.video.videoId), ['abcdefghijk']);
      assert.equal(checkpoints[0].nextPageToken, 'next-page');

      const resumed = await discoverYouTubePlaylist('PL1234567890', 1, undefined, firstPage.nextPageToken || undefined);
      assert.equal(resumed.complete, true);
      assert.deepEqual(resumed.candidates.map((candidate) => candidate.video.videoId), ['lmnopqrstuv']);
    } finally {
      env.YOUTUBE_API_KEY = savedKey;
      globalThis.fetch = savedFetch;
    }
  });
});
