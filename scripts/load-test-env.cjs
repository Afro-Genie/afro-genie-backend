'use strict';
/**
 * Stage 7.2/7.3 — `--import` shim that installs the isolated test environment.
 *
 * This MUST be the first `--import` on every test command line:
 *
 *   node --import ./scripts/load-test-env.cjs --import ./scripts/assert-safe-tests.cjs --import tsx --test ...
 *
 * Ordering is load-bearing, not stylistic:
 *   1. This module populates `process.env` from `.env.test`.
 *   2. `scripts/assert-safe-tests.cjs` then evaluates the resolved
 *      DATABASE_URL. If it ran first it would read `.env` (production) via
 *      db-host.cjs's `require('dotenv/config')` and validate the wrong host.
 *   3. Only then does anything import `src/lib/env.ts`, whose
 *      `import 'dotenv/config'` is now a no-op for these keys because dotenv
 *      does not overwrite values already present in `process.env`.
 *
 * Outside NODE_ENV=test this module is a strict no-op, which is what keeps
 * production and dev boot paths untouched.
 */

const { isTestEnvRequested, loadIsolatedTestEnv } = require('./lib/test-env.cjs');

if (isTestEnvRequested()) {
  const { targets, applied, neutralised } = loadIsolatedTestEnv();
  process.env.AFRO_TEST_ENV_LOADED = 'true';
  // One line, so a failing test run always shows which infrastructure it used.
  console.log(
    `[test-env] isolated: db=${targets.dbHost} redis=${targets.redisHost} api=${targets.apiHost ?? 'none'} ` +
      `(${applied.length} key(s) applied from .env.test, ` +
      `${neutralised.length} third-party credential(s) forced empty)`,
  );
}
