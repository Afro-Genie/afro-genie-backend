import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import {
  buildActiveSongTitleWhere,
  buildSongDetailWhere,
  buildSongWhere,
  shouldCheckSongDuplicateForUpdate,
} from '../src/services/songService';

describe('admin song catalog helpers', () => {
  test('public song lists exclude unreleased imported songs', () => {
    const where = buildSongWhere({ artistId: 'artist-1' });
    const conditions = where.AND as Prisma.SongWhereInput[];

    assert.deepEqual(conditions?.[0]?.OR, [
      { audioUrl: null },
      { released: true },
    ]);
    assert.equal(where.artistId, 'artist-1');
  });

  test('admin song lists include unreleased songs while keeping filters', () => {
    const where = buildSongWhere(
      { genre: 'Afrobeats', search: 'Amapiano' },
      true,
    );

    assert.equal('AND' in where, false);
    assert.deepEqual(where.artist, { suspended: false });
    assert.deepEqual(where.genres, {
      some: {
        genre: {
          name: {
            equals: 'Afrobeats',
            mode: Prisma.QueryMode.insensitive,
          },
        },
      },
    });

    const searchConditions = where.OR as Prisma.SongWhereInput[];
    assert.deepEqual(searchConditions[0], {
      title: { contains: 'Amapiano', mode: Prisma.QueryMode.insensitive },
    });
    assert.equal(searchConditions.length, 3);
  });

  test('admin song detail lookups can include unreleased songs', () => {
    const publicWhere = buildSongDetailWhere('song-1');
    const adminWhere = buildSongDetailWhere('song-1', true);

    assert.deepEqual(publicWhere.OR, [
      { audioUrl: null },
      { released: true },
    ]);
    assert.equal(publicWhere.softDeleted, false);
    assert.deepEqual(adminWhere, { id: 'song-1', softDeleted: false });
    assert.equal('OR' in adminWhere, false);
  });

  test('a song edit that changes the artist by name checks for duplicates', () => {
    assert.equal(shouldCheckSongDuplicateForUpdate({ artistName: 'Rema' }), true);
    assert.equal(shouldCheckSongDuplicateForUpdate({ artistName: '  Rema  ' }), true);
    assert.equal(shouldCheckSongDuplicateForUpdate({ title: 'Renamed Song' }), true);
    assert.equal(shouldCheckSongDuplicateForUpdate({ releaseYear: 2025 }), false);
  });

  test('active song title duplicate checks ignore soft-deleted songs', () => {
    assert.deepEqual(buildActiveSongTitleWhere('Song', 'artist-1'), {
      title: 'Song',
      artistId: 'artist-1',
      softDeleted: false,
    });
    assert.deepEqual(buildActiveSongTitleWhere('Song', 'artist-1', 'song-1'), {
      id: { not: 'song-1' },
      title: 'Song',
      artistId: 'artist-1',
      softDeleted: false,
    });
  });
});
