// Fails when `npm pack` would publish something other than the built package.
//
//   npm pack --dry-run --json | node scripts/check-pack.mjs
import { readFileSync } from 'node:fs';

const [pack] = JSON.parse(readFileSync(0, 'utf8'));
const paths = pack.files.map((f) => f.path);
const allowed = (p) => p.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'].includes(p);
const required = ['dist/index.mjs', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts', 'package.json', 'README.md', 'LICENSE'];

const unexpected = paths.filter((p) => !allowed(p));
const missing = required.filter((p) => !paths.includes(p));
if (unexpected.length || missing.length) {
  if (unexpected.length) console.error(`Unexpected files in the package:\n  ${unexpected.join('\n  ')}`);
  if (missing.length) console.error(`Missing files in the package:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`${pack.name}@${pack.version}: ${paths.length} files, ${(pack.size / 1024).toFixed(0)} kB packed`);
