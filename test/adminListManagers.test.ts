import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { buildGenreWhere, buildGenreOrderBy } from '../src/routes/admin/genres';
import { buildUserWhere, buildUserOrderBy } from '../src/routes/admin/users';
import { buildAdminArtistWhere, buildAdminArtistOrderBy } from '../src/routes/admin/artists';
import { buildTopicWhere, buildTopicOrderBy } from '../src/services/communityService';

describe('admin genre list helpers', () => {
  test('no search returns an unfiltered where', () => {
    assert.deepEqual(buildGenreWhere(), {});
    assert.deepEqual(buildGenreWhere('   '), {});
  });

  test('search matches genre names case-insensitively and trims input', () => {
    assert.deepEqual(buildGenreWhere('  Afro '), {
      name: { contains: 'Afro', mode: Prisma.QueryMode.insensitive },
    });
  });

  test('default order is name ascending; songs sorts by linked song count', () => {
    assert.deepEqual(buildGenreOrderBy(), { name: 'asc' });
    assert.deepEqual(buildGenreOrderBy('name', 'desc'), { name: 'desc' });
    assert.deepEqual(buildGenreOrderBy('songs', 'desc'), { songs: { _count: 'desc' } });
    assert.deepEqual(buildGenreOrderBy('songs'), { songs: { _count: 'asc' } });
  });
});

describe('admin user list helpers', () => {
  test('search covers email and displayName', () => {
    assert.deepEqual(buildUserWhere({ search: 'rema' }), {
      OR: [
        { email: { contains: 'rema', mode: Prisma.QueryMode.insensitive } },
        { displayName: { contains: 'rema', mode: Prisma.QueryMode.insensitive } },
      ],
    });
  });

  test('role filter combines with search', () => {
    assert.deepEqual(buildUserWhere({ search: 'rema', role: 'ADMIN' }), {
      OR: [
        { email: { contains: 'rema', mode: Prisma.QueryMode.insensitive } },
        { displayName: { contains: 'rema', mode: Prisma.QueryMode.insensitive } },
      ],
      role: 'ADMIN',
    });
    assert.deepEqual(buildUserWhere({}), {});
  });

  test('order defaults to newest first with a stable tiebreaker', () => {
    assert.deepEqual(buildUserOrderBy(), [{ createdAt: 'desc' }, { id: 'desc' }]);
    assert.deepEqual(buildUserOrderBy('displayName', 'asc'), [{ displayName: 'asc' }, { id: 'desc' }]);
    assert.deepEqual(buildUserOrderBy('lastLoginAt', 'desc'), [{ lastLoginAt: 'desc' }, { id: 'desc' }]);
    assert.deepEqual(buildUserOrderBy('bogus', 'asc'), [{ createdAt: 'asc' }, { id: 'desc' }]);
  });
});

describe('admin artist list helpers', () => {
  test('search covers artist name and linked account email', () => {
    assert.deepEqual(buildAdminArtistWhere({ search: 'asake' }), {
      OR: [
        { name: { contains: 'asake', mode: Prisma.QueryMode.insensitive } },
        { user: { email: { contains: 'asake', mode: Prisma.QueryMode.insensitive } } },
      ],
    });
  });

  test('genre and status filters combine', () => {
    assert.deepEqual(buildAdminArtistWhere({ genre: 'Afrobeats', verified: 'true', suspended: 'false' }), {
      genres: { has: 'Afrobeats' },
      verified: true,
      suspended: false,
    });
    assert.deepEqual(buildAdminArtistWhere({ isFeatured: 'true' }), { isFeatured: true });
    assert.deepEqual(buildAdminArtistWhere({}), {});
  });

  test('order supports scalar fields and song counts', () => {
    assert.deepEqual(buildAdminArtistOrderBy(), { createdAt: 'desc' });
    assert.deepEqual(buildAdminArtistOrderBy('name', 'asc'), { name: 'asc' });
    assert.deepEqual(buildAdminArtistOrderBy('followers', 'asc'), { followers: 'asc' });
    assert.deepEqual(buildAdminArtistOrderBy('songs', 'desc'), { songs: { _count: 'desc' } });
  });
});

describe('community topic list helpers', () => {
  test('base where always excludes soft-deleted topics', () => {
    assert.deepEqual(buildTopicWhere({}), { softDeleted: false });
    assert.deepEqual(buildTopicWhere({ categoryId: 'cat-1' }), {
      forumCategoryId: 'cat-1',
      softDeleted: false,
    });
  });

  test('search covers title, content, and author name', () => {
    assert.deepEqual(buildTopicWhere({ search: 'burna' }), {
      softDeleted: false,
      OR: [
        { title: { contains: 'burna', mode: Prisma.QueryMode.insensitive } },
        { content: { contains: 'burna', mode: Prisma.QueryMode.insensitive } },
        { author: { displayName: { contains: 'burna', mode: Prisma.QueryMode.insensitive } } },
      ],
    });
  });

  test('explicit sortBy wins over legacy sort', () => {
    assert.deepEqual(buildTopicOrderBy({ sortBy: 'commentCount', sortOrder: 'desc' }), { commentCount: 'desc' });
    assert.deepEqual(buildTopicOrderBy({ sortBy: 'likes', sortOrder: 'asc' }), { likes: 'asc' });
    assert.deepEqual(buildTopicOrderBy({ sortBy: 'title', sortOrder: 'asc' }), { title: 'asc' });
    assert.deepEqual(buildTopicOrderBy({ sortBy: 'createdAt', sort: 'top' }), { createdAt: 'desc' });
  });

  test('legacy sort values keep their previous behavior', () => {
    assert.deepEqual(buildTopicOrderBy({ sort: 'new' }), { createdAt: 'desc' });
    assert.deepEqual(buildTopicOrderBy({ sort: 'top' }), { likes: 'desc' });
    assert.deepEqual(buildTopicOrderBy({}), { likes: 'desc' });
  });
});
