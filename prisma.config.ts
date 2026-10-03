import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * The prisma subcommand being invoked, read from argv. Prisma loads this config
 * before dispatching, so argv is the only signal available for "is this the
 * command that needs a database". Treated as unknown when absent, which resolves
 * to not-requiring rather than to requiring: a false negative is a clear prisma
 * error about a missing URL, while a false positive is a production deploy
 * refusing to start.
 */
function invokedCommand(): string[] {
  return process.argv.slice(2).filter((a) => !a.startsWith('-'));
}

/**
 * Commands that never open a connection. They read the schema and emit files:
 * `generate` writes the client into node_modules, `validate` and `format` only
 * read and rewrite prisma/schema.prisma.
 *
 * WHY THEY ARE EXEMPT — this file is evaluated by every prisma command, and CI
 * runs `npm run lint`, which is `prisma generate && tsc --noEmit`. Requiring
 * DATABASE_URL for a command that only emits code made `npm run lint` fail
 * everywhere no `.env` exists: every GitHub Actions runner, every fresh clone,
 * every container build. The guard bought nothing there, because `generate`
 * authenticates to nothing — it never dials the database. This is the same
 * scoping decision already made for SHADOW_DATABASE_URL below: fail on the
 * commands that can do damage, not on all of them.
 */
const OFFLINE_COMMANDS = new Set(['generate', 'validate', 'format']);

/**
 * Stand-in used only when an offline command runs with no DATABASE_URL set. Two
 * properties matter: it must parse (prisma validates the datasource even when it
 * will not connect), and it must be inert if anything in the command *did* try to
 * connect — loopback, and a database name nobody provisions.
 */
const OFFLINE_DATABASE_URL = 'postgresql://user:pass@localhost:5432/offline';

const rawUrl = process.env.DATABASE_URL || '';
const isOfflineCommand = OFFLINE_COMMANDS.has(invokedCommand()[0] ?? '');

if (!rawUrl && !isOfflineCommand) {
  throw new Error(
    `DATABASE_URL is not set. This config file reads every credential from the ` +
      `environment; nothing is hard-coded. Copy .env.example to .env and set it, ` +
      `or export it for a one-off command.`,
  );
}
let parsedUrl: URL;
try {
  parsedUrl = new URL(rawUrl || OFFLINE_DATABASE_URL);
} catch {
  throw new Error(
    `DATABASE_URL is set but is not a valid URL. Expected something like ` +
      `postgresql://user:password@host:5432/database.`,
  );
}
parsedUrl.searchParams.delete('channel_binding');

/**
 * Shadow database for `prisma migrate dev` / `db push`.
 *
 * WHY THIS IS NOT A CONSTANT — `migrate dev` DROPS AND RECREATES the shadow
 * database before replaying migrations against it. This file previously pinned
 * `shadowDatabaseUrl` to the production Neon host with its password inline, so a
 * single `npm run migrate:dev` would have dropped production itself. A
 * hard-coded credential also put a live database password in version control,
 * where it survives every "rotate the secret" that only rotates the env var.
 *
 * The shadow database must be a DISPOSABLE database that shares nothing with
 * production. Leave it unset to make `migrate dev` refuse to run rather than
 * guess a target:
 *
 *   SHADOW_DATABASE_URL=postgresql://user:pass@localhost:5432/afrogenie_shadow
 *
 * Stage 7 (REMEDIATION-PLAN.md 7.1) provisions a Neon branch for this.
 *
 * WHY IT IS NOT REQUIRED UNCONDITIONALLY — this file is evaluated by every
 * prisma command, and only `migrate dev` (and `migrate reset`) needs a shadow
 * target. `db push` and `migrate deploy` do not use one
 * (REMEDIATION-RESULTS.md:346), and they run in production on every deploy.
 * Failing unconditionally would therefore break deploys to fix a dev-ergonomics
 * gap, so the requirement is scoped to the commands that actually need it.
 */
const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL || '';

const NEEDS_SHADOW =
  invokedCommand()[0] === 'migrate' &&
  ['dev', 'reset'].includes(invokedCommand()[1] ?? '');

if (NEEDS_SHADOW && !shadowDatabaseUrl) {
  throw new Error(
    `SHADOW_DATABASE_URL is not set, and \`prisma migrate ${
      invokedCommand()[1]
    }\` requires one.\n` +
      `The shadow database is DROPPED AND RECREATED on every run, so it must be a ` +
      `disposable database that shares nothing with production. Point this at a ` +
      `throwaway database or a dedicated Neon branch:\n` +
      `  SHADOW_DATABASE_URL=postgresql://user:pass@localhost:5432/afrogenie_shadow\n` +
      `Commands that do not need it (\`db push\`, \`migrate deploy\`) run without it.`,
  );
}

if (shadowDatabaseUrl) {
  // Fail closed: refuse a shadow target that is the database we are migrating.
  // Dropping the live database is unrecoverable, so this is worth a hard error.
  let shadow: URL;
  try {
    shadow = new URL(shadowDatabaseUrl);
  } catch {
    throw new Error(
      `SHADOW_DATABASE_URL is set but is not a valid URL. Expected something like ` +
        `postgresql://user:password@localhost:5432/afrogenie_shadow.`,
    );
  }
  if (shadow.hostname === parsedUrl.hostname && shadow.pathname === parsedUrl.pathname) {
    throw new Error(
      `SHADOW_DATABASE_URL points at the same database as DATABASE_URL ` +
        `(${parsedUrl.hostname}${parsedUrl.pathname}). ` +
        `\`prisma migrate dev\` DROPS AND RECREATES the shadow database, so this ` +
        `would destroy the database it is supposed to compare against. Point it ` +
        `at a disposable database.`,
    );
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: parsedUrl.toString(),
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
