import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const isDebug = process.argv.includes('--debug');
const profile = isDebug ? 'debug' : 'release';

// `--target <rust-triple>` cross/target builds; the artifact is also copied to npm/<triple>/.
const targetIdx = process.argv.indexOf('--target');
const target = targetIdx !== -1 ? process.argv[targetIdx + 1] : undefined;
if (targetIdx !== -1 && (!target || target.startsWith('--'))) {
  throw new Error('--target requires a Rust target triple');
}

// Rust target triple -> npm platform suffix (npm/<suffix>, package rxpress-<suffix>).
const TARGETS = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'x86_64-unknown-linux-gnu': 'linux-x64-gnu',
  'x86_64-unknown-linux-musl': 'linux-x64-musl',
  'aarch64-unknown-linux-gnu': 'linux-arm64-gnu',
  'aarch64-unknown-linux-musl': 'linux-arm64-musl',
  'x86_64-pc-windows-msvc': 'win32-x64-msvc',
};
const suffix = target ? TARGETS[target] : undefined;
if (target && !suffix) {
  throw new Error(`Unsupported --target ${target}. Supported: ${Object.keys(TARGETS).join(', ')}`);
}

const args = ['build'];
if (!isDebug) {
  args.push('--release');
}
if (target) {
  args.push('--target', target);
}

console.log(`[rxpress] Building Rust native addon (${profile})...`);
execSync(`cargo ${args.join(' ')}`, {
  cwd: rootDir,
  stdio: 'inherit',
});

// Artifact naming follows the *target* platform, not the host.
const targetOs = target
  ? target.includes('apple-darwin')
    ? 'darwin'
    : target.includes('windows')
      ? 'win32'
      : 'linux'
  : process.platform;
const libPrefix = targetOs === 'win32' ? '' : 'lib';
const libExt = targetOs === 'darwin' ? '.dylib' : targetOs === 'win32' ? '.dll' : '.so';

const srcPath = join(rootDir, 'target', ...(target ? [target] : []), profile, `${libPrefix}rxpress_native${libExt}`);
const outDir = join(rootDir, 'native');
const dstPath = join(outDir, 'rxpress.node');

if (!existsSync(srcPath)) {
  throw new Error(`Compiled native library not found at ${srcPath}`);
}

mkdirSync(outDir, { recursive: true });
if (existsSync(dstPath)) {
  unlinkSync(dstPath);
}
copyFileSync(srcPath, dstPath);
console.log(`[rxpress] Native addon ready: ${dstPath}`);

if (suffix) {
  const pkgDir = join(rootDir, 'npm', suffix);
  const pkgDst = join(pkgDir, `rxpress.${suffix}.node`);
  mkdirSync(pkgDir, { recursive: true });
  copyFileSync(srcPath, pkgDst);
  console.log(`[rxpress] Platform package binary ready: ${pkgDst}`);
}
