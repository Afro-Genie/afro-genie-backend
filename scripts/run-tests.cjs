'use strict';
/**
 * Stage 7.2/7.3 — the single canonical entry point for every backend test run.
 *
 * Every `test*` script in package.json routes through this file so that the
 * isolation contract is applied exactly once, in one place, in the right order:
 *
 *   1. force NODE_ENV=test (the switch `.env.test` loading is gated on);
 *   2. load `.env.test` and assert the process can only reach disposable
 *      infrastructure (fail closed, before any module opens a connection);
 *   3. run the pre-flight guard from `scripts/assert-safe-tests.cjs`, which
 *      re-checks both doors (our own DB connection and any HTTP API we drive);
 *   4. spawn the Node test runner with the same ordering in `--import`.
 *
 * Stage 0 shipped the guard and every script hand-rolled `set NODE_ENV=test&&`
 * ahead of a long `--import` chain. That worked, but it duplicated the ordering
 * requirement across ~20 script strings, and `set` is a cmd.exe builtin — the
 * scripts silently did nothing useful under other shells. One entry point fixes
 * both problems.
 *
 * Usage:
 *   node scripts/run-tests.cjs                       # all test/*.test.ts
 *   node scripts/run-tests.cjs test/foo.test.ts ...  # specific files
 *   node scripts/run-tests.cjs --tag=pattern         # node:test tag filter
 *   node scripts/run-tests.cjs -- --test-name-pattern="..."  # pass-through
 *
 * Unlike the raw `node --import ./scripts/assert-safe-tests.cjs ...` form,
 * this entry point REFUSES ALLOW_PROD_TESTS. Stage 7's premise is that the
 * suite is structurally incapable of reaching production; keeping the override
 * on the default path would preserve the exact hazard it removes.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

process.env.NODE_ENV = 'test';

const { loadIsolatedTestEnv, isLoopback, assertIsolatedTargets } = require('./lib/test-env.cjs');

// Step 2 must happen at module scope, BEFORE the guard is required. Requiring
// `assert-safe-tests.cjs` runs its guard immediately (it validates on load so
// that no test module can be imported first). If we required it before applying
// .env.test, it would read the production DATABASE_URL that `db-host.cjs`
// pulled in from `.env` and block a perfectly safe run — or, worse, wave
// through a run whose env had not been isolated yet.
loadIsolatedTestEnv();

const { assertSafeToRun, ALLOWLIST } = require('./assert-safe-tests.cjs');

const BACKEND_ROOT = path.resolve(__dirname, '..');

/** Split argv into (a) flags this runner consumes, (b) test files, (c) pass-through. */
function parseArgs(argv) {
  const own = [];
  const files = [];
  const passthrough = [];
  let seenSeparator = false;

  for (const arg of argv) {
    if (seenSeparator) {
      passthrough.push(arg);
      continue;
    }
    if (arg === '--') {
      seenSeparator = true;
      continue;
    }
    if (arg === '--tag' || arg.startsWith('--tag=')) {
      own.push(arg);
      continue;
    }
    if (/\.test\.[cm]?[jt]sx?$/.test(arg) || arg.includes('*')) {
      files.push(arg);
      continue;
    }
    passthrough.push(arg);
  }
  return { own, files, passthrough };
}

function defaultTestFiles() {
  const dir = path.join(BACKEND_ROOT, 'test');
  return fs
    .readdirSync(dir)
    .filter((f) => /\.test\.[cm]?[jt]sx?$/.test(f))
    .sort()
    .map((f) => path.join('test', f));
}

/** Expand one glob the same way the pre-flight guard does, so both see the same set. */
function expand(cwd, arg) {
  if (!arg.includes('*')) return [arg];
  const star = arg.indexOf('*');
  const dir = arg.slice(0, star).replace(/[\\/]+$/, '') || '.';
  const pattern = arg.slice(star);
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
  );
  let entries;
  try {
    entries = fs.readdirSync(path.resolve(cwd, dir));
  } catch {
    return [arg];
  }
  const matches = entries.filter((e) => re.test(e)).map((e) => path.join(dir, e));
  return matches.length ? matches : [arg];
}

function main() {
  if (process.env.ALLOW_PROD_TESTS) {
    console.error(
      '\n\x1b[41m\x1b[97m BLOCKED by scripts/run-tests.cjs \x1b[0m\n' +
        '  ALLOW_PROD_TESTS is not supported by the canonical test runner.\n\n' +
        '  Stage 7 (REMEDIATION-PLAN.md 7.3) makes the suite structurally incapable of\n' +
        '  reaching production: the environment is loaded from .env.test and verified\n' +
        '  before any module runs. If you believe you need a real database, use the raw\n' +
        '  form (node --import ./scripts/assert-safe-tests.cjs ...) so the override is\n' +
        '  visible in your shell history rather than hidden behind a script.\n',
    );
    process.exit(2);
  }

  const { own, files, passthrough } = parseArgs(process.argv.slice(2));
  const targets = files.length ? files.flatMap((f) => expand(BACKEND_ROOT, f)) : defaultTestFiles();

  if (!targets.length) {
    console.error('No test files matched. Nothing to run.');
    process.exit(1);
  }

  // 2. Isolation. Throws (and therefore exits) before anything can connect.
  //    Applied at module scope (see the top of this file) so the guard below
  //    validated against the isolated targets rather than `.env`.
  const resolved = assertIsolatedTargets();
  for (const host of [resolved.dbHost, resolved.redisHost].filter(Boolean)) {
    if (!isLoopback(host)) {
      console.error(
        `[run-tests] Refusing to run: ${host} is not a loopback address. This runner is for the ` +
          'disposable containers created by `npm run test:db:up`.',
      );
      process.exit(2);
    }
  }

  // 3. Pre-flight guard, covering the HTTP-API door as well as our own DB.
  const rel = targets.map((t) => path.relative(BACKEND_ROOT, path.resolve(BACKEND_ROOT, t)).split(path.sep).join('/'));
  assertSafeToRun({ argv: rel, label: 'the backend test suite', cwd: BACKEND_ROOT });

  const allowlisted = rel.filter((t) => ALLOWLIST.has(t));
  if (allowlisted.length) {
    console.log(
      `[run-tests] allowlisted (proven DB-free): ${allowlisted.join(', ')} — these are now redundant ` +
        'under .env.test isolation and can be retired from ALLOWLIST',
    );
  }

  // 4. Spawn. The --import order mirrors steps 1-3 exactly.
  const nodeArgs = [
    '--import',
    './scripts/load-test-env.cjs',
    '--import',
    './scripts/assert-safe-tests.cjs',
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=1',
    '--test-force-exit',
    ...own,
    ...targets,
    ...passthrough,
  ];

  console.log(`[run-tests] node ${nodeArgs.join(' ')}`);
  const child = spawn(process.execPath, nodeArgs, {
    cwd: BACKEND_ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}

main();
