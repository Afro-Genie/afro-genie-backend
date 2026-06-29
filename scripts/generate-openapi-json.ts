import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const templatePath = path.join(root, 'docs', 'api-docs', 'openapi.template.json');
const outPath = path.join(root, 'docs', 'api-docs', 'openapi.json');

interface PackageJson {
  version?: string;
}

const packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
const spec = JSON.parse(fs.readFileSync(templatePath, 'utf8')) as Record<string, unknown>;

const nowIso = new Date().toISOString();
const version = packageJson.version || '0.0.0';

const info = (spec.info as Record<string, unknown>) || {};
info.version = version;
spec.info = info;
spec['x-generatedAt'] = nowIso;

const gitSha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA;
if (gitSha) {
  spec['x-commitSha'] = gitSha;
}

fs.writeFileSync(outPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
console.log(`OpenAPI JSON generated: ${path.relative(root, outPath)}`);
