/**
 * Pre-flight guard for test runs.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two separate incidents in this repository (implementation-audit.md §1 and
 * §12.4) had the same cause: a test run reached the production database.
 *
 *   1. test/phase4PlaybackRollout.test.ts + libraryEnrichmentJob.test.ts wrote
 *      stub data onto a real catalog Song row.
 *   2. test:phases-3-6 (reward-phases-3-6.test.ts) called POST /auth/register
 *      against a live API and left ~100 real User rows behind.
 *
 * Both happened because the tests had no idea which database they were talking
 * to. This script makes that knowledge mandatory.
 *
 * WHAT IT CHECKS
 * --------------
 * A test run can reach data through TWO independent doors, and guarding only one
 * is what let incident (2) through:
 *
 *   a) The DATABASE_URL / DIRECT_URL the process itself opens. Used by
 *      `npm test`, `npm run test:schema`, and everything in test/ that
 *      imports src/lib/prisma.
 *
 *   b) An HTTP server the test drives. reward-phases-3-6.test.ts opens no
 *      database connection at all — it POSTs to TEST_API_URL and the *server*
 *      holds the production connection. Checking DATABASE_URL alone would have
 *      happily waved that test through.
 *
 * Both doors are checked, plus a per-file allowlist for suites that are proven
 * to touch neither.
 *
 * POLICY: fail closed. If we cannot positively identify the target as
 * disposable, the run is blocked.
 *
 * HOW TO RUN IT
 * -------------
 *   As a module, so no test file can be loaded before the check:
 *     node --import ./scripts/assert-safe-tests.cjs --import tsx --test test/*.test.ts
 *
 *   As a CLI, chained ahead of a single script:
 *     node scripts/assert-safe-tests.cjs <file> && tsx <file>
 *
 * OPTING IN (deliberate, two ways)
 * --------------------------------
 *   TEST_DB_HOSTS=db.example.internal   Declare a host a designated disposable
 *                                       test database. Preferred: it is scoped
 *                                       to the host rather than the whole run.
 *   ALLOW_PROD_TESTS=1                  Run against the real database anyway.
 *                                       Always prints a loud warning. This is
 *                                       the conscious override, not a shortcut.
 *
 * See REMEDIATION-PLAN.md Stage 0 (steps 0.3/0.4). Permanent fix: Stage 7
 * provisions an isolated test database so none of this is needed.
 */
const path = require('path');
const fs = require('fs');
const { currentHost, isProtected, isDeclaredTestHost, isLoopback, hostList } =
  require('./lib/db-host.cjs');

/**
 * Test files allowed to run while pointed at a production database.
 *
 * Membership means "proven by construction to open no database connection and
 * to drive no HTTP API". It is an explicit list on purpose: an earlier attempt
 * derived this automatically by grepping sources for `prisma`/`fetch`, which
 * false-positives on comments and on locally-defined helpers of the same name.
 * phase6WorkerOptimization.test.ts matches `prisma.aICallLog.create` and
 * `fetch(` in its comments and assertions while importing neither prisma nor
 * global fetch. Adding a file here is a claim about behaviour, so it should be
 * a human decision with the audit reference recorded.
 */
const ALLOWLIST = new Map([
  [
    'test/phase6WorkerOptimization.test.ts',
    'implementation-audit.md §18 — verified over 3 runs: no DB writes; Redis keys ' +
      'namespaced to a provider name no real provider uses; shared counters ' +
      'snapshot and restored; post-run residue zero.',
  ],
]);

/** Collect argv entries that look like test files, ignoring flags and their values. */
function testFileArgs(argv) {
  return argv.filter((a) => !a.startsWith('-') && /\.test\.[cm]?[jt]sx?$/.test(a));
}

/**
 * Expand one shell-style glob against the filesystem.
 * Always returns an array: a literal (non-glob) path becomes a single-element
 * array, because the caller iterates the result.
 */
function expandGlob(cwd, arg) {
  if (!arg.includes('*')) return [arg];
  const star = arg.indexOf('*');
  const dir = arg.slice(0, star).replace(/[\\/]+$/, '') || '.';
  const pattern = arg.slice(star);
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
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

/** Resolve targets to repo-relative POSIX paths, expanding globs. */
function resolveTargets(cwd, args) {
  const out = new Set();
  for (const arg of args) {
    for (const one of expandGlob(cwd, arg)) {
      out.add(path.relative(cwd, path.resolve(cwd, one)).split(path.sep).join('/'));
    }
  }
  return [...out];
}

function fail(lines) {
  console.error('\n\x1b[41m\x1b[97m BLOCKED by scripts/assert-safe-tests.cjs \x1b[0m');
  for (const l of lines) console.error(l);
  console.error('');
  process.exit(2);
}

/**
 * @param {object} opts
 * @param {string[]} opts.argv     candidate test-file arguments
 * @param {string}   opts.label    human description of the run, for the error text
 * @param {string}   opts.cwd      repository root
 */
function assertSafeToRun({ argv, label, cwd }) {
  const host = currentHost();
  const targets = resolveTargets(cwd, argv);

  // ── Door (b): the HTTP server this run may drive ──────────────────────────
  const override = process.env.ALLOW_PROD_TESTS === '1';
  const apiRaw = process.env.TEST_API_URL;
  if (apiRaw) {
    let apiHost = null;
    try {
      apiHost = new URL(apiRaw).hostname;
    } catch {
      /* unparseable is treated as unsafe below */
    }
    const apiAllowed = isLoopback(apiHost) || hostList(process.env.TEST_API_HOSTS).includes(apiHost);
    if (!apiAllowed) {
      if (override) {
        console.warn(
          `\x1b[33m[assert-safe-tests] ALLOW_PROD_TESTS=1 — driving remote API ${apiRaw} ` +
            `with an explicit override. This can write to production.\x1b[0m`
        );
      } else {
        fail([
          `A test run would drive a remote API: TEST_API_URL=${apiRaw}`,
          apiHost ? `  API host: ${apiHost}` : '  TEST_API_URL could not be parsed, so it cannot be judged safe.',
          '',
          '  The test process opens no database itself — the server behind this URL holds the',
          '  connection. This is how test:phases-3-6 left ~100 real User rows behind (§12.4).',
          '',
          '  Point it at a local or disposable API, name the host, or override deliberately:',
          '    TEST_API_HOSTS=<host>          allow this API host',
          '    ALLOW_PROD_TESTS=1            override (prints a warning)',
        ]);
      }
    }
  }

  // ── Door (a): the database this process itself would open ────────────────
  // A host named in PRISMA_PROTECTED_HOSTS is an explicit "never write to this,
  // not even in tests" declaration, and it outranks TEST_DB_HOSTS. Without this
  // check the line below would let the very same host through, because
  // `isDeclaredTestHost` satisfies the second half of the disjunction. The real
  // development database is named there (see .env.test), so that combination is
  // not hypothetical: it is exactly the edit that would point the suite at live
  // data. scripts/lib/test-env.cjs already refuses this; so does this file.
  // Deliberately NOT overridable by ALLOW_PROD_TESTS, matching test-env.cjs.
  if (host && hostList(process.env.PRISMA_PROTECTED_HOSTS).includes(String(host).toLowerCase())) {
    fail([
      `Refusing to run ${label}: the database host is explicitly protected.`,
      `  DB host: ${host}`,
      '',
      '  PRISMA_PROTECTED_HOSTS names this host as "never write to this, not even',
      '  in tests". That declaration outranks TEST_DB_HOSTS, so adding the host to',
      '  TEST_DB_HOSTS does not make it disposable.',
      '',
      '  Point the run at a disposable database, or remove the host from',
      '  PRISMA_PROTECTED_HOSTS if this declaration is genuinely wrong.',
    ]);
  }

  const dbOk = !isProtected(host) || isDeclaredTestHost(host);

  if (!dbOk) {
    if (override) {
      console.warn(
        `\x1b[33m[assert-safe-tests] ALLOW_PROD_TESTS=1 — running against ${host} with an ` +
          `explicit override.\n` +
          `[assert-safe-tests] This can write to production. Targets: ${
            targets.length ? targets.join(', ') : '<unidentified>'
          }\x1b[0m`
      );
    } else {
      const unlisted = targets.filter((t) => !ALLOWLIST.has(t));

      // Zero targets means we could not identify what would run, so we cannot
      // prove it is safe. Fail closed rather than wave it through.
      if (!targets.length) {
        fail([
          `Refusing to run ${label} against a protected database.`,
          `  DB host: ${host}`,
          '',
          '  No test files could be identified in the arguments, so the safety of the',
          '  run cannot be established. A guard that passes what it cannot classify is',
          '  not a guard.',
          '',
          '  Name the test files explicitly, or override deliberately:',
          '    ALLOW_PROD_TESTS=1     override (prints a warning)',
        ]);
      }

      if (unlisted.length) {
        const reasons = unlisted.map((t) => `    - ${t}  (not in the allowlist)`);
        fail([
          `Refusing to run ${label} against a protected database.`,
          `  DB host: ${host}`,
          '',
          '  These test files are not on the allowlist, so they may open a database',
          '  connection and write to real data:',
          ...reasons,
          '',
          '  Fix the target, name it, or override deliberately:',
          `    TEST_DB_HOSTS=${host}   declare this host a disposable test database`,
          '    ALLOW_PROD_TESTS=1     override (prints a warning)',
          '',
          '  Long term: REMEDIATION-PLAN.md Stage 7 provisions an isolated test database.',
          '  In the meantime the pre-incident restore point is at backups/full/2026-09-25T15-27-46-185Z',
          '  and REMEDIATION-PLAN.md Stage 1 must complete before any data repair.',
        ]);
      }

      console.warn(
        `[assert-safe-tests] DB host ${host} is protected, but every targeted suite is ` +
          `proven DB-free — continuing. Targets: ${targets.join(', ')}`
      );
    }
  }

  return { host, targets, allowlisted: targets.filter((t) => ALLOWLIST.has(t)) };
}

// ── CLI mode: validate the file arguments given after the script name ──────
// ── --import mode: loaded before any test module, so validate the parent run ─
//
// Both modes must run. In CLI mode `require.main` is this file; under
// `--import` it is not, which is precisely how we tell the two apart. Nothing
// else in the repo requires this file, so "not main" means "imported as a
// pre-flight" and the check still happens.
const cwd = path.resolve(__dirname, '..');

if (require.main === module) {
  const argv = process.argv.slice(2);
  const label = argv[0] ? `\`${argv.join(' ')}\`` : 'this test run';
  assertSafeToRun({ argv, label, cwd });
} else {
  const argv = testFileArgs(process.argv.slice(1));
  const label = argv.length ? `${argv.length} test file(s)` : 'a test run';
  assertSafeToRun({ argv, label, cwd });
}

module.exports = { assertSafeToRun, ALLOWLIST };
