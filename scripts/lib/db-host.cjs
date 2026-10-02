/**
 * Shared database-host classification.
 *
 * Extracted from guard-prisma.cjs so every guard in this repository answers
 * exactly one question with exactly one implementation: "is this host
 * protected, i.e. does it hold data we must not casually write to?"
 *
 * Two independent copies of this logic is how a safety mechanism silently
 * drifts into a hole — one guard gets tightened, the other keeps the old
 * hole. Do not inline a host check anywhere; require this instead.
 *
 * The policy is deliberately fail-closed: any host we cannot positively
 * identify as disposable is treated as protected.
 */
require('dotenv/config');

/** Split a comma-separated env var into a lowercased, trimmed list. */
function hostList(value) {
  return String(value || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The host the app is currently pointed at.
 * Checks DIRECT_URL as well as DATABASE_URL: Prisma's pooler URL and the
 * direct URL are frequently different hosts, and a guard that only reads
 * DATABASE_URL can be bypassed by which of the two is populated.
 * Returns null when neither is set or the value is unparseable.
 */
function currentHost() {
  const raw = process.env.DATABASE_URL || process.env.DIRECT_URL;
  if (!raw) return null;
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

/**
 * True when `host` holds data that must not be written to without an explicit
 * conscious opt-in.
 *
 * Protected hosts are taken from PRISMA_PROTECTED_HOSTS (comma-separated) or,
 * if unset, from a conservative default: everything. `*.neon.tech` is real
 * infrastructure, localhost is this app's working copy, and an unrecognised
 * host is assumed to be someone's production database.
 */
function isProtected(host, env = process.env) {
  if (!host) return false;
  const envList = env.PRISMA_PROTECTED_HOSTS;
  if (envList) {
    return hostList(envList).includes(String(host).toLowerCase());
  }
  return true; // unknown hosts are protected by default
}

/**
 * Hosts the operator has explicitly declared disposable — an isolated test
 * database, a throwaway local Postgres, a Neon branch used only for tests.
 * Naming a host here is a deliberate act, so it is the supported way to make
 * the default protection relaxable without a blanket override.
 *
 * `env` is a parameter rather than a direct `process.env` read because the
 * test tooling builds a scratch environment that has `.env.test` applied to it
 * but has *not* mutated `process.env` (`scripts/test-db.cjs`). Reading
 * `process.env` here would silently consult a different allowlist than the
 * caller's — and would fail closed for a legitimately declared Neon branch.
 */
function isDeclaredTestHost(host, env = process.env) {
  if (!host) return false;
  return hostList(env.TEST_DB_HOSTS).includes(String(host).toLowerCase());
}

/** Loopback hosts: safe to write to, since they cannot reach real infrastructure. */
function isLoopback(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

module.exports = {
  hostList,
  currentHost,
  isProtected,
  isDeclaredTestHost,
  isLoopback,
};
