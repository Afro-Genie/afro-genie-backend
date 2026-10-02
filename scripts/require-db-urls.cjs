/**
 * Fail-closed resolution of database connection strings from the environment.
 *
 * WHY THIS EXISTS — nine tracked helper scripts at the repository root
 * (`copy-violet.js`, `copy-violet2.js`, `survey-detail.js`, `survey-tables.js`,
 * `verify-copy.js`, `inspect-fk.js`, `inspect-violet.js`, `inspect-schemas.js`,
 * `inspect-seeder-schemas.js`) each carried a live Neon connection string
 * inline, password and all. A credential in source is a credential in every
 * clone, every CI artifact, and every git clone made after the password is
 * rotated — rotating the env var does nothing to it. These scripts connect to
 * real infrastructure (production and a decommissioned branch), so "the value
 * was convenient" is not a reason to keep one there.
 *
 * The replacement has to fail LOUDLY and SPECIFICALLY. A script that silently
 * falls back to a default URL, or that emits `undefined` into a connection
 * string, is worse than one that refuses: it either connects somewhere
 * unintended or produces a baffling driver error an hour later. So every
 * lookup here either returns a real URL or terminates with an exit code and a
 * message naming the variable, the file it belongs in, and what it is for.
 *
 * The reported host is redacted to `host/database` — never the user or the
 * password — because these error messages get pasted into issues and chat.
 *
 * Usage:
 *   const { requireUrls } = require('./scripts/require-db-urls.cjs');
 *   const { SRC, DST } = requireUrls({ SRC: 'VIOLET_DATABASE_URL', DST: 'RICE_DATABASE_URL' });
 */
require('dotenv/config');

/** Load `.env.local` when present, without clobbering already-set variables. */
function loadEnvLocal() {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/**
 * Describe a URL without disclosing its credential: `host/database`.
 * Falls back to a length-only hint when the value will not parse.
 */
function redact(value) {
  try {
    const u = new URL(value);
    const db = u.pathname.replace(/^\//, '');
    return db ? `${u.hostname}/${db}` : u.hostname;
  } catch {
    return `<unparseable, ${value.length} chars>`;
  }
}

/**
 * Resolve one connection string, or exit the process with an actionable error.
 */
function requireUrl(varName, role) {
  const value = (process.env[varName] || '').trim();
  if (!value) {
    process.stderr.write(
      `\nREFUSING TO RUN: ${varName} is not set.\n\n` +
        `  This script used to carry a live database password in its source.\n` +
        `  That credential has been removed from the repository and must now come\n` +
        `  from the environment. Nothing is guessed or defaulted: these scripts talk\n` +
        `  to real infrastructure, and a wrong target is not recoverable.\n\n` +
        `  ${varName} is the connection string for: ${role}\n\n` +
        `  Provide it one of these ways:\n\n` +
        `    1. Add it to .env.local (git-ignored, never committed):\n` +
        `         ${varName}=postgresql://user:password@host:5432/database?sslmode=require\n\n` +
        `    2. Or set it for a single run:\n` +
        `         $env:${varName}="postgresql://..."   # PowerShell\n\n` +
        `  If you no longer have the value, rotate it in the provider's console\n` +
        `  (https://console.neon.tech) rather than recovering it from git history.\n\n`,
    );
    process.exit(2);
  }
  try {
    // eslint-disable-next-line no-new
    new URL(value);
  } catch {
    process.stderr.write(
      `\nREFUSING TO RUN: ${varName} is set but is not a valid URL.\n` +
        `  Expected something like postgresql://user:password@host:5432/database\n` +
        `  Parsed value: ${redact(value)}\n\n`,
    );
    process.exit(2);
  }
  return value;
}

/**
 * Resolve a named set of connection strings in one call.
 *
 * `spec` maps a local name used by the calling script to the environment
 * variable that holds it, e.g. `{ SRC: 'VIOLET_DATABASE_URL' }`.
 */
function requireUrls(spec) {
  loadEnvLocal();
  const out = {};
  for (const [local, varName] of Object.entries(spec)) {
    out[local] = requireUrl(varName, local);
  }
  return out;
}

module.exports = { requireUrl, requireUrls, redact };