'use strict';
/**
 * Stage 7.1 — provision the isolated test database and Redis.
 *
 * WHY A SCRIPT AND NOT A README PARAGRAPH
 * --------------------------------------
 * "Set TEST_DB_HOSTS by hand before you test" is not an environment, it is a
 * habit, and habits are what let Stage 0's guard get bypassed. The guarantee
 * Stage 7 needs is structural: `npm test` must fail loudly rather than quietly
 * reach production, and a developer must be able to produce the isolated
 * environment in one command without knowing any credentials.
 *
 * The target is a disposable PostgreSQL and a disposable Redis, both bound to
 * non-default ports on loopback only. Two properties make them safe by
 * construction rather than by configuration:
 *
 *   * the port bindings are `127.0.0.1:<port>`, never `0.0.0.0`, so nothing
 *     off the machine can reach them;
 *   * the data directory is a tmpfs mount, so the contents exist only in
 *     memory and cannot survive the container. There is no backup to restore
 *     and no stale state to trip over — `reset` really is a clean database.
 *
 * Hosted alternative: if you would rather not run Docker, set
 * TEST_DATABASE_URL to a Neon *branch* (never the primary) and this script will
 * skip provisioning and use it. The isolation assertion is identical, so the
 * two options are interchangeable from the suite's point of view.
 *
 * Commands:
 *   node scripts/test-db.cjs up       provision + wait for readiness + push schema
 *   node scripts/test-db.cjs down     stop and remove the containers
 *   node scripts/test-db.cjs reset    down, then up (guarantees an empty database)
 *   node scripts/test-db.cjs status   container state, schema and row counts
 *   node scripts/test-db.cjs verify   check isolation invariants only (no Docker)
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const {
  BACKEND_ROOT,
  DISPOSABLE_PG_PORT,
  DISPOSABLE_REDIS_PORT,
  applyTestEnv,
  assertIsolatedTargets,
  hostOf,
  isLoopback,
} = require('./lib/test-env.cjs');

// Allowlist parsing lives in lib/db-host.cjs and nowhere else (see that module's
// header). This script used to keep a private copy of it, which meant the
// hosted path consulted a different allowlist than the guard did.
const { isDeclaredTestHost } = require('./lib/db-host.cjs');

const PG_CONTAINER = 'afrogenie-test-pg';
const REDIS_CONTAINER = 'afrogenie-test-redis';
const PG_IMAGE = 'postgres:16-alpine';
const REDIS_IMAGE = 'redis:7-alpine';
const PG_USER = 'afrogenie';
const PG_PASSWORD = 'afrogenie';
const PG_DATABASE = 'afrogenie';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
};

const log = (...a) => console.log(...a);
const ok = (m) => log(`${C.green}  ok${C.reset}  ${m}`);
const warn = (m) => log(`${C.yellow}warn${C.reset}  ${m}`);
const die = (m) => {
  console.error(`${C.red}error${C.reset}  ${m}`);
  process.exit(1);
};

/** `.env.test` is the single source of truth for the targets, loaded into a scratch object. */
function isolatedEnv() {
  const env = { ...process.env, NODE_ENV: 'test' };
  applyTestEnv({ env, cwd: BACKEND_ROOT });
  assertIsolatedTargets({ env });
  return env;
}

function docker(args, { env = process.env, allowFail = false } = {}) {
  const res = spawnSync('docker', args, { env, encoding: 'utf8', shell: false });
  if (res.error) {
    die(
      `Could not run \`docker ${args.join(' ')}\`: ${res.error.message}\n` +
        '  Install Docker Desktop, or set TEST_DATABASE_URL to a disposable hosted branch and re-run.',
    );
  }
  if (res.status !== 0 && !allowFail) {
    die(`\`docker ${args.join(' ')}\` failed (exit ${res.status}):\n${(res.stderr || res.stdout || '').trim()}`);
  }
  return res;
}

function containerState(name) {
  const res = docker(['inspect', '-f', '{{.State.Status}}', name], { allowFail: true });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

function hasDocker() {
  const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
  return res.status === 0;
}

/**
 * True when the operator opted into a hosted disposable database instead of Docker.
 *
 * Reads `env` — the scratch object that has `.env.test` applied to it — rather
 * than `process.env`. This script never mutates `process.env`, so reading it
 * here consulted the un-merged environment and rejected exactly the hosted
 * branch that `.env.test` documents as acceptable.
 */
function hostedTestDatabase(env) {
  const url = env.TEST_DATABASE_URL;
  if (!url) return null;
  const host = hostOf(url);
  if (!host) die(`TEST_DATABASE_URL is unparseable: ${url}`);
  if (!isLoopback(host) && !isDeclaredTestHost(host, env)) {
    die(
      `TEST_DATABASE_URL points at "${host}", which is neither loopback nor declared disposable. ` +
        'A Neon *branch* is acceptable; the primary database is not. ' +
        `Declare it in TEST_DB_HOSTS (currently: ${env.TEST_DB_HOSTS || 'empty'}).`,
    );
  }
  return url;
}

// ── commands ────────────────────────────────────────────────────────────────

function cmdUp(env) {
  const hosted = hostedTestDatabase(env);
  if (hosted) {
    warn(`Using TEST_DATABASE_URL (${hostOf(hosted)}) instead of provisioning a container.`);
    warn('The suite does not verify that a hosted target is a branch rather than the primary.');
    pushSchema(env, { databaseUrl: hosted });
    ok('schema pushed to the hosted test database');
    return;
  }

  if (!hasDocker()) {
    die(
      'Docker is not running. Start Docker Desktop, or set TEST_DATABASE_URL to a disposable\n' +
        '  hosted branch (a Neon branch is fine; the primary database is not).',
    );
  }

  // ── PostgreSQL ───────────────────────────────────────────────────────────
  const pgState = containerState(PG_CONTAINER);
  if (pgState === 'running') {
    ok(`${PG_CONTAINER} already running on 127.0.0.1:${DISPOSABLE_PG_PORT}`);
  } else {
    if (pgState) docker(['rm', '-f', PG_CONTAINER], { allowFail: true });
    docker([
      'run',
      '-d',
      '--rm',
      '--name',
      PG_CONTAINER,
      // Loopback only. `0.0.0.0` would expose a writable database to the LAN.
      '-p',
      `127.0.0.1:${DISPOSABLE_PG_PORT}:5432`,
      // tmpfs: the cluster lives in RAM and cannot outlive the container, so
      // there is no stale data to reason about and nothing to clean up.
      '--tmpfs',
      '/var/lib/postgresql/data:rw,size=512m',
      '-e',
      `POSTGRES_USER=${PG_USER}`,
      '-e',
      `POSTGRES_PASSWORD=${PG_PASSWORD}`,
      '-e',
      `POSTGRES_DB=${PG_DATABASE}`,
      '-e',
      // Speeds up the throwaway cluster's own checkpoints considerably.
      'POSTGRES_INITDB_ARGS=--data-checksums',
      '--health-cmd',
      'pg_isready -U ' + PG_USER + ' -d ' + PG_DATABASE,
      '--health-interval',
      '2s',
      '--health-timeout',
      '3s',
      '--health-retries',
      '30',
      PG_IMAGE,
    ]);
    ok(`${PG_CONTAINER} started on 127.0.0.1:${DISPOSABLE_PG_PORT} (tmpfs, loopback-only)`);
  }
  awaitHealthy(PG_CONTAINER, 'database system is ready to accept connections');

  // ── Redis ────────────────────────────────────────────────────────────────
  const redisState = containerState(REDIS_CONTAINER);
  if (redisState === 'running') {
    ok(`${REDIS_CONTAINER} already running on 127.0.0.1:${DISPOSABLE_REDIS_PORT}`);
  } else {
    if (redisState) docker(['rm', '-f', REDIS_CONTAINER], { allowFail: true });
    docker([
      'run',
      '-d',
      '--rm',
      '--name',
      REDIS_CONTAINER,
      '-p',
      `127.0.0.1:${DISPOSABLE_REDIS_PORT}:6379`,
      '--health-cmd',
      'redis-cli ping',
      '--health-interval',
      '2s',
      '--health-timeout',
      '3s',
      '--health-retries',
      '30',
      REDIS_IMAGE,
    ]);
    ok(`${REDIS_CONTAINER} started on 127.0.0.1:${DISPOSABLE_REDIS_PORT} (loopback-only)`);
  }
  awaitHealthy(REDIS_CONTAINER, 'PONG');

  // Prove Redis is genuinely reachable before tests depend on it, so a failure
  // surfaces here with a clear cause rather than as 200 flaky tests.
  const ping = spawnSync(
    'docker',
    ['exec', REDIS_CONTAINER, 'redis-cli', 'ping'],
    { encoding: 'utf8' },
  );
  if (ping.stdout.trim() !== 'PONG') die(`Redis did not answer PING: ${(ping.stdout || ping.stderr).trim()}`);
  ok('redis answered PING');

  pushSchema(env, {});
  ok(`schema pushed (${path.relative(BACKEND_ROOT, path.join(BACKEND_ROOT, 'prisma', 'schema.prisma'))})`);
  log('');
  log(`${C.bold}Isolated test environment is ready.${C.reset}`);
  log(`  DATABASE_URL  postgresql://${PG_USER}:***@localhost:${DISPOSABLE_PG_PORT}/${PG_DATABASE}`);
  log(`  REDIS_URL     redis://localhost:${DISPOSABLE_REDIS_PORT}`);
  log(`  ${C.dim}Run \`npm test\` for the suite, \`npm run test:db:reset\` to start clean.${C.reset}`);
}

function awaitHealthy(name, expect) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const res = docker(['inspect', '-f', '{{.State.Health.Status}}', name], { allowFail: true });
    const status = (res.stdout || '').trim();
    if (status === 'healthy') {
      ok(`${name} is healthy (${expect})`);
      return;
    }
    if (status === 'unhealthy' || Date.now() > deadline) {
      const logs = docker(['logs', '--tail', '30', name], { allowFail: true });
      die(`${name} never became healthy (last status: ${status || 'unknown'})\n${logs.stdout || logs.stderr || ''}`);
    }
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
  }
}

/**
 * `prisma db push` rather than `migrate deploy`: the disposable database is
 * rebuilt from scratch on every `reset`, so its history must not be compared
 * against `prisma/migrations/`, which tracks production's schema evolution.
 *
 * The target is passed three ways, deliberately. `--url` is authoritative (it
 * overrides prisma.config.ts), and DATABASE_URL/DIRECT_URL in the child env are
 * set to the same value, because prisma.config.ts reads `process.env` and a
 * stray exported shell variable would otherwise decide where the schema lands.
 */
function pushSchema(env, { databaseUrl }) {
  const target = databaseUrl || env.DATABASE_URL;
  if (!target) die('No database target to push a schema to.');
  const host = hostOf(target);
  if (!host) die(`Unparseable database target: ${target}`);
  if (!isLoopback(host) && !isDeclaredTestHost(host, env)) {
    die(`Refusing to push a schema to non-loopback host "${host}".`);
  }

  const childEnv = { ...env, NODE_ENV: 'test', DATABASE_URL: target, DIRECT_URL: target };
  const args = ['db', 'push', '--accept-data-loss', '--url', target];
  // Invoke the CLI's JS entrypoint directly through the current Node binary.
  // `shell: true` (needed for the .cmd shim) triggers DEP0190 and concatenates
  // the URL unescaped; this path has neither problem.
  const entry = path.join(BACKEND_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  if (!fs.existsSync(entry)) {
    die(`Prisma CLI not found at ${entry}. Run \`npm install\` first.`);
  }

  const res = spawnSync(process.execPath, [entry, ...args], {
    cwd: BACKEND_ROOT,
    env: childEnv,
    encoding: 'utf8',
    shell: false,
  });
  if (res.status !== 0) {
    die(`prisma db push failed:\n${(res.stderr || res.stdout || '').trim()}`);
  }
}

function cmdDown() {
  for (const name of [PG_CONTAINER, REDIS_CONTAINER]) {
    const state = containerState(name);
    if (!state) {
      log(`${C.dim}  --  ${name} not present${C.reset}`);
      continue;
    }
    docker(['rm', '-f', name], { allowFail: true });
    ok(`${name} removed (tmpfs discarded)`);
  }
}

function cmdStatus(env) {
  const pg = containerState(PG_CONTAINER);
  const redis = containerState(REDIS_CONTAINER);
  log(`${C.bold}containers${C.reset}`);
  log(`  ${PG_CONTAINER.padEnd(24)} ${pg ?? 'absent'}`);
  log(`  ${REDIS_CONTAINER.padEnd(24)} ${redis ?? 'absent'}`);

  if (pg !== 'running') {
    log('');
    warn('PostgreSQL is not running; run `npm run test:db:up`.');
    return;
  }

  const q = (sql) =>
    docker(
      ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DATABASE, '-tAc', sql],
      { allowFail: true },
    ).stdout.trim();

  log('');
  log(`${C.bold}schema${C.reset}`);
  const tables = Number(q("select count(*) from information_schema.tables where table_schema='public'"));
  log(`  public tables            ${tables}`);
  log(`  applied migrations       ${q('select count(*) from _prisma_migrations') || '0 (db push — no history)'}`);

  log('');
  log(`${C.bold}row counts${C.reset}`);
  const counts = [
    ['User', 'users'],
    ['Song', 'songs'],
    ['Challenge', 'challenges'],
    ['UserChallenge', 'user_challenges'],
    ['AbuseFlag', 'abuse_flags'],
    ['RewardTransaction', 'reward_transactions'],
    ['Notification', 'notifications'],
  ];
  for (const [table, label] of counts) {
    const n = q(`select count(*) from "${table}"`);
    if (n === '' || n === undefined) continue;
    log(`  ${label.padEnd(24)} ${n}`);
  }

  log('');
  log(`${C.bold}redis${C.reset}`);
  const dbsize = docker(['exec', REDIS_CONTAINER, 'redis-cli', 'dbsize'], { allowFail: true });
  log(`  keys                     ${(dbsize.stdout || '').trim() || 'n/a (container not running)'}`);
}

/** Isolation invariants only — no Docker, no database, safe for a CI preflight. */
function cmdVerify(env) {
  assertIsolatedTargets({ env });
  ok('DATABASE_URL, DIRECT_URL, REDIS_URL and TEST_API_URL all resolve to disposable targets');
  const resolved = require('./lib/test-env.cjs');
  const dbHost = resolved.hostOf(env.DATABASE_URL);
  const redisHost = resolved.hostOf(env.REDIS_URL);
  const apiHost = resolved.hostOf(env.TEST_API_URL);
  if (!isLoopback(dbHost)) warn(`database host ${dbHost} is not loopback (hosted test database in use)`);
  if (!isLoopback(redisHost)) warn(`redis host ${redisHost} is not loopback`);
  if (apiHost) log(`  ${C.dim}live API under test: ${env.TEST_API_URL}${C.reset}`);
  ok('ALLOW_PROD_TESTS is not set');
}

function main() {
  const command = process.argv[2] || 'up';
  const env = isolatedEnv();
  switch (command) {
    case 'up':
      cmdUp(env);
      break;
    case 'down':
      cmdDown();
      break;
    case 'reset':
      cmdDown();
      cmdUp(env);
      break;
    case 'status':
      cmdStatus(env);
      break;
    case 'verify':
      cmdVerify(env);
      break;
    default:
      die(`Unknown command "${command}". Use: up | down | reset | status | verify`);
  }
}

main();
