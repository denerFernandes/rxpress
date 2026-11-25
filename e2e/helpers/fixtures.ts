import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempWorkspace {
  dir: string;
  resolve(...parts: string[]): string;
  mkdir(rel: string): string;
  writeFile(rel: string, content: string | Buffer): string;
  writeSymlink(rel: string, target: string): string;
  cleanup(): void;
}

export interface SetupConsumerPackageOptions {
  type?: 'module' | 'commonjs';
  linkDeps?: string[];
  name?: string;
}

export function createTempWorkspace(prefix = 'rxpress-e2e-'): TempWorkspace {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  const resolve = (...parts: string[]): string => join(dir, ...parts);

  const mkdir = (rel: string): string => {
    const target = resolve(rel);
    mkdirSync(target, { recursive: true });
    return target;
  };

  const writeFile = (rel: string, content: string | Buffer): string => {
    const target = resolve(rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return target;
  };

  const writeSymlink = (rel: string, target: string): string => {
    const linkPath = resolve(rel);
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(target, linkPath);
    return linkPath;
  };

  const cleanup = (): void => {
    rmSync(dir, { recursive: true, force: true });
  };

  return {
    dir,
    resolve,
    mkdir,
    writeFile,
    writeSymlink,
    cleanup,
  };
}

export function setupConsumerPackage(
  ws: TempWorkspace,
  repoRoot: string,
  opts?: SetupConsumerPackageOptions
): { packageJsonPath: string; nodeModulesDir: string } {
  const pkgType = opts?.type ?? 'commonjs';
  const pkgName = opts?.name ?? 'rxpress-e2e-consumer';
  const pkgJson: Record<string, unknown> = {
    name: pkgName,
    version: '1.0.0',
    private: true,
    type: pkgType,
  };

  const packageJsonPath = ws.writeFile('package.json', JSON.stringify(pkgJson, null, 2));
  const nodeModulesDir = ws.mkdir('node_modules');

  const rxpressLink = join(nodeModulesDir, 'rxpress');
  if (!existsSync(rxpressLink)) {
    symlinkSync(repoRoot, rxpressLink, 'dir');
  }

  for (const dep of opts?.linkDeps ?? []) {
    const src = join(repoRoot, 'node_modules', ...dep.split('/'));
    if (!existsSync(src)) {
      throw new Error(`Requested linkDep "${dep}" does not exist at ${src}`);
    }
    const dest = join(nodeModulesDir, ...dep.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) {
      symlinkSync(src, dest, 'dir');
    }
  }

  return { packageJsonPath, nodeModulesDir };
}
