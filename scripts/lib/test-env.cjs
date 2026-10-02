'use strict';
/**
 * Stage 7.2 — isolated test environment loading, shared by
 * `scripts/load-test-env.cjs` (the `--import` shim), `scripts/run-tests.cjs`
 * (the canonical test runner) and `scripts/test-db.cjs` (provisioning).
 *
 * Why this exists
 * ---------------
 * `src/lib/env.ts` and `test/helpers.ts` both do `import 'dotenv/config'`,
 * which loads `.env` — the file that points at production. dotenv never
 * overwrites a key that is already present in `process.env`, so the only way to
 * make a test process immune to `.env` is to populate `process.env` from
 * `.env.test` *before* anything imports dotenv. That is why this module exists
 * and why it must be the first `--import` on the command line.
 *
 * Isolation contract
 * ------------------
 * After loading, `assertIsolatedTargets()` proves the process can only reach
 * disposable infrastructure. It is deliberately positive-only: it does not
 * consult a denylist of "known production hosts" (which goes stale the moment
 * a host is renamed, and fails open for anything unlisted). Instead it derives
 * the allowlist from the URLs in `.env.test` and refuses anything else.
 */

const fs = require('node:fs');
const path = require('node:path');
// Host classification lives in exactly one place (see that module's header:
// two copies of this logic is how a safety mechanism silently drifts into a
// hole). We reuse it rather than re-deriving loopback or allowlist parsing.
const {
  hostList,
  isLoopback: isLoopbackHost,
  isProtected,
  isDeclaredTestHost,
} = require('./db-host.cjs');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const TEST_ENV_FILE = path.join(BACKEND_ROOT, '.env.test');

/** Ports the disposable containers bind to. Deliberately not the defaults. */
const DISPOSABLE_PG_PORT = 55432;
const DISPOSABLE_REDIS_PORT = 56379;

const DEFAULT_TEST_DATABASE_URL = `postgresql://afrogenie:afrogenie@localhost:${DISPOSABLE_PG_PORT}/afrogenie?schema=public`;
const DEFAULT_TEST_REDIS_URL = `redis://localhost:${DISPOSABLE_REDIS_PORT}`;

/**
 * True when the caller has asked for test isolation. `NODE_ENV=test` is the
 * only supported switch: it is what the npm scripts set, and it is what CI
 * sets. Nothing else may turn isolation on, so a stray `AFRO_TEST=1` in a
 * developer's shell cannot silently redirect a production command.
 */
function isTestEnvRequested(env = process.env) {
  return env.NODE_ENV === 'test';
}

/**
 * Minimal dotenv-compatible parser. Kept dependency-free and explicit so the
 * semantics are auditable: `KEY=value`, optional `export `, `#` comments,
 * single/double quoted values, and no interpolation (so a `$` in a value is
 * literal). Blank lines are ignored.
 */
function parseEnvFile(contents) {
  const result = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** Hostname (and port) a URL points at, or null when it cannot be parsed. */
function hostOf(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function splitHosts(value) {
  return hostList(value);
}

/**
 * True when an operator has *explicitly* named this host in
 * PRISMA_PROTECTED_HOSTS. `isProtected()` alone answers true for every unknown
 * host (its deliberate fail-closed default), which would flag the disposable
 * loopback containers too and make the check useless. What we actually care
 * about is the narrower, deliberate case: someone put a host on the "never
 * write to this, not even in tests" list.
 */
function isExplicitlyProtected(host, env = process.env) {
  if (!host) return false;
  if (!env.PRISMA_PROTECTED_HOSTS) return false;
  return hostList(env.PRISMA_PROTECTED_HOSTS).includes(String(host).toLowerCase());
}

/**
 * Apply `.env.test` over `env`. Values from the file win, so an operator who
 * exported `DATABASE_URL` by hand cannot point a test run at production — the
 * isolated value is authoritative. The file is the contract; the shell is not.
 */
function applyTestEnv({ env = process.env, cwd = BACKEND_ROOT } = {}) {
  const file = path.join(cwd, '.env.test');
  if (!fs.existsSync(file)) {
    throw new Error(
      `Isolated test environment missing: ${file} not found. It defines the disposable ` +
        'PostgreSQL/Redis targets the test safety guard requires. See REMEDIATION-PLAN.md 7.2.',
    );
  }

  const parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
  const applied = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== value) applied.push(key);
    env[key] = value;
  }
  return { file, applied, keys: Object.keys(parsed).length };
}

/**
 * Stage 7.3 — the post-condition backstop. Everything the test process will
 * reach is checked here, before a single test body runs:
 *
 *   1. the database URL parses and its host is loopback or allowlisted;
 *   2. the direct (migration) URL agrees with the pooled URL;
 *   3. the Redis URL points at loopback or an allowlisted host;
 *   4. the live-API URL, if one is configured, points at loopback or an
 *      allowlisted host;
 *   5. no allowlisted host is a known production host (`isProtectedHost`),
 *      so a stale `.env.test` cannot smuggle production back in;
 *   6. ALLOW_PROD_TESTS is not set — the escape hatch stays shut.
 *
 * Throws on the first violation so the process exits before importing any
 * module that could open a connection.
 */
function assertIsolatedTargets({ env = process.env } = {}) {
  const problems = [];

  const dbHost = hostOf(env.DATABASE_URL);
  const directHost = hostOf(env.DIRECT_URL ?? env.DATABASE_URL);
  const redisHost = hostOf(env.REDIS_URL);
  const apiHost = hostOf(env.TEST_API_URL);

  if (!dbHost) {
    problems.push('DATABASE_URL is unset or unparseable — the test process must know exactly which database it may write to');
  }

  const dbAllow = splitHosts(env.TEST_DB_HOSTS);
  if (dbHost && !isLoopbackHost(dbHost) && !isDeclaredTestHost(dbHost, env)) {
    problems.push(`DATABASE_URL host "${dbHost}" is neither loopback nor listed in TEST_DB_HOSTS (${dbAllow.join(', ') || 'empty'})`);
  }

  if (directHost && dbHost && directHost !== dbHost) {
    problems.push(`DIRECT_URL host "${directHost}" disagrees with DATABASE_URL host "${dbHost}" — migrations could run against a different database than the tests`);
  }

  const redisAllow = splitHosts(env.TEST_REDIS_HOSTS);
  if (!redisHost) {
    problems.push('REDIS_URL is unset or unparseable — the test process needs an isolated Redis, not the shared one');
  } else if (!isLoopbackHost(redisHost) && !redisAllow.includes(redisHost)) {
    problems.push(`REDIS_URL host "${redisHost}" is neither loopback nor listed in TEST_REDIS_HOSTS (${redisAllow.join(', ') || 'empty'})`);
  }

  const apiAllow = splitHosts(env.TEST_API_HOSTS);
  if (apiHost && !isLoopbackHost(apiHost) && !apiAllow.includes(apiHost)) {
    problems.push(`TEST_API_URL host "${apiHost}" is neither loopback nor listed in TEST_API_HOSTS (${apiAllow.join(', ') || 'empty'})`);
  }

  for (const host of [...new Set([dbHost, redisHost, apiHost].filter(Boolean))]) {
    if (isExplicitlyProtected(host, env)) {
      problems.push(
        `host "${host}" is listed in PRISMA_PROTECTED_HOSTS, which is an explicit "never write to this, not even in tests" declaration`,
      );
    }
    // Defence in depth: `isProtected()` treats an unrecognised host as
    // protected. Reaching here means a host got past the allowlist check
    // above, so flag it loudly rather than trusting the combination.
    if (isProtected(host, env) && !isLoopbackHost(host) && !isDeclaredTestHost(host, env)) {
      problems.push(`host "${host}" is treated as protected by scripts/lib/db-host.cjs and is not a declared test host`);
    }
  }

  if (env.ALLOW_PROD_TESTS === 'true' || env.ALLOW_PROD_TESTS === '1') {
    problems.push('ALLOW_PROD_TESTS is set. Stage 7 removes the ability to run the test suite against production at all; unset it.');
  }

  if (problems.length > 0) {
    throw new Error(
      'Refusing to run tests: the test environment is not provably isolated.\n  - ' +
        problems.join('\n  - ') +
        '\n\nFix .env.test (see REMEDIATION-PLAN.md 7.2/7.3) or run `npm run test:db:up` to provision the disposable containers.',
    );
  }

  return { dbHost, directHost, redisHost, apiHost };
}

/**
 * Convenience: apply then assert. Used by every entry point that starts tests.
 */
function loadIsolatedTestEnv({ env = process.env, cwd = BACKEND_ROOT } = {}) {
  const loaded = applyTestEnv({ env, cwd });
  const targets = assertIsolatedTargets({ env });
  return { ...loaded, targets };
}

module.exports = {
  BACKEND_ROOT,
  DEFAULT_TEST_DATABASE_URL,
  DEFAULT_TEST_REDIS_URL,
  DISPOSABLE_PG_PORT,
  DISPOSABLE_REDIS_PORT,
  TEST_ENV_FILE,
  applyTestEnv,
  assertIsolatedTargets,
  hostOf,
  isExplicitlyProtected,
  isLoopback: isLoopbackHost,
  isTestEnvRequested,
  loadIsolatedTestEnv,
  parseEnvFile,
  splitHosts,
};
