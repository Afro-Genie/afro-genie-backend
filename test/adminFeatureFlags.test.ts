import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { env } from '../src/lib/env';
import { youtubePlaybackEnabled } from '../src/services/youtubeService';
import {
  newRegistry,
  createPhase3User,
  registerPhase3Teardown,
  startPhase3Harness,
  type FixtureRegistry,
  type Harness,
} from './phase3Fixtures';

// Phase 2 task 2.4 — GET /api/admin/feature-flags.
//
// Purpose: an operator holding a running instance should be able to confirm the
// flags the server is actually enforcing without shell access to read an env file
// on it. During a staged rollout that is the difference between "the flag is off"
// being a fact and being a guess.
//
// Two things this file exists to hold the route to:
//
//   1. AUTHZ. It reports the shape of the deployment. ADMIN only — the route must
//      never become a public read of which features are enabled, and it must not
//      be reachable by an ordinary authenticated user just because they have a
//      valid token.
//
//   2. NO SECRET LEAKAGE. This is the trap. The tempting version of this endpoint
//      reports the flags *and* the underlying config so an operator can see "why
//      isn't this working" — and config is where API keys live. Presence, never
//      value. `YOUTUBE_API_KEY: true` is actionable and safe; the key itself is
//      neither.

const FLAGS = ['STORE', 'REFERRALS', 'SEASONS', 'PLAYBACK_YOUTUBE'] as const;

const tokenFor = (userId: string, email: string, role: string) =>
  jwt.sign({ userId, email, role }, env.JWT_SECRET, { expiresIn: '5m' });

const registry: FixtureRegistry = newRegistry();
registerPhase3Teardown(registry);

let harness: Harness;
let adminToken: string;
let userToken: string;
let saved: { flag: boolean; key?: string; secret?: string; publicKey?: string };

describe('GET /api/admin/feature-flags (2.4)', () => {
  before(async () => {
    saved = {
      flag: env.FLAG_PLAYBACK_YOUTUBE,
      key: env.YOUTUBE_API_KEY,
      secret: env.PAYSTACK_SECRET_KEY,
      publicKey: env.PAYSTACK_PUBLIC_KEY,
    };

    harness = await startPhase3Harness();

    const admin = await createPhase3User(registry, 'ADMIN');
    adminToken = tokenFor(admin.id, admin.email, 'ADMIN');

    const user = await createPhase3User(registry, 'USER');
    userToken = tokenFor(user.id, user.email, 'USER');
  });

  after(async () => {
    env.FLAG_PLAYBACK_YOUTUBE = saved.flag;
    env.YOUTUBE_API_KEY = saved.key;
    env.PAYSTACK_SECRET_KEY = saved.secret;
    env.PAYSTACK_PUBLIC_KEY = saved.publicKey;
    await harness.close();
  });

  // -------------------------------------------------------------------------
  // Authz
  // -------------------------------------------------------------------------

  test('rejects an unauthenticated request with 401', async () => {
    const res = await harness.request('GET', '/api/admin/feature-flags');

    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'UNAUTHORIZED');
  });

  test('rejects an ordinary authenticated user with 403', async () => {
    // The important one. A valid token is not sufficient; only ADMIN may read
    // deployment state.
    const res = await harness.request('GET', '/api/admin/feature-flags', { token: userToken });

    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
  });

  test('rejects a garbage bearer token with 401', async () => {
    const res = await harness.request('GET', '/api/admin/feature-flags', { token: 'not.a.jwt' });

    assert.equal(res.status, 401);
    assert.ok(!JSON.stringify(res.body).includes('STORE'), 'no partial payload on rejection');
  });

  test('lets an ADMIN through and reports every flag', async () => {
    const res = await harness.request('GET', '/api/admin/feature-flags', { token: adminToken });

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.flags).sort(), [...FLAGS].sort());
    for (const flag of FLAGS) {
      assert.equal(typeof res.body.flags[flag], 'boolean', `${flag} must be reported as a boolean`);
    }
  });

  // -------------------------------------------------------------------------
  // It reports the state the server enforces, not a module-load snapshot
  // -------------------------------------------------------------------------

  test('reports the effective flag value, tracking a change made after boot', async () => {
    // This is the whole reason `featureFlags` is getter-backed. With a plain
    // object literal the registry captured FLAG_PLAYBACK_YOUTUBE at import time,
    // so after boot-time logs were quiet this endpoint would confidently report
    // the value from process start — which, right after someone flips the rollout
    // to stop it, is precisely the wrong answer to give.
    const original = env.FLAG_PLAYBACK_YOUTUBE;

    try {
      env.FLAG_PLAYBACK_YOUTUBE = false;
      const off = await harness.request('GET', '/api/admin/feature-flags', { token: adminToken });
      assert.equal(off.body.flags.PLAYBACK_YOUTUBE, false);

      env.FLAG_PLAYBACK_YOUTUBE = true;
      const on = await harness.request('GET', '/api/admin/feature-flags', { token: adminToken });
      assert.equal(on.body.flags.PLAYBACK_YOUTUBE, true);
    } finally {
      env.FLAG_PLAYBACK_YOUTUBE = original;
    }
  });

  test('agrees with the flag the playback resolver enforces, right now', async () => {
    // The endpoint is only useful if it agrees with the code path that consumes the
    // flag. Compare it against the resolver's own predicate rather than the env
    // var, so a divergence between registry and resolver fails here.
    const original = env.FLAG_PLAYBACK_YOUTUBE;

    try {
      for (const value of [true, false]) {
        env.FLAG_PLAYBACK_YOUTUBE = value;
        const res = await harness.request('GET', '/api/admin/feature-flags', { token: adminToken });
        assert.equal(
          res.body.flags.PLAYBACK_YOUTUBE,
          youtubePlaybackEnabled(),
          `endpoint and resolver must agree with the flag set to ${value}`,
        );
      }
    } finally {
      env.FLAG_PLAYBACK_YOUTUBE = original;
    }
  });

  // -------------------------------------------------------------------------
  // The leak test
  // -------------------------------------------------------------------------

  test('reports configuration presence as booleans and never leaks a secret value', async () => {
    // The `-CHANGEME-` runs are load-bearing, not decoration. Each canary has to
    // be shaped like a real credential for this test to mean anything, and
    // scripts/scan-secrets.cjs deliberately fails the build on credential-shaped
    // literals. An obvious-placeholder run inside the value is how a fixture says
    // "this is not a secret" in a way the scanner accepts, instead of the fixture
    // being allowlisted by path — a path exemption would also excuse a real key
    // pasted into this file later.
    const SECRET = 'sk_test_LEAKCANARY-CHANGEME-9f2a7c4e8b1d';
    const API_KEY = 'AIzaSyLEAKCANARY-CHANGEME-youtube-key';
    const PUB_KEY = 'pk_test_LEAKCANARY-CHANGEME-public-key';

    try {
      env.YOUTUBE_API_KEY = API_KEY;
      env.PAYSTACK_SECRET_KEY = SECRET;
      env.PAYSTACK_PUBLIC_KEY = PUB_KEY;

      const res = await harness.request('GET', '/api/admin/feature-flags', { token: adminToken });
      assert.equal(res.status, 200);

      const serialized = JSON.stringify(res.body);
      for (const canary of [SECRET, API_KEY, PUB_KEY]) {
        assert.ok(
          !serialized.includes(canary),
          'a config VALUE must never appear in the response',
        );
        assert.ok(
          !serialized.includes(canary.slice(0, 12)),
          'not even a prefix of a secret may appear',
        );
      }

      // Presence is still reported — that is the actionable part, and it is safe.
      assert.equal(res.body.config.YOUTUBE_API_KEY, true);
      assert.equal(res.body.config.PAYSTACK_SECRET_KEY, true);
      assert.equal(res.body.config.PAYSTACK_PUBLIC_KEY, true);

      for (const [name, value] of Object.entries(res.body.config)) {
        assert.equal(typeof value, 'boolean', `${name} must be presence-only`);
      }
    } finally {
      env.YOUTUBE_API_KEY = saved.key;
      env.PAYSTACK_SECRET_KEY = saved.secret;
      env.PAYSTACK_PUBLIC_KEY = saved.publicKey;
    }
  });

  test('reports absent configuration as false without erroring', async () => {
    // The empty-deployment case: a flag can be on with nothing behind it, which
    // looks like a working feature. "key: false" is what makes that diagnosable.
    const original = env.YOUTUBE_API_KEY;

    try {
      env.YOUTUBE_API_KEY = undefined;
      const res = await harness.request('GET', '/api/admin/feature-flags', { token: adminToken });

      assert.equal(res.status, 200);
      assert.equal(res.body.config.YOUTUBE_API_KEY, false);
    } finally {
      env.YOUTUBE_API_KEY = original;
    }
  });

  test('is read-only: no flag is mutated by reading', async () => {
    const original = env.FLAG_PLAYBACK_YOUTUBE;

    const before = await harness.request('GET', '/api/admin/feature-flags', { token: adminToken });

    assert.equal(env.FLAG_PLAYBACK_YOUTUBE, original, 'a GET must not change process state');
    assert.equal(before.body.source, 'effective', 'the response states how it was resolved');
  });

  test('does not accept a write that would flip a flag from outside the process', async () => {
    // Guards against this becoming a toggle endpoint. Rollout changes are env
    // changes on purpose: they are auditable, they require a redeploy/restart, and
    // an ADMIN writing to the registry here would change nothing in the resolver
    // (which reads env per call) while appearing to succeed.
    const res = await harness.request('POST', '/api/admin/feature-flags', {
      token: adminToken,
      body: { PLAYBACK_YOUTUBE: true },
    });

    assert.ok(res.status === 404 || res.status === 405, `unexpected status ${res.status}`);
  });
});