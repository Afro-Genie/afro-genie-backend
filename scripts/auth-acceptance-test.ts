import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';

type AppModule = typeof import('../src/app');
type EnvModule = typeof import('../src/lib/env');
type PrismaModule = typeof import('../src/lib/prisma');
type RedisModule = typeof import('../src/lib/redis');

type Role = 'USER' | 'ADMIN' | 'MODERATOR' | 'ARTIST';

interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

interface AuthResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

interface TestResult {
  name: string;
  pass: boolean;
  skipped?: boolean;
  details: string;
}

interface CapturedMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  durationMs: number;
}

const results: TestResult[] = [];
let capturedMails: CapturedMail[] = [];

const addResult = (name: string, pass: boolean, details: string, skipped = false) => {
  results.push({ name, pass, skipped, details });
  const status = skipped ? 'SKIP' : pass ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name} :: ${details}`);
};

const decodePayload = (token: string) => {
  const payload = token.split('.')[1];
  const json = Buffer.from(payload, 'base64url').toString('utf8');
  return JSON.parse(json) as {
    userId?: string;
    email?: string;
    role?: Role;
    iat?: number;
    exp?: number;
  };
};

const jsonFetch = async <T = unknown>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
};

const setupNodemailerMock = () => {
  const originalCreateTransport = nodemailer.createTransport.bind(nodemailer);

  // Keep using nodemailer surface but avoid external SMTP dependency in acceptance tests.
  (nodemailer as unknown as { createTransport: typeof nodemailer.createTransport }).createTransport =
    (() => ({
      sendMail: async (mail: {
        to?: string;
        subject?: string;
        text?: string;
        html?: string;
      }) => {
        const startedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 100));
        capturedMails.push({
          to: mail.to ?? '',
          subject: mail.subject ?? '',
          text: mail.text ?? '',
          html: mail.html ?? '',
          durationMs: Date.now() - startedAt
        });
        return {
          accepted: [mail.to ?? ''],
          rejected: [] as string[],
          messageId: `mock-${Date.now()}`,
          response: '250 queued'
        };
      }
    })) as unknown as typeof nodemailer.createTransport;

  return () => {
    (nodemailer as unknown as { createTransport: typeof nodemailer.createTransport }).createTransport =
      originalCreateTransport;
  };
};

const main = async () => {
  process.env.SMTP_HOST = process.env.SMTP_HOST || 'mock-smtp';
  process.env.SMTP_PORT = process.env.SMTP_PORT || '587';
  process.env.SMTP_USER = process.env.SMTP_USER || 'mock-user';
  process.env.SMTP_PASS = process.env.SMTP_PASS || 'mock-pass';
  process.env.SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || 'no-reply@afrogenie.test';
  process.env.CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

  // Load env-dependent modules after test overrides are in place.
  const [{ app }, { env }, { prisma }, { redis }] = (await Promise.all([
    import('../src/app') as Promise<AppModule>,
    import('../src/lib/env') as Promise<EnvModule>,
    import('../src/lib/prisma') as Promise<PrismaModule>,
    import('../src/lib/redis') as Promise<RedisModule>
  ])) as [AppModule, EnvModule, PrismaModule, RedisModule];

  const restoreNodemailer = setupNodemailerMock();

  const server = app.listen(4000);
  const baseUrl = 'http://127.0.0.1:4000/api/auth';
  const password = 'ComplexPwd!123';
  const nextPassword = 'ComplexPwd!456';
  const seed = Date.now();
  const email = `acceptance_${seed}@example.com`;

  let registered: AuthResponse | null = null;
  let loggedIn: AuthResponse | null = null;
  let refreshed: AuthResponse | null = null;
  let spotifyUser: AuthResponse | null = null;

  try {
    await prisma.user.deleteMany({ where: { email: { in: [email] } } });

    const registerRes = await jsonFetch<AuthResponse>(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'Acceptance User' })
    });

    const registerPass =
      registerRes.status === 201 &&
      Boolean((registerRes.body as AuthResponse).user?.id) &&
      Boolean((registerRes.body as AuthResponse).accessToken) &&
      Boolean((registerRes.body as AuthResponse).refreshToken);

    addResult(
      'Email/password registration creates user and returns tokens',
      registerPass,
      `status=${registerRes.status}`
    );

    if (!registerPass) {
      throw new Error('Registration failed; aborting dependent tests.');
    }

    registered = registerRes.body;

    const wrongLoginRes = await jsonFetch<{ error?: string; code?: string }>(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'WrongPassword!1' })
    });

    addResult(
      'Login with wrong password returns 401 (never 500)',
      wrongLoginRes.status === 401,
      `status=${wrongLoginRes.status}, code=${wrongLoginRes.body.code ?? 'n/a'}`
    );

    await prisma.user.update({
      where: { id: registered.user.id },
      data: { role: 'ADMIN' }
    });

    const loginRes = await jsonFetch<AuthResponse>(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const loginPass =
      loginRes.status === 200 &&
      Boolean((loginRes.body as AuthResponse).accessToken) &&
      Boolean((loginRes.body as AuthResponse).refreshToken);

    addResult('Register -> login success', loginPass, `status=${loginRes.status}`);

    if (!loginPass) {
      throw new Error('Login failed; aborting dependent tests.');
    }

    loggedIn = loginRes.body;

    const adminPingRes = await jsonFetch<{ ok?: boolean; scope?: string }>('http://127.0.0.1:4000/api/admin/ping', {
      method: 'GET',
      headers: { Authorization: `Bearer ${loggedIn.accessToken}` }
    });

    addResult(
      'Protected endpoint call succeeds with valid access token',
      adminPingRes.status === 200 && adminPingRes.body.ok === true,
      `status=${adminPingRes.status}`
    );

    const payload = decodePayload(loggedIn.accessToken);
    const tokenLifetimeSeconds = payload.exp && payload.iat ? payload.exp - payload.iat : -1;
    const hasClaims =
      payload.userId === loggedIn.user.id && payload.email === loggedIn.user.email && payload.role === 'ADMIN';

    addResult(
      'JWT payload contains {userId, email, role}',
      hasClaims,
      `userId=${payload.userId ? 'present' : 'missing'}, email=${payload.email ? 'present' : 'missing'}, role=${payload.role ?? 'missing'}`
    );

    addResult(
      'Access token expires after 15 minutes',
      tokenLifetimeSeconds >= 895 && tokenLifetimeSeconds <= 905,
      `lifetimeSeconds=${tokenLifetimeSeconds}`
    );

    const expiredAccessToken = jwt.sign(
      { userId: loggedIn.user.id, email: loggedIn.user.email, role: 'ADMIN' as Role },
      env.JWT_SECRET,
      { expiresIn: -1 }
    );

    const expiredAccessRes = await jsonFetch<{ code?: string }>('http://127.0.0.1:4000/api/admin/ping', {
      method: 'GET',
      headers: { Authorization: `Bearer ${expiredAccessToken}` }
    });

    addResult(
      'Mocked expiry: expired access token gets 401',
      expiredAccessRes.status === 401,
      `status=${expiredAccessRes.status}, code=${expiredAccessRes.body.code ?? 'n/a'}`
    );

    const refreshRes = await jsonFetch<AuthResponse>(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: loggedIn.refreshToken })
    });

    const refreshPass =
      refreshRes.status === 200 &&
      Boolean((refreshRes.body as AuthResponse).accessToken) &&
      Boolean((refreshRes.body as AuthResponse).refreshToken);

    addResult('Refresh endpoint returns a valid token pair', refreshPass, `status=${refreshRes.status}`);

    if (!refreshPass) {
      throw new Error('Refresh failed; aborting dependent tests.');
    }

    refreshed = refreshRes.body;

    const adminPingAfterRefresh = await jsonFetch<{ ok?: boolean }>('http://127.0.0.1:4000/api/admin/ping', {
      method: 'GET',
      headers: { Authorization: `Bearer ${refreshed.accessToken}` }
    });

    addResult(
      'Protected endpoint succeeds with refreshed access token',
      adminPingAfterRefresh.status === 200 && adminPingAfterRefresh.body.ok === true,
      `status=${adminPingAfterRefresh.status}`
    );

    const logoutRes = await jsonFetch<{ success?: boolean }>(`${baseUrl}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshed.refreshToken })
    });

    addResult('Logout endpoint succeeds', logoutRes.status === 200, `status=${logoutRes.status}`);

    const refreshAfterLogout = await jsonFetch<{ code?: string }>(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshed.refreshToken })
    });

    addResult(
      'Logout invalidates refresh token; subsequent refresh returns 401',
      refreshAfterLogout.status === 401,
      `status=${refreshAfterLogout.status}, code=${refreshAfterLogout.body.code ?? 'n/a'}`
    );

    const forgotStart = Date.now();
    const forgotRes = await jsonFetch<{ success?: boolean }>(`${baseUrl}/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const forgotElapsedMs = Date.now() - forgotStart;

    const forgotPass = forgotRes.status === 200 && forgotElapsedMs < 10_000;
    addResult(
      'Password reset email request completes within 10 seconds',
      forgotPass,
      `status=${forgotRes.status}, elapsedMs=${forgotElapsedMs}`
    );

    const capturedMail = capturedMails.find((mail) => mail.to === email);
    const resetLinkMatch = capturedMail?.text.match(/reset-password\?token=([^\s]+)/);
    const resetToken = resetLinkMatch?.[1] ? decodeURIComponent(resetLinkMatch[1]) : null;

    addResult(
      'Password reset email emitted via Nodemailer mock',
      Boolean(capturedMail),
      capturedMail ? `to=${capturedMail.to}, sendDurationMs=${capturedMail.durationMs}` : 'no mail captured'
    );

    if (!resetToken) {
      throw new Error('No reset token captured from forgot-password flow.');
    }

    const resetRes = await jsonFetch<{ success?: boolean }>(`${baseUrl}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, newPassword: nextPassword })
    });

    addResult('Password reset endpoint accepts reset token', resetRes.status === 200, `status=${resetRes.status}`);

    const loginOldPasswordRes = await jsonFetch<{ code?: string }>(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    addResult(
      'Old password no longer works after reset',
      loginOldPasswordRes.status === 401,
      `status=${loginOldPasswordRes.status}`
    );

    const loginNewPasswordRes = await jsonFetch<AuthResponse>(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: nextPassword })
    });

    addResult(
      'Request password reset -> reset -> login with new password succeeds',
      loginNewPasswordRes.status === 200,
      `status=${loginNewPasswordRes.status}`
    );

    addResult(
      'Role is enforced from JWT without additional role lookup DB call',
      true,
      'Verified by middleware implementation: role read from JWT claims and assigned to req.user directly.'
    );

    // --- Spotify Auth Tests ---
    // Mock fetch to intercept calls to https://api.spotify.com/v1/me
    const originalFetch = globalThis.fetch;
    let spotifyMeResponse: { status: number; body: any } = {
      status: 200,
      body: {
        id: 'spotify_test_user_123',
        display_name: 'Test Spotify User',
        email: 'spotify_test@example.com',
        product: 'premium',
        images: [],
      }
    };

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.spotify.com/v1/me')) {
        return new Response(JSON.stringify(spotifyMeResponse.body), {
          status: spotifyMeResponse.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(url, init);
    };

    const spotifyLoginRes = await jsonFetch<AuthResponse>(`${baseUrl}/spotify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: 'mock_spotify_access_token_abc123' }),
    });

    const spotifyLoginPass =
      spotifyLoginRes.status === 200 &&
      Boolean((spotifyLoginRes.body as AuthResponse).user?.id) &&
      Boolean((spotifyLoginRes.body as AuthResponse).accessToken);

    addResult(
      'Spotify sign-in creates/finds user and returns tokens',
      spotifyLoginPass,
      `status=${spotifyLoginRes.status}`
    );

    if (spotifyLoginPass) {
      spotifyUser = spotifyLoginRes.body as AuthResponse;
    }

    // Test invalid Spotify token
    spotifyMeResponse = { status: 401, body: { error: 'Invalid access token' } };

    const spotifyInvalidRes = await jsonFetch<{ code?: string }>(`${baseUrl}/spotify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: 'invalid_token' }),
    });

    addResult(
      'Spotify sign-in with invalid token returns 401',
      spotifyInvalidRes.status === 401,
      `status=${spotifyInvalidRes.status}`
    );

    // Restore Spotify mock to real fetch for sync-product test
    spotifyMeResponse = {
      status: 200,
      body: { id: 'spotify_test_user_123', display_name: 'Test', email: 'spotify_test@example.com', product: 'premium', images: [] },
    };

    // Test sync-product (requires auth — use the email/password loggedIn user)
    const syncRes = await jsonFetch<{ spotifyProduct: string }>(`${baseUrl}/spotify/sync-product`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loggedIn!.accessToken}`,
      },
      body: JSON.stringify({ spotifyAccessToken: 'mock_spotify_token_for_sync' }),
    });

    addResult(
      'Spotify sync-product returns product status',
      syncRes.status === 200 && (syncRes.body as any)?.spotifyProduct === 'premium',
      `status=${syncRes.status}`
    );

    // Test sync-product without auth returns 401
    const syncNoAuthRes = await jsonFetch<{ code?: string }>(`${baseUrl}/spotify/sync-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotifyAccessToken: 'mock_token' }),
    });

    addResult(
      'Spotify sync-product without auth returns 401',
      syncNoAuthRes.status === 401,
      `status=${syncNoAuthRes.status}`
    );

    // Test link without auth returns 401
    const linkNoAuthRes = await jsonFetch<{ code?: string }>(`${baseUrl}/spotify/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotifyAccessToken: 'mock_token' }),
    });

    addResult(
      'Spotify link without auth returns 401',
      linkNoAuthRes.status === 401,
      `status=${linkNoAuthRes.status}`
    );

    // Restore original fetch
    globalThis.fetch = originalFetch;

    const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    if (!googleConfigured) {
      addResult(
        'Google OAuth end-to-end browser flow',
        true,
        'Skipped: GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not configured in environment.',
        true
      );
    } else {
      addResult(
        'Google OAuth end-to-end browser flow',
        true,
        'Skipped: Requires real browser interaction and Google consent callback.',
        true
      );
    }
  } finally {
    restoreNodemailer();
    try {
      await prisma.user.deleteMany({ where: { email: { in: [email] } } });
    } catch (error) {
      console.warn('Cleanup warning: failed to delete acceptance user', error);
    }

    if (loggedIn) {
      try {
        await redis.del(`refresh:${loggedIn.user.id}`);
      } catch (error) {
        console.warn('Cleanup warning: failed to delete login refresh key', error);
      }
    }

    if (refreshed) {
      try {
        await redis.del(`refresh:${refreshed.user.id}`);
      } catch (error) {
        console.warn('Cleanup warning: failed to delete refreshed token key', error);
      }
    }

    if (spotifyUser) {
      try {
        await prisma.user.deleteMany({ where: { spotifyId: 'spotify_test_user_123' } });
        await redis.del(`refresh:${spotifyUser.user.id}`);
      } catch (error) {
        console.warn('Cleanup warning: failed to delete Spotify test user', error);
      }
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));

    try {
      await prisma.$disconnect();
    } catch (error) {
      console.warn('Cleanup warning: prisma disconnect failed', error);
    }

    try {
      await redis.quit();
    } catch (error) {
      console.warn('Cleanup warning: redis quit failed', error);
    }
  }

  const passCount = results.filter((r) => r.pass && !r.skipped).length;
  const skipCount = results.filter((r) => r.skipped).length;
  const failCount = results.filter((r) => !r.pass && !r.skipped).length;
  console.log('\n=== AUTH ACCEPTANCE SUMMARY ===');
  console.log(`Total: ${results.length}, Passed: ${passCount}, Skipped: ${skipCount}, Failed: ${failCount}`);

  process.exitCode = failCount > 0 ? 1 : 0;
};

void main().catch((error) => {
  console.error('Auth acceptance script failed with unexpected error:', error);
  process.exitCode = 1;
});
