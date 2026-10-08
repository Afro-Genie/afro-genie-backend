import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import path from 'node:path';

// The Stage 7 guard modules are CommonJS infrastructure that live outside
// `src/`, so they have no type declarations and are not covered by
// `tsconfig.test.json`. `createRequire` is the standard Node idiom for loading
// them from here: it bypasses module resolution, so no ambient declaration file
// is needed.
//
// This package is `"type": "commonjs"`, so `import.meta` is a type error
// (TS1470) and `__dirname` is not guaranteed at runtime under tsx. The root is
// therefore located by walking up from the cwd, which the runner pins to
// BACKEND_ROOT (scripts/run-tests.cjs spawns with `cwd: BACKEND_ROOT`).
const require_ = createRequire(__filename);

function findBackendRoot(): string {
  const marker = path.join('scripts', 'lib', 'test-env.cjs');
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the backend root (no ${marker} above ${process.cwd()}). Run via \`node scripts/run-tests.cjs\`.`);
}

const BACKEND_ROOT = findBackendRoot();

const { isDeclaredTestHost, isProtected } = require_(path.join(BACKEND_ROOT, 'scripts/lib/db-host.cjs'));
const {
  assertIsolatedTargets,
  applyTestEnv,
  hostOf,
  parseEnvFile,
  THIRD_PARTY_KEYS_NEVER_REAL,
} = require_(path.join(BACKEND_ROOT, 'scripts/lib/test-env.cjs'));

/** Loose shape: these are environment bags, and a test needs to delete keys. */
type TestEnv = Record<string, string | undefined>;

/** A Neon branch, which `.env.test` documents as an acceptable hosted target. */
const BRANCH_HOST = 'ep-some-branch-123456.us-east-2.aws.neon.tech';
const branchUrl = (host: string) => `postgresql://user:pass@${host}/afrogenie?schema=public`;

/** The minimum environment `assertIsolatedTargets` needs to be satisfiable. */
function envFor(databaseHost: string, testDbHosts: string): TestEnv {
  const url = branchUrl(databaseHost);
  return {
    NODE_ENV: 'test',
    DATABASE_URL: url,
    DIRECT_URL: url,
    REDIS_URL: 'redis://localhost:56379',
    TEST_DB_HOSTS: testDbHosts,
    TEST_REDIS_HOSTS: 'localhost,127.0.0.1,::1',
    TEST_API_HOSTS: 'localhost,127.0.0.1,::1',
  };
}

describe('Stage 7.3 host classification', () => {
  describe('isDeclaredTestHost', () => {
    it('reads the allowlist from the env it is given, not from process.env', () => {
      // The regression: this used to read `process.env.TEST_DB_HOSTS` directly,
      // while every caller in the test tooling passed a scratch env that has
      // `.env.test` applied to it but has *not* mutated `process.env`. The two
      // answers disagreed, and a legitimately declared Neon branch was refused.
      assert.equal(isDeclaredTestHost(BRANCH_HOST, { TEST_DB_HOSTS: BRANCH_HOST }), true);
    });

    it('still refuses a host absent from the env it is given', () => {
      assert.equal(isDeclaredTestHost(BRANCH_HOST, { TEST_DB_HOSTS: 'localhost' }), false);
    });

    it('defaults to process.env so existing no-arg callers keep working', () => {
      // `guard-prisma.cjs` and `stage6-apply.cjs` call these with one argument
      // and rely on process.env. If the default changed, they would silently
      // consult an empty allowlist and start refusing legitimate hosts.
      const beforeDb = process.env.TEST_DB_HOSTS;
      const beforeProtected = process.env.PRISMA_PROTECTED_HOSTS;
      process.env.TEST_DB_HOSTS = BRANCH_HOST;
      delete process.env.PRISMA_PROTECTED_HOSTS;
      try {
        assert.equal(isDeclaredTestHost(BRANCH_HOST), true);
        assert.equal(isDeclaredTestHost('some-other-host'), false);
        // No PRISMA_PROTECTED_HOSTS => the fail-closed "everything is protected".
        assert.equal(isProtected(BRANCH_HOST), true);

        process.env.PRISMA_PROTECTED_HOSTS = BRANCH_HOST;
        assert.equal(isProtected(BRANCH_HOST), true);
        assert.equal(isProtected('some-other-host'), false);
      } finally {
        if (beforeDb === undefined) delete process.env.TEST_DB_HOSTS;
        else process.env.TEST_DB_HOSTS = beforeDb;
        if (beforeProtected === undefined) delete process.env.PRISMA_PROTECTED_HOSTS;
        else process.env.PRISMA_PROTECTED_HOSTS = beforeProtected;
      }
    });

    it('matches case-insensitively and ignores surrounding whitespace', () => {
      const env = { TEST_DB_HOSTS: ` localhost , ${BRANCH_HOST.toUpperCase()} ` };
      assert.equal(isDeclaredTestHost(BRANCH_HOST, env), true);
      assert.equal(isDeclaredTestHost('LOCALHOST', env), true);
    });
  });

  describe('assertIsolatedTargets', () => {
    it('accepts a hosted branch declared in the env it is given', () => {
      assert.doesNotThrow(() => assertIsolatedTargets({ env: envFor(BRANCH_HOST, BRANCH_HOST) }));
    });

    it('accepts the loopback containers without an allowlist entry', () => {
      assert.doesNotThrow(() => assertIsolatedTargets({ env: envFor('localhost', 'localhost') }));
    });

    it('refuses a hosted branch that is not declared disposable', () => {
      assert.throws(
        () => assertIsolatedTargets({ env: envFor(BRANCH_HOST, 'localhost') }),
        /neither loopback nor listed in TEST_DB_HOSTS/,
      );
    });

    it('refuses when DIRECT_URL points at a different host than DATABASE_URL', () => {
      const env = { ...envFor('localhost', 'localhost') };
      env.DIRECT_URL = branchUrl(BRANCH_HOST);
      assert.throws(() => assertIsolatedTargets({ env }), /disagrees with DATABASE_URL/);
    });

    it('refuses when REDIS_URL is missing entirely', () => {
      const env = { ...envFor('localhost', 'localhost') };
      delete env.REDIS_URL;
      assert.throws(() => assertIsolatedTargets({ env }), /REDIS_URL is unset or unparseable/);
    });

    it('refuses when ALLOW_PROD_TESTS is set', () => {
      for (const value of ['true', '1']) {
        const env = { ...envFor('localhost', 'localhost'), ALLOW_PROD_TESTS: value };
        assert.throws(() => assertIsolatedTargets({ env }), /ALLOW_PROD_TESTS is set/);
      }
    });

    it('honours PRISMA_PROTECTED_HOSTS even for an otherwise-declared host', () => {
      // The "never, not even in tests" list is meant to be unconditional, so it
      // must win over a TEST_DB_HOSTS entry for the same host.
      const env = {
        ...envFor(BRANCH_HOST, BRANCH_HOST),
        PRISMA_PROTECTED_HOSTS: BRANCH_HOST,
      };
      assert.throws(() => assertIsolatedTargets({ env }), /never write to this/);
    });
  });

  describe('hostOf', () => {
    it('lowercases the hostname and tolerates junk', () => {
      assert.equal(hostOf(branchUrl('EP-LOUD.neon.tech')), 'ep-loud.neon.tech');
      assert.equal(hostOf('not a url'), null);
      assert.equal(hostOf(''), null);
      assert.equal(hostOf(undefined), null);
    });
  });
});

// The isolation contract above proves a test run cannot reach a real DATABASE.
// It says nothing about a real API KEY, and for most of this repo's history that
// gap was invisible: `applyTestEnv` only *sets* the keys `.env.test` declares, and
// dotenv then loads `.env` — which points at production — for everything else.
// A credential absent from `.env.test` therefore reached the test process intact.
//
// The concrete incident: Phase 2.8 supplied a real `YOUTUBE_API_KEY` and wrote it
// to `.env`. `YOUTUBE_API_KEY` is deliberately absent from `.env.test` (a
// placeholder was rejected for flipping `isConfigured()` on), so every `npm test`
// silently ran with a live, quota-billing Google key. The suites still passed,
// because the YouTube tests stub `fetch` — which is exactly why nothing flagged
// it. One unstubbed enrichment path would have made real billed requests.
//
// These tests exist so "absent from .env.test" can never again mean "real value
// reaches the test process".
describe('third-party credentials cannot leak into a test run', () => {
  /**
   * Truthy stand-ins for what a populated `.env` supplies.
   *
   * Deliberately NOT credential-shaped, and kept under 16 characters. The leak
   * being guarded against is "a truthy value the denylist failed to blank", and
   * that is entirely independent of the value's format — so an obviously-fake
   * marker tests it just as well. Real-shaped canaries here would be
   * self-defeating: the scanner's `bare-assigned-secret` rule exists to catch a
   * leaked key, so it would (correctly) fail the build on the test that guards
   * the leak, and the fix would be a suppression — which is how scanners rot.
   */
  const FROM_DOTENV: Record<string, string> = {
    YOUTUBE_API_KEY: 'LEAK-youtube',
    OPENAI_API_KEY: 'LEAK-openai',
    PAYSTACK_SECRET_KEY: 'LEAK-paystack',
    PAYSTACK_PUBLIC_KEY: 'LEAK-paystack-pub',
    BREVO_API_KEY: 'LEAK-brevo',
    SMTP_PASS: 'LEAK-smtp',
    GOOGLE_CLIENT_SECRET: 'LEAK-google',
    GENIUS_ACCESS_TOKEN: 'LEAK-genius',
    LASTFM_API_KEY: 'LEAK-lastfm',
    SPOTIFY_CLIENT_SECRET: 'LEAK-spotify',
  };

  it('every credential .env.test does not declare resolves falsy, even when .env supplies one', () => {
    // Scoped to the undeclared keys on purpose. `.env.test` legitimately
    // declares inert placeholders for a few of them (GEMINI, TYPESENSE,
    // SPOTIFY) so the zod schema can boot; those are asserted separately below.
    // What must never happen is a key that `.env.test` says nothing about
    // arriving from `.env` intact.
    //
    // Read the declared set from the FILE, not from a post-apply env bag:
    // applyTestEnv writes '' to every denylisted key, so its own output would
    // make every key look declared and the filter below would match nothing.
    const declared = new Set(
      Object.keys(
        parseEnvFile(readFileSync(path.join(BACKEND_ROOT, '.env.test'), 'utf8')),
      ),
    );

    const undeclared = THIRD_PARTY_KEYS_NEVER_REAL.filter((k: string) => !declared.has(k));
    assert.ok(undeclared.length > 0, 'the denylist must contain keys .env.test leaves undeclared');

    const env: TestEnv = { ...FROM_DOTENV };
    applyTestEnv({ env });

    for (const key of undeclared) {
      assert.equal(
        Boolean(env[key]),
        false,
        `${key} reached the test process with a truthy value: ${JSON.stringify(env[key])}`,
      );
    }
  });

  it('assigns an empty string rather than deleting, so dotenv cannot restore it', () => {
    // The ordering is load-bearing. `delete` would run BEFORE
    // `import 'dotenv/config'` in src/lib/env.ts, and dotenv would put the real
    // value straight back from `.env`. Only a *present* key stops dotenv,
    // because it does not overwrite what is already in process.env.
    const env: TestEnv = { YOUTUBE_API_KEY: 'LEAK-youtube' };
    const { neutralised } = applyTestEnv({ env });

    assert.ok(
      neutralised.includes('YOUTUBE_API_KEY'),
      'YOUTUBE_API_KEY must be reported as neutralised',
    );
    assert.equal(env.YOUTUBE_API_KEY, '');
    assert.ok('YOUTUBE_API_KEY' in env, 'the key must still be present, or dotenv re-adds it');
  });

  it('preserves the placeholders .env.test declares, including schema-required ones', () => {
    // The counterweight to the two tests above: blanking these would be a
    // different bug. TYPESENSE_API_KEY and GEMINI_API_KEY are REQUIRED by the
    // zod schema, so forcing them empty turns a leak fix into a boot failure.
    const env: TestEnv = { ...FROM_DOTENV };
    applyTestEnv({ env });

    assert.equal(env.TYPESENSE_API_KEY, 'test-only-typesense-key');
    assert.equal(env.GEMINI_API_KEY, 'test-only-gemini-key');
    assert.equal(env.SPOTIFY_CLIENT_ID, 'test-only-spotify-client-id');
  });

  it('keeps the payment suites hermetic: Paystack is configured by .env.test alone', () => {
    // The other side of the same incident. The payment suites never called
    // setPaymentConfig for setup — they relied on the real `sk_test_` value
    // leaking out of a developer's `.env`. Invisible on a laptop; on a clean CI
    // runner with no `.env` the whole money path would 503 instead of testing.
    const env: TestEnv = {};
    applyTestEnv({ env });

    for (const key of ['PAYSTACK_SECRET_KEY', 'PAYSTACK_PUBLIC_KEY', 'PAYSTACK_CALLBACK_URL']) {
      assert.ok(Boolean(env[key]), `${key} must be configured by .env.test, not inherited from .env`);
    }
  });

  it('no placeholder is a real credential shape', () => {
    // Guards the obvious mistake: "fixing" the leak by pasting a live key into
    // the tracked .env.test instead of an inert string.
    const env: TestEnv = {};
    applyTestEnv({ env });

    const realShapes = [
      /^AIzaSy[0-9A-Za-z_-]{30,}$/, // Google API key
      /^sk-(live|test)_[0-9A-Za-z]{16,}$/, // Paystack secret
      /^pk_(live|test)_[0-9A-Za-z]{16,}$/, // Paystack public
      /^sk-proj-[0-9A-Za-z_-]{20,}$/, // OpenAI
      /^xkeysib-[0-9a-f]{32}-/, // Brevo
      /^xsmtpsib-[0-9a-f]{32}-/, // Brevo SMTP
      /^GOCSPX-[0-9A-Za-z_-]+$/, // Google OAuth
      /^npg_[0-9A-Za-z]{16,}$/, // Neon
    ];

    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string' || value === '') continue;
      for (const shape of realShapes) {
        assert.ok(
          !shape.test(value),
          `.env.test declares ${key} in a real credential shape: ${value.slice(0, 12)}...`,
        );
      }
    }
  });
});
