/**
 * Guard for destructive Prisma/DB commands.
 *
 * Blocks `prisma migrate dev`, `prisma migrate reset`, `prisma db push` and
 * `prisma config`/`setup` targets against *protected* database hosts (the ones
 * that hold real/production data) unless the caller explicitly opts out by
 * setting ALLOW_DESTRUCTIVE_DB=1. This prevents the class of incident where a
 * `migrate dev` (which can DROP SCHEMA / reset) destroys live data.
 *
 * Usage: wrap prisma through this script:
 *   node scripts/guard-prisma.cjs migrate dev
 *   node scripts/guard-prisma.cjs db push
 *
 * Protected hosts are taken from PRISMA_PROTECTED_HOSTS (comma-separated) or,
 * if unset, from { exclude: [...], include: [...] } config. The default policy
 * protects every Neon/`*.neon.tech` host AND localhost, i.e. everything, so an
 * accidental destructive run is blocked everywhere until you consciously opt in.
 *
 * Opt-out (conscious): ALLOW_DESTRUCTIVE_DB=1 node scripts/guard-prisma.cjs migrate dev
 */
const { spawnSync } = require('child_process');
const { currentHost, isProtected } = require('./lib/db-host.cjs');

const DESTRUCTIVE = {
  migrate: ['dev', 'reset'],
  db: ['push', 'setup'],
};

const args = process.argv.slice(2);
const [cmd, sub] = args;

function isDestructive() {
  if (!cmd) return false;
  const subs = DESTRUCTIVE[cmd];
  if (!subs) return false;
  if (subs.includes(sub) || subs.includes(args[1])) return true;
  // `prisma migrate dev --name x` -> args[1] === 'dev'
  return args.slice(1).some((a) => subs.includes(a));
}

if (isDestructive()) {
  const host = currentHost();
  const protectedFlag = isProtected(host);
  const allowed = process.env.ALLOW_DESTRUCTIVE_DB === '1';

  if (protectedFlag && !allowed) {
    console.error(
      `\nBLOCKED by scripts/guard-prisma.cjs: "${args.join(' ')}" is destructive.`
    );
    console.error(`  Current DB host: ${host || '<unset>'}`);
    console.error(
      `  This would risk data loss. To run it anyway, set ALLOW_DESTRUCTIVE_DB=1 ` +
        `(e.g. for a truly disposable local DB) and re-run.`
    );
    console.error(
      '  Tip: create a throwaway dev database and point DATABASE_URL at that instead.\n'
    );
    process.exit(2);
  }
}

// Re-run the real prisma CLI, forwarding all arguments and stdio.
const path = require('path');
// Invoke the local Prisma CLI binary directly (avoids npx/cmd quirks).
const prismaCli = path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js');
const res = spawnSync(process.execPath, [prismaCli, ...args], { stdio: 'inherit', env: process.env });
if (res.error) {
  console.error('[guard-prisma] failed to run prisma:', res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 0);