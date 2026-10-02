/**
 * Self-test for scripts/scan-secrets.cjs.
 *
 * WHY THIS TEST EXISTS — a secret scanner is only useful if it fails when it
 * should. A rule set that silently stopped matching (a refactor broke a regex,
 * an allowlist entry grew a `*`) would report "clean" forever while credentials
 * landed in the repository, which is the exact failure the scanner was added to
 * prevent. Nothing about the scanner's own output proves it still detects
 * anything, so this plants known credentials in a throwaway repo and asserts
 * each is caught.
 *
 * The planted values are syntactically valid and randomly shaped but are not
 * real credentials: this file is itself tracked, and a test fixture containing
 * a realistic live secret is the problem being solved.
 *
 * The scanner is invoked in a child process against a temporary git repo rather
 * than imported, because its real contract is its exit code — a scan that
 * "succeeds" in-process tells you nothing about whether CI would go red.
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCANNER = path.join(__dirname, '..', 'scripts', 'scan-secrets.cjs');

const temporaries: string[] = [];

after(() => {
  for (const dir of temporaries) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Create a throwaway git repo containing `files`, all staged as tracked. */
function makeRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-'));
  temporaries.push(dir);
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run(['init', '-q']);
  run(['config', 'user.email', 'scan-selftest@example.invalid']);
  run(['config', 'user.name', 'scan selftest']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  run(['add', '-A']);
  return dir;
}

function scan(root: string): { code: number | null; out: string } {
  const res = spawnSync(process.execPath, [SCANNER], {
    env: { ...process.env, SECRET_SCAN_ROOT: root },
    encoding: 'utf8',
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

describe('scan-secrets: detects planted credentials', () => {
  const detected = [
    {
      name: 'Neon API key in a connection string',
      file: 'a.js',
      body: "const u = 'postgresql://neondb_owner:npg_AbCdEf0123456789XYZW@ep-x.us-east-1.aws.neon.tech/neondb';",
    },
    {
      name: 'Postgres password in a URL',
      file: 'b.js',
      body: "const u = 'postgresql://user:S3cr3tPassw0rdXyz@db.internal:5432/app';",
    },
    {
      name: 'Redis Cloud password in a URL',
      file: 'c.ts',
      body: "new IORedis('redis://default:Xy9KpQrTuVw012345@inst-12345.db.redis.io:14995');",
    },
    {
      name: 'API key assigned as a bare literal',
      file: 'd.ts',
      body: "const GEMINI_API_KEY = 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY';",
    },
    {
      name: 'AWS access key id',
      file: 'e.txt',
      body: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    },
    {
      name: 'PEM private key block',
      file: 'f.pem',
      body: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----',
    },
    {
      // Alphanumeric only, as real ghp_ tokens are — an underscore here would
      // not be part of the token and the fixture would test nothing.
      name: 'GitHub personal access token',
      file: 'g.txt',
      body: 'token: ghp_aBcD1234eFgH5678iJkL9012mNoP3456',
    },
  ];

  for (const c of detected) {
    test(`flags ${c.name}`, () => {
      const { code, out } = scan(makeRepo({ [c.file]: c.body }));
      assert.notEqual(code, 0, `expected a non-zero exit, got ${code}\n${out}`);
      assert.match(out, /SECRET SCAN FAILED/);
    });
  }
});

describe('scan-secrets: does not cry wolf', () => {
  const allowed = [
    {
      name: 'the .env.example placeholder contract',
      file: '.env.example',
      body: 'DATABASE_URL=postgresql://user:password@localhost:5432/afro_genie',
    },
    {
      name: 'the shadow-URL example in the prisma config doc comment',
      file: 'prisma.config.ts',
      body: ' *   SHADOW_DATABASE_URL=postgresql://user:pass@localhost:5432/afrogenie_shadow\n',
    },
    {
      name: 'a connection URL with no password component',
      file: 'h.ts',
      body: "const u = 'postgresql://localhost:5432/afrogenie?schema=public';",
    },
    {
      name: 'a credential read from process.env',
      file: 'i.ts',
      body: "const redis = new IORedis(process.env.REDIS_URL!, {});",
    },
    {
      name: 'ordinary application source',
      file: 'src/app.ts',
      body: "export const db = process.env.DATABASE_URL;\nexport const n = 1 + 1;\n",
    },
  ];

  for (const c of allowed) {
    test(`passes ${c.name}`, () => {
      const { code, out } = scan(makeRepo({ [c.file]: c.body }));
      assert.equal(code, 0, `expected a clean exit, got ${code}\n${out}`);
      assert.match(out, /clean/i);
    });
  }
});

describe('scan-secrets: invariants', () => {
  test('refuses to report a pass when it cannot scan', () => {
    // A clean exit from a scan that never ran is the worst failure mode: it
    // looks identical to a clean repository.
    const dir = makeRepo({ 'readme.md': 'nothing to see' });
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    const { code } = scan(dir);
    assert.notEqual(code, 0, 'scanner passed on a non-git directory');
  });

  test('does not reprint the secret it found', () => {
    // Scan output is pasted into issues and CI logs, which have a wider
    // audience than the file the secret came from. Reporting it verbatim would
    // leak it a second time.
    const planted = 'postgresql://user:LeakedPw0123456789@db.internal:5432/app';
    const { out } = scan(makeRepo({ 'leak.js': `const u = '${planted}';` }));
    assert.notEqual(out.includes('LeakedPw0123456789'), true, 'scan report echoed the secret');
    assert.match(out, /SECRET SCAN FAILED/);
  });

  test('names the file and line so the finding is actionable', () => {
    const { out } = scan(makeRepo({ 'src/leak.js': "\n\nconst u = 'postgresql://user:Pw0123456789abcdef@db.internal:5432/app';\n" }));
    assert.match(out, /src\/leak\.js/);
    assert.match(out, /line 3/);
  });
});