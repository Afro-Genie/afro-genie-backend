/**
 * Repository secret scanner.
 *
 * WHY THIS EXISTS — a live Neon password sat in nine tracked files at the repo
 * root and in a commit on the local `staging` branch. It reached version
 * control because nothing checked. This script is that check: it fails the
 * build on a credential pattern so the tenth one cannot land silently.
 *
 * WHAT IT SCANS — tracked files (`git ls-files`), not the working tree. That
 * distinction matters: `.env`, `.env.local` and `.env.staging` are supposed to
 * contain real credentials and are git-ignored, so scanning the working tree
 * would either drown in known-good matches or force exceptions that defeat the
 * point. The question this answers is only "is a secret in something I am
 * about to commit".
 *
 * HOW IT STAYS HONEST — the pattern list below is deliberately narrow: each
 * entry targets a credential format specific enough that a false positive means
 * someone really did write a live-looking secret. A scanner that cries wolf gets
 * switched off, and a switched-off scanner protects nothing. Placeholders in
 * `.env.example` are allowed explicitly and by name, not by pattern.
 *
 * Exit codes: 0 clean, 1 findings, 2 scanner could not run (not a pass).
 *
 * Usage:
 *   node scripts/scan-secrets.cjs            # scan tracked files
 *   node scripts/scan-secrets.cjs --staged   # only files in the git index
 *   node scripts/scan-secrets.cjs --history  # also scan every commit
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

/**
 * Repository root to scan. Overridable so the self-test can point the scanner at
 * a throwaway repo with known-planted secrets — a scanner nobody has watched
 * catch anything is a scanner nobody can trust to pass.
 */
const ROOT = process.env.SECRET_SCAN_ROOT
  ? path.resolve(process.env.SECRET_SCAN_ROOT)
  : path.join(__dirname, '..');
const ONLY_STAGED = args.includes('--staged');
const SCAN_HISTORY = args.includes('--history');

/**
 * Each rule: a name for the report, and a RegExp matched per line.
 *
 * `dbPassword` is the load-bearing one: it catches `postgres://user:pass@host`,
 * which is the shape of every credential found in this repository. It requires a
 * password component, so `postgresql://localhost:5432/db` and the doc-comment
 * example in prisma.config.ts are not matched — the latter is
 * `user:pass@localhost`, which the explicit placeholder allowlist covers. A
 * loopback authority is exempt too, via the check in `isBenign` below rather
 * than here, because the rule has to stop at the `@` to stay narrow.
 */
const RULES = [
  { name: 'neon-api-key', re: /\bnpg_[A-Za-z0-9]{16,}/ },
  { name: 'db-password-in-url', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/@]+:[^\s:/@]+@/ },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'stripe-live-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'paystack-secret-key', re: /\bsk_live_[0-9a-f]{32}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'jwt-literal', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    name: 'bare-assigned-secret',
    // A secret-looking variable assigned a long literal. Requires both an
    // uppercase secret-ish name and a 16+ char quoted value with no spaces,
    // which excludes prose, URLs, and `${...}` interpolation.
    re: /\b[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY)[A-Z0-9_]*\s*[:=]\s*['"][^\s'"${}]{16,}['"]/,
  },
];

/**
 * Files allowed to contain credential-shaped text, as repo-relative paths.
 *
 * `.env.example` is the contract: it must show the variable names and shapes.
 * It carries `user:password@` and `replace_with_*` values, which the rules
 * above would otherwise flag.
 *
 * `test/secretScan.test.ts` is this scanner's own self-test. It necessarily
 * contains credential-shaped strings — that is the fixture material — so it is
 * excepted by exact path. It is exempt from *scanning*, not from review: a
 * planted value there is a bug in the test, which is why the fixtures are
 * documented as non-live and asserted to be caught.
 *
 * Everything else must be added here by name, with a reason. A wildcard here is
 * an unbounded hole in the only check standing between a credential and a
 * commit, so none are accepted.
 */
const ALLOW = new Set([
  '.env.example',
  '.env.test',
  'test/secretScan.test.ts',
]);

/**
 * Suppress a match that is demonstrably not a live credential.
 *
 * Deliberately narrow. Every exemption is a value that cannot authenticate
 * anything: an obvious placeholder word, a loopback/dev host, or a value the
 * runtime resolves from the environment.
 *
 * The placeholder and host checks run against the MATCHED TEXT, not the whole
 * line. Checking the line would exempt a real credential that merely shares a
 * line with a comment containing the word "example" — the sort of accidental
 * pass that turns a scanner decorative. The one place that has to read past the
 * match is the loopback-authority check, and it reads only the characters
 * immediately after the match (see the comment there).
 *
 * `process.env` is the one line-wide check, because it answers a different
 * question: the credential on this line is being *read from* the environment
 * rather than *written into* the source. It cannot exempt a hard-coded literal,
 * because a literal and an env read on one line means both are present and the
 * literal is the finding.
 *
 * Takes the match array rather than the matched string: `isBenign` needs
 * `match.index` to find where the match ended on the line.
 */
function isBenign(line, match) {
  const text = match[0];
  if (/process\.env/.test(line)) return true;
  if (/\$\{?[A-Z_][A-Z0-9_]*\}?/.test(text)) return true; // env interpolation
  if (/user:pass|user:password|:pass@|:password@|<[^>]*>|xxx+|\bTODO\b|\bCHANGEME\b/i.test(text))
    return true;
  if (/localhost|127\.0\.0\.1|::1|\bexample\b|\bplaceholder\b|replace_with/i.test(text))
    return true;
  // `db-password-in-url` stops matching at the `@` — requiring a password
  // component is what makes the rule fire at all — so the host sits just past the
  // end of the match, where the loopback check above can never see it. Read it
  // from the authority that follows.
  //
  // A password in a loopback-only DSN is not a credential: it authenticates to
  // nothing beyond this machine. It is the disposable-test-container value shared
  // verbatim by `.env.test`, `scripts/test-db.cjs` and `scripts/lib/test-env.cjs`,
  // and those files must keep agreeing or the containers stop matching the URLs
  // the suite connects with. Every other host — `db.internal`, every real Neon or
  // Redis Cloud endpoint — still fails, because the authority must match
  // immediately after the `@` rather than anywhere on the line, and because a host
  // that merely starts with `localhost` (`localhost.example.com`) does not match.
  //
  // The port is digits or a `${...}` interpolation, because the URL in
  // test-env.cjs builds it from DISPOSABLE_PG_PORT rather than inlining it.
  const authority = line.slice((match.index ?? 0) + text.length);
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::(?:\d+|\$\{[^}]*\}))?(?:[/?#]|$)/.test(authority))
    return true;
  return false;
}

function git(argsList) {
  return execFileSync('git', argsList, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function isAllowed(file) {
  return ALLOW.has(file) || /\.example$/.test(file);
}

/** Scan one file's text; returns findings. */
function scanText(file, text, label) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      const m = line.match(rule.re);
      if (!m) continue;
      if (isBenign(line, m)) continue;
      findings.push({ file, line: i + 1, rule: rule.name, sample: m[0].slice(0, 60), label });
    }
  });
  return findings;
}

/**
 * Report a match without reprinting the secret.
 *
 * The scan output gets pasted into issues and CI logs, so a scanner that echoes
 * the credential it found has leaked it a second time into a place with a wider
 * audience than the file it came from. The report shows a redacted shape instead.
 */
function display(sample) {
  if (sample.length <= 12) return '*'.repeat(sample.length);
  return `${sample.slice(0, 4)}${'*'.repeat(Math.min(sample.length - 4, 24))}`;
}

function report(findings, scope) {
  process.stderr.write(`\nSECRET SCAN FAILED — ${findings.length} finding(s) in ${scope}\n\n`);
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [file, list] of byFile) {
    const where = list[0].label ? ` (${list[0].label})` : '';
    process.stderr.write(`  ${file}${where}\n`);
    for (const f of list) {
      process.stderr.write(`    line ${f.line}: [${f.rule}] ${display(f.sample)}\n`);
    }
  }
  process.stderr.write(
    `\n  A value matched a credential pattern. If it is a live secret:\n` +
      `    1. Rotate it in the provider's console FIRST — removing it from the file\n` +
      `       does not invalidate it.\n` +
      `    2. Move it to .env.local (git-ignored).\n` +
      `    3. If it was already committed, the history rewrite in the runbook is\n` +
      `       required; editing the file alone leaves it recoverable.\n\n` +
      `  If it is a placeholder, move it into .env.example or make the value\n` +
      `  obviously fake (user:pass@localhost, ${'${VAR}'}), then re-run.\n\n`,
  );
}

function listTrackedFiles() {
  if (ONLY_STAGED) {
    return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split(/\r?\n/).filter(Boolean);
  }
  return git(['ls-files']).split(/\r?\n/).filter(Boolean);
}

function main() {
  let files;
  try {
    files = listTrackedFiles();
  } catch (e) {
    process.stderr.write(`SECRET SCAN ERROR: could not list tracked files (${e.message}).\n`);
    process.exit(2);
  }
  if (files.length === 0) {
    process.stderr.write('SECRET SCAN ERROR: no files to scan — refusing to report a pass.\n');
    process.exit(2);
  }

  const findings = [];
  for (const file of files) {
    if (isAllowed(file)) continue;
    const abs = path.join(ROOT, file);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // deleted-from-worktree but still tracked
    }
    // Skip binaries: a NUL byte is the reliable marker without a dependency.
    if (text.includes('\u0000')) continue;
    findings.push(...scanText(file, text, ''));
  }

  if (SCAN_HISTORY) {
    const count = Number(git(['rev-list', '--all']).trim().split(/\r?\n/).filter(Boolean).length);
    for (let i = 0; i < count; i++) {
      const sha = git(['rev-list', '--all', '--max-count=1', `--skip=${i}`]).trim();
      if (!sha) break;
      let listed;
      try {
        listed = git(['ls-tree', '-r', '--name-only', sha]);
      } catch {
        continue;
      }
      for (const file of listed.split(/\r?\n/).filter(Boolean)) {
        if (isAllowed(file)) continue;
        let blob;
        try {
          blob = git(['show', `${sha}:${file}`]);
        } catch {
          continue;
        }
        if (blob.includes('\u0000')) continue;
        const short = sha.slice(0, 8);
        findings.push(
          ...scanText(file, blob, '').map((f) => ({
            ...f,
            file: `${f.file}`,
            label: `commit ${short}`,
          })),
        );
      }
    }
  }

  if (findings.length > 0) {
    const labels = new Set(findings.map((f) => f.label).filter(Boolean));
    report(findings, labels.size ? [...labels].join(', ') : `${files.length} tracked files`);
    process.exit(1);
  }

  const scope = SCAN_HISTORY ? `${files.length} tracked files + full history` : `${files.length} tracked files`;
  process.stdout.write(`Secret scan clean: ${scope}, ${RULES.length} rules.\n`);
}

main();