// Prints the CHANGELOG section of one version, for the GitHub release notes.
//
//   node scripts/release-notes.mjs 0.1.1
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>');
  process.exit(2);
}

const changelog = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf8');
const lines = changelog.split('\n');
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
if (end === -1) end = lines.length;

const notes = lines.slice(start + 1, end).join('\n').trim();
if (!notes) {
  console.error(`The CHANGELOG.md section for ${version} is empty`);
  process.exit(1);
}
console.log(notes);
