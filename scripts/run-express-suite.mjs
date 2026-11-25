// Runs Express's own test suite against rxpress.
//
//   npm run build && node scripts/run-express-suite.mjs [--update] [--json <file>]
//
// The Express repository is cloned at the version installed in node_modules into compat/
// (git-ignored; not a dot directory, since `send` refuses paths with dot segments), its dev
// dependencies are installed, and its `index.js` is replaced with a re-export of rxpress's
// CommonJS build. Everything else (tests, fixtures, lib/utils used by the
// tests for the method list) stays as published by Express.
//
// test/express-suite/known-failures.json lists the tests that are expected to fail today. The
// script exits non-zero when a test outside that list fails (a regression). Tests on the list
// that now pass are reported; run with --update to rewrite the list from the current results.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const update = args.includes('--update');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;

const version = require('express/package.json').version;
const workDir = join(root, 'compat', `express-${version}`);
const manifestPath = join(root, 'test', 'express-suite', 'known-failures.json');
const resultPath = join(root, 'compat', `express-${version}-results.json`);

if (!existsSync(join(root, 'dist', 'index.cjs'))) {
  console.error('dist/index.cjs not found: run `npm run build` first.');
  process.exit(2);
}

if (!existsSync(join(workDir, 'package.json'))) {
  mkdirSync(join(root, 'compat'), { recursive: true });
  console.log(`Cloning expressjs/express v${version}...`);
  execFileSync(
    'git',
    ['clone', '--quiet', '--depth', '1', '--branch', `v${version}`, 'https://github.com/expressjs/express.git', workDir],
    { stdio: 'inherit' }
  );
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], {
    cwd: workDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

writeFileSync(
  join(workDir, 'index.js'),
  `'use strict';\nmodule.exports = require(${JSON.stringify(join(root, 'dist', 'index.cjs'))});\n`
);

const mocha = join(workDir, 'node_modules', 'mocha', 'bin', 'mocha.js');
const run = spawnSync(
  process.execPath,
  [
    mocha,
    '--require', 'test/support/env',
    '--reporter', 'json',
    '--reporter-option', `output=${resultPath}`,
    '--check-leaks',
    '--timeout', '4000',
    '--exit',
    'test/',
    'test/acceptance/',
  ],
  { cwd: workDir, stdio: ['ignore', 'ignore', 'inherit'], timeout: 15 * 60_000 }
);
if (!existsSync(resultPath)) {
  console.error(`mocha produced no results (status ${run.status}, signal ${run.signal}).`);
  process.exit(2);
}

const results = JSON.parse(readFileSync(resultPath, 'utf8'));
const id = (t) => `${t.file.split(/[\\/]test[\\/]/).pop().replace(/\\/g, '/')} :: ${t.fullTitle}`;
const failing = [...new Set(results.failures.map(id))].sort();
const { tests, passes } = results.stats;
const rate = ((passes / tests) * 100).toFixed(1);
console.log(`Express ${version} test suite: ${passes}/${tests} passed (${rate}%)`);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ express: version, tests, passes, rate: Number(rate), failing }, null, 2) + '\n');
}

if (update) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(failing, null, 2) + '\n');
  console.log(`Wrote ${failing.length} known failures to ${manifestPath}`);
  process.exit(0);
}

const known = new Set(existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : []);
const regressions = failing.filter((t) => !known.has(t));
const fixed = [...known].filter((t) => !failing.includes(t));

if (fixed.length) {
  console.log(`\n${fixed.length} test(s) on the known-failures list now pass (run with --update):`);
  for (const t of fixed) console.log(`  + ${t}`);
}
if (regressions.length) {
  console.log(`\n${regressions.length} unexpected failure(s):`);
  for (const t of regressions) {
    const f = results.failures.find((x) => id(x) === t);
    console.log(`  - ${t}\n      ${String(f?.err?.message ?? '').split('\n')[0]}`);
  }
  process.exit(1);
}
console.log('No unexpected failures.');
