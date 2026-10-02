import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const rawUrl = process.env.DATABASE_URL || '';
if (!rawUrl) {
  throw new Error(
    `DATABASE_URL is not set. This config file reads every credential from the ` +
      `environment; nothing is hard-coded. Copy .env.example to .env and set it, ` +
      `or export it for a one-off command.`,
  );
}
let parsedUrl: URL;
try {
  parsedUrl = new URL(rawUrl);
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

/**
 * The prisma subcommand being invoked, read from argv. Prisma loads this config
 * before dispatching, so argv is the only signal available for "is this the
 * command that needs a shadow database". Treated as unknown when absent, which
 * resolves to not-requiring rather than to requiring: a false negative is a
 * clear prisma error about a missing shadow URL, while a false positive is a
 * production deploy refusing to start.
 */
function invokedCommand(): string[] {
  return process.argv.slice(2).filter((a) => !a.startsWith('-'));
}

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
