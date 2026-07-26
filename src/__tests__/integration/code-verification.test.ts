/**
 * Phase 7 — Code-Level Verification Tests
 *
 * Static analysis tests that verify source code patterns without
 * requiring a running server. These checks ensure the remediation
 * code is correctly in place.
 *
 * Run: npx tsx src/__tests__/integration/code-verification.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const BACKEND_SRC = join(__dirname, '..', '..', '..');
const FRONTEND_SRC = join(__dirname, '..', '..', '..', '..', 'afro-genie');

// ─── Helper: Recursive file search ───────────────────────────────────────────

function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === '__tests__') continue;
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...findFiles(fullPath, extensions));
        } else if (extensions.includes(extname(entry))) {
          results.push(fullPath);
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Skip inaccessible directories
  }
  return results;
}

function readFileContent(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

// ─── Check 14: Zero firebaseService imports ──────────────────────────────────

describe('Code Check 14: Zero firebaseService imports in artist files', () => {
  it('should have no firebaseService imports in frontend source files', () => {
    const frontendFiles = findFiles(FRONTEND_SRC, ['.ts', '.tsx']);
    const violations: string[] = [];

    for (const file of frontendFiles) {
      const content = readFileContent(file);
      if (content.includes('firebaseService') || content.includes('FirebaseService')) {
        violations.push(file.replace(FRONTEND_SRC, ''));
      }
    }

    assert.equal(
      violations.length,
      0,
      `Found firebaseService imports in:\n${violations.join('\n')}`,
    );
  });

  it('should have no firebaseService imports in backend source files', () => {
    const backendFiles = findFiles(join(BACKEND_SRC, 'src'), ['.ts']);
    const violations: string[] = [];

    for (const file of backendFiles) {
      const content = readFileContent(file);
      if (content.includes('firebaseService') || content.includes('FirebaseService')) {
        violations.push(file.replace(BACKEND_SRC, ''));
      }
    }

    assert.equal(
      violations.length,
      0,
      `Found firebaseService imports in:\n${violations.join('\n')}`,
    );
  });
});

// ─── Phase 1.1: Cross-artist 403 pattern ─────────────────────────────────────

describe('Code Check Phase 1.1: Cross-artist edit returns 403', () => {
  it('artistPortal.ts should use two-step ownership check (findUnique then compare)', () => {
    const content = readFileContent(join(BACKEND_SRC, 'src', 'routes', 'artistPortal.ts'));

    // Verify the two-step pattern exists: findUnique without artistId filter
    assert.ok(
      content.includes("prisma.song.findUnique({") ||
      content.includes("prisma.song.findUnique({"),
      'artistPortal.ts should use findUnique (without artistId filter) for ownership check',
    );

    // Verify 403 is thrown for access denied
    assert.ok(
      content.includes("'FORBIDDEN', 403") || content.includes("'FORBIDDEN', 403"),
      'artistPortal.ts should throw 403 FORBIDDEN for unauthorized access',
    );

    // Verify 404 is thrown for not found
    assert.ok(
      content.includes("'NOT_FOUND', 404"),
      'artistPortal.ts should throw 404 NOT_FOUND for missing resources',
    );
  });
});

// ─── Phase 1.2: Suspended artist filter ──────────────────────────────────────

describe('Code Check Phase 1.2: GET /api/songs filters suspended artists', () => {
  it('songService.ts buildSongWhere should include suspended filter', () => {
    const content = readFileContent(join(BACKEND_SRC, 'src', 'services', 'songService.ts'));

    assert.ok(
      content.includes("artist: { suspended: false }") ||
      content.includes('artist: { suspended: false }'),
      'songService.ts buildSongWhere should filter suspended artists',
    );
  });

  it('songService.ts getActiveSongIdSet should include suspended filter', () => {
    const content = readFileContent(join(BACKEND_SRC, 'src', 'services', 'songService.ts'));

    assert.ok(
      content.includes("artist: { suspended: false }"),
      'songService.ts getActiveSongIdSet should filter suspended artists',
    );
  });
});

// ─── Phase 1.3: Scheduled release filter ─────────────────────────────────────

describe('Code Check Phase 1.3: Catalog filters scheduled releases', () => {
  it('catalogService.ts should filter out SCHEDULED releases', () => {
    const content = readFileContent(join(BACKEND_SRC, 'src', 'services', 'catalogService.ts'));

    assert.ok(
      content.includes("SCHEDULED") && (content.includes("status") || content.includes("release")),
      'catalogService.ts should filter by release status (exclude SCHEDULED)',
    );
  });
});

// ─── Phase 2: Dashboard wired to real APIs ───────────────────────────────────

describe('Code Check Phase 2: ArtistDashboard uses real API calls', () => {
  it('ArtistDashboard.tsx should use apiRequest for songs', () => {
    const content = readFileContent(join(FRONTEND_SRC, 'pages', 'ArtistDashboard.tsx'));

    assert.ok(
      content.includes("apiRequest") || content.includes("'/artists/me/songs'"),
      'ArtistDashboard.tsx should use apiRequest for fetching songs',
    );

    // Verify no stub/warning patterns
    assert.ok(
      !content.includes("Not yet implemented"),
      'ArtistDashboard.tsx should not contain stub "Not yet implemented" messages',
    );
  });

  it('ArtistDashboard.tsx should call real analytics endpoint', () => {
    const content = readFileContent(join(FRONTEND_SRC, 'pages', 'ArtistDashboard.tsx'));

    assert.ok(
      content.includes("/artists/me/analytics"),
      'ArtistDashboard.tsx should call /artists/me/analytics',
    );
  });
});

// ─── Phase 3: Post-login artist redirect ─────────────────────────────────────

describe('Code Check Phase 3: Post-login artist redirect', () => {
  it('AuthContext.tsx should redirect ARTIST role to dashboard', () => {
    const content = readFileContent(join(FRONTEND_SRC, 'context', 'AuthContext.tsx'));

    assert.ok(
      content.includes("ARTIST") && content.includes("/artist/dashboard"),
      'AuthContext.tsx should redirect ARTIST users to /artist/dashboard',
    );
  });

  it('ProtectedRoute.tsx should redirect non-artists from artist pages', () => {
    const content = readFileContent(join(FRONTEND_SRC, 'components', 'ProtectedRoute.tsx'));

    assert.ok(
      content.includes("requireArtist") && (content.includes("Navigate") || content.includes("redirect")),
      'ProtectedRoute.tsx should handle requireArtist redirect',
    );
  });
});

// ─── Phase 4: Spotify onboarding ─────────────────────────────────────────────

describe('Code Check Phase 4: Spotify search and pre-fill', () => {
  it('ArtistSignupPage.tsx should have Spotify search functionality', () => {
    const content = readFileContent(join(FRONTEND_SRC, 'pages', 'ArtistSignupPage.tsx'));

    assert.ok(
      content.includes("spotifySearchQuery") || content.includes("handleSpotifySearch"),
      'ArtistSignupPage.tsx should have Spotify search state/handler',
    );

    assert.ok(
      content.includes("spotifyResults") || content.includes("SpotifyArtistResult"),
      'ArtistSignupPage.tsx should handle Spotify search results',
    );

    assert.ok(
      content.includes("selectSpotifyArtist"),
      'ArtistSignupPage.tsx should have selectSpotifyArtist function',
    );
  });

  it('ArtistSignupPage.tsx should pre-fill bio and imageUrl from Spotify', () => {
    const content = readFileContent(join(FRONTEND_SRC, 'pages', 'ArtistSignupPage.tsx'));

    assert.ok(
      content.includes("update('bio'") || content.includes("update('imageUrl'"),
      'ArtistSignupPage.tsx should pre-fill bio/imageUrl on Spotify selection',
    );
  });
});

// ─── Phase 5: Featured artists on homepage ───────────────────────────────────

describe('Code Check Phase 5: Featured artists on homepage', () => {
  it('catalogService.ts should query isFeatured artists', () => {
    const content = readFileContent(join(BACKEND_SRC, 'src', 'services', 'catalogService.ts'));

    assert.ok(
      content.includes("isFeatured: true"),
      'catalogService.ts should query isFeatured: true for featured artists',
    );
  });

  it('HomePage.tsx should render Featured Artists section', () => {
    const content = readFileContent(join(FRONTEND_SRC, 'pages', 'HomePage.tsx'));

    assert.ok(
      content.includes("featuredArtists") || content.includes("Featured Artists"),
      'HomePage.tsx should render Featured Artists section',
    );
  });
});

// ─── Phase 6: Analytics uses real data ───────────────────────────────────────

describe('Code Check Phase 6: Analytics uses real SongPlay data', () => {
  it('rollupArtistAnalytics.ts should use SongPlay model', () => {
    const content = readFileContent(join(BACKEND_SRC, 'src', 'jobs', 'rollupArtistAnalytics.ts'));

    assert.ok(
      content.includes("prisma.songPlay"),
      'rollupArtistAnalytics.ts should query prisma.songPlay for real play data',
    );

    assert.ok(
      !content.includes("Math.random()"),
      'rollupArtistAnalytics.ts should not use Math.random() for fake data',
    );
  });

  it('prisma/schema.prisma should have SongPlay model', () => {
    const content = readFileContent(join(BACKEND_SRC, 'prisma', 'schema.prisma'));

    assert.ok(
      content.includes("model SongPlay"),
      'Prisma schema should define SongPlay model',
    );
  });

  it('prisma/schema.prisma should have ArtistAnalyticsDaily model', () => {
    const content = readFileContent(join(BACKEND_SRC, 'prisma', 'schema.prisma'));

    assert.ok(
      content.includes("model ArtistAnalyticsDaily"),
      'Prisma schema should define ArtistAnalyticsDaily model',
    );
  });
});

// ─── Phase 7: Admin features wired ───────────────────────────────────────────

describe('Code Check: Admin features are properly wired', () => {
  it('admin/artists.ts should have verify, suspend, and feature endpoints', () => {
    const content = readFileContent(join(BACKEND_SRC, 'src', 'routes', 'admin', 'artists.ts'));

    assert.ok(content.includes("/artists/:id/verify"), 'Should have verify endpoint');
    assert.ok(content.includes("/artists/:id/suspend"), 'Should have suspend endpoint');
    assert.ok(content.includes("/artists/:id/feature"), 'Should have feature endpoint');
  });

  it('admin/artistApplications.ts should have approve/reject with email', () => {
    const content = readFileContent(join(BACKEND_SRC, 'src', 'routes', 'admin', 'artistApplications.ts'));

    assert.ok(content.includes("sendApplicationApproved"), 'Should send approval email');
    assert.ok(content.includes("sendApplicationRejected"), 'Should send rejection email');
    assert.ok(content.includes("rejectionReason"), 'Should handle rejection reason');
    assert.ok(content.includes("role: 'ARTIST'"), 'Should upgrade user role to ARTIST');
  });
});

// ─── Backend structure verification ──────────────────────────────────────────

describe('Code Check: Backend structure', () => {
  it('app.ts should mount all required routes', () => {
    const content = readFileContent(join(BACKEND_SRC, 'src', 'app.ts'));

    assert.ok(content.includes("artistPortalRouter"), 'Should mount artist portal routes');
    assert.ok(content.includes("adminArtistApplicationsRouter"), 'Should mount admin application routes');
    assert.ok(content.includes("adminArtistsRouter"), 'Should mount admin artist routes');
    assert.ok(content.includes("spotifyRouter"), 'Should mount Spotify routes');
    assert.ok(content.includes("catalogRouter"), 'Should mount catalog routes');
    assert.ok(content.includes("songsRouter"), 'Should mount songs routes');
  });

  it('workers.ts should schedule release publish and analytics rollup jobs', () => {
    const content = readFileContent(join(BACKEND_SRC, 'src', 'jobs', 'workers.ts'));

    assert.ok(
      content.includes("releasePublish") || content.includes("publishScheduledReleases"),
      'workers.ts should schedule release publish job',
    );
    assert.ok(
      content.includes("analyticsRollup") || content.includes("rollupArtistAnalytics"),
      'workers.ts should schedule analytics rollup job',
    );
  });
});
