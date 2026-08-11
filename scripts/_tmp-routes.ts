import { readdirSync, readFileSync } from 'node:fs';

const dir = 'src/routes';
for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
  const c = readFileSync(`${dir}/${f}`, 'utf8');
  const matches = [...c.matchAll(/\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g)];
  if (matches.length) {
    console.log(`== ${f}`);
    for (const m of matches) console.log(`  ${m[1].toUpperCase()} ${m[2]}`);
  }
}
