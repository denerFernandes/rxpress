// Copies the root package.json version into every npm/<triple>/package.json and into the root
// optionalDependencies, so the platform packages always match the main package.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootPath = join(rootDir, 'package.json');
const root = JSON.parse(readFileSync(rootPath, 'utf8'));
const version = root.version;

for (const dir of readdirSync(join(rootDir, 'npm'), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const p = join(rootDir, 'npm', dir.name, 'package.json');
  if (!existsSync(p)) continue;
  const pkg = JSON.parse(readFileSync(p, 'utf8'));
  pkg.version = version;
  writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  if (root.optionalDependencies && pkg.name in root.optionalDependencies) {
    root.optionalDependencies[pkg.name] = version;
  }
}
writeFileSync(rootPath, JSON.stringify(root, null, 2) + '\n');
console.log(`[rxpress] Synced platform packages to version ${version}`);
