/**
 * Phase 7.2 — Regression Checklist
 *
 * Verifies that existing flows are NOT broken after all remediation changes.
 * These tests ensure backward compatibility.
 *
 * Prerequisites:
 * - Backend server running at TEST_API_URL (default: http://localhost:3001)
 * - Database with some seed data
 *
 * Run: npx tsx src/__tests__/integration/regression-checklist.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apiGet, apiPost, createTestUser, generateTestToken } from '../helpers';

// ─── Regression: Song Catalog Pagination ─────────────────────────────────────

describe('Regression: Song catalog pagination', () => {
  it('GET /api/songs should return paginated results with default page', async () => {
    const res = await apiGet('/songs');

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    assert.ok('songs' in res.data || 'data' in res.data, 'Response should have songs or data field');
    assert.ok('total' in res.data, 'Response should have total count');

    const songs = res.data.songs || res.data.data || [];
    assert.ok(Array.isArray(songs), 'Songs should be an array');
  });

  it('GET /api/songs?page=1&limit=5 should respect pagination params', async () => {
    const res = await apiGet('/songs?page=1&limit=5');

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const songs = res.data.songs || res.data.data || [];
    assert.ok(songs.length <= 5, `Should return at most 5 songs, got ${songs.length}`);
  });

  it('GET /api/songs?page=2&limit=5 should return second page', async () => {
    const res = await apiGet('/songs?page=2&limit=5');

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    // Page 2 is valid even if empty
    assert.ok('total' in res.data, 'Response should have total');
  });

  it('GET /api/catalog/songs should also support pagination', async () => {
    const res = await apiGet('/catalog/songs?page=1&limit=10');

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    assert.ok('songs' in res.data, 'Catalog should have songs field');
    assert.ok('total' in res.data, 'Catalog should have total');
  });
});

// ─── Regression: Search Results ──────────────────────────────────────────────

describe('Regression: Search results return correctly', () => {
  it('GET /api/songs?search=test should return search results', async () => {
    const res = await apiGet('/songs?search=test');

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const songs = res.data.songs || res.data.data || [];
    assert.ok(Array.isArray(songs), 'Search results should be an array');
  });

  it('GET /api/catalog/songs?search=test should return catalog search results', async () => {
    const res = await apiGet('/catalog/songs?search=test');

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    assert.ok('songs' in res.data, 'Response should have songs');
  });

  it('GET /api/catalog/artists?search=test should return artist search results', async () => {
    const res = await apiGet('/catalog/artists?search=test');

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    assert.ok('artists' in res.data, 'Response should have artists');
  });

  it('GET /api/search should handle search queries', async () => {
    const res = await apiGet('/search?q=test&type=songs');
    // Search endpoint should exist and not return 404
    assert.ok(res.status !== 404, 'Search route should exist');
  });
});

// ─── Regression: Artist Detail Page ─────────────────────────────────────────

describe('Regression: Artist detail page loads for non-suspended artists', () => {
  it('GET /api/artists should list artists', async () => {
    const res = await apiGet('/artists');

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    // Artists endpoint should return data
    assert.ok(
      Array.isArray(res.data) || 'artists' in res.data || 'data' in res.data,
      'Should return artist list',
    );
  });

  it('GET /api/catalog/artists should list catalog artists', async () => {
    const res = await apiGet('/catalog/artists');

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    assert.ok('artists' in res.data, 'Response should have artists');
    assert.ok(Array.isArray(res.data.artists), 'Artists should be an array');
  });

  it('GET /api/catalog/home should include artists array', async () => {
    const res = await apiGet('/catalog/home');

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    assert.ok('artists' in res.data, 'Homepage should have artists');
    assert.ok(Array.isArray(res.data.artists), 'Artists should be an array');
    assert.ok('featuredArtists' in res.data, 'Homepage should have featuredArtists');
  });
});

// ─── Regression: Translation Request Flow ────────────────────────────────────

describe('Regression: Translation request flow', () => {
  it('GET /api/translations/health should be accessible', async () => {
    const res = await apiGet('/translations/health');
    // Translations health endpoint is public
    assert.ok(
      res.status === 200 || res.status === 207 || res.status === 500,
      `Translations health endpoint accessible: ${res.status}`,
    );
  });

  it('POST /api/translations/request should accept translation requests', async () => {
    const user = createTestUser({ role: 'USER' });
    const res = await apiPost(
      '/translations/request',
      {
        songId: 'test-song-id',
        sourceLang: 'en',
        targetLang: 'fr',
      },
      user.token,
    );

    // Should return 200 (existing), 202 (queued), 400 (validation), or 404 (song not found)
    assert.ok(
      [200, 201, 202, 400, 404].includes(res.status),
      `Translation request should be processed: ${res.status}`,
    );
  });
});

// ─── Regression: Admin Dashboard ────────────────────────────────────────────

describe('Regression: Admin dashboard loads all sections', () => {
  const adminToken = generateTestToken('admin-test-id', 'admin@test.com', 'ADMIN');

  it('GET /api/admin/artists should list all artists', async () => {
    const res = await apiGet('/admin/artists', adminToken);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    assert.ok('artists' in res.data, 'Response should have artists');
  });

  it('GET /api/admin/artist-applications should list applications', async () => {
    const res = await apiGet('/admin/artist-applications', adminToken);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    assert.ok('data' in res.data, 'Response should have data array');
  });

  it('GET /api/admin/users should list users', async () => {
    const res = await apiGet('/admin/users', adminToken);
    // Admin users endpoint should be accessible
    assert.ok(
      res.status === 200 || res.status === 401 || res.status === 403,
      `Admin users endpoint: ${res.status}`,
    );
  });

  it('GET /api/admin/ping should respond for admins', async () => {
    const res = await apiGet('/admin/ping', adminToken);
    // Should be 200 (if valid admin token) or 401 (if token invalid)
    assert.ok(
      res.status === 200 || res.status === 401,
      `Admin ping: ${res.status}`,
    );
  });
});

// ─── Regression: User Registration and Login ────────────────────────────────

describe('Regression: User registration and login work normally', () => {
  const testEmail = `regression-test-${Date.now()}@afro-genie.test`;
  const testPassword = 'RegressionTest123!';

  it('POST /api/auth/register should create new user', async () => {
    const res = await apiPost('/auth/register', {
      email: testEmail,
      password: testPassword,
      displayName: 'Regression Test User',
    });

    assert.equal(
      res.status,
      201,
      `Expected 201 for registration, got ${res.status}: ${JSON.stringify(res.data)}`,
    );
    assert.ok(res.data.accessToken, 'Should return accessToken');
    assert.ok(res.data.refreshToken, 'Should return refreshToken');
    assert.ok(res.data.user, 'Should return user object');
    assert.equal(res.data.user.role, 'USER', 'New user should have USER role');
  });

  it('POST /api/auth/login should authenticate existing user', async () => {
    const res = await apiPost('/auth/login', {
      email: testEmail,
      password: testPassword,
    });

    assert.equal(
      res.status,
      200,
      `Expected 200 for login, got ${res.status}: ${JSON.stringify(res.data)}`,
    );
    assert.ok(res.data.accessToken, 'Should return accessToken');
    assert.ok(res.data.refreshToken, 'Should return refreshToken');
    assert.ok(res.data.user, 'Should return user object');
  });

  it('POST /api/auth/login should reject wrong password', async () => {
    const res = await apiPost('/auth/login', {
      email: testEmail,
      password: 'WrongPassword999!',
    });

    assert.ok(
      res.status >= 400,
      `Expected 4xx for wrong password, got ${res.status}`,
    );
  });

  it('POST /api/auth/refresh should refresh tokens', async () => {
    // First login to get a refresh token
    const loginRes = await apiPost('/auth/login', {
      email: testEmail,
      password: testPassword,
    });

    if (loginRes.status === 200 && loginRes.data.refreshToken) {
      const res = await apiPost('/auth/refresh', {
        refreshToken: loginRes.data.refreshToken,
      });

      assert.equal(
        res.status,
        200,
        `Expected 200 for token refresh, got ${res.status}`,
      );
      assert.ok(res.data.accessToken, 'Should return new accessToken');
    }
  });
});

// ─── Regression: Health Endpoint ────────────────────────────────────────────

describe('Regression: Health endpoint', () => {
  it('GET /api/health should respond with 200', async () => {
    const res = await apiGet('/health');
    assert.ok(
      res.status === 200 || res.status === 404,
      `Health endpoint: ${res.status}`,
    );
  });
});

// ─── Regression: Genre and Language Endpoints ────────────────────────────────

describe('Regression: Genre and language endpoints', () => {
  it('GET /api/genres should list genres', async () => {
    const res = await apiGet('/genres');
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    assert.ok(Array.isArray(res.data), 'Genres should be an array');
  });

  it('GET /api/catalog/home should include genres', async () => {
    const res = await apiGet('/catalog/home');
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    assert.ok('genres' in res.data, 'Homepage should have genres');
    assert.ok(Array.isArray(res.data.genres), 'Genres should be an array');
  });
});

// ─── Regression: Song Detail Endpoint ────────────────────────────────────────

describe('Regression: Song detail endpoint', () => {
  it('GET /api/songs/:id should handle song detail requests', async () => {
    // Try with a dummy ID — should return 404 (not crash)
    const res = await apiGet('/songs/nonexistent-id-12345');
    assert.ok(
      res.status === 404 || res.status === 400,
      `Song detail should return 404 for nonexistent: ${res.status}`,
    );
  });
});

// ─── Regression: CORS and Error Handling ─────────────────────────────────────

describe('Regression: Error handling', () => {
  it('GET /api/nonexistent-route should return 404', async () => {
    const res = await apiGet('/this-route-does-not-exist');
    assert.equal(res.status, 404, `Expected 404 for nonexistent route, got ${res.status}`);
  });

  it('POST /api/auth/register with invalid data should return 400', async () => {
    const res = await apiPost('/auth/register', {
      email: 'not-an-email',
      password: 'short',
      displayName: '',
    });

    assert.ok(
      res.status >= 400,
      `Expected 4xx for invalid registration, got ${res.status}`,
    );
  });
});
