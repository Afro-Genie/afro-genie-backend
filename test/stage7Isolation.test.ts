import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
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
const { assertIsolatedTargets, hostOf } = require_(path.join(BACKEND_ROOT, 'scripts/lib/test-env.cjs'));

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
