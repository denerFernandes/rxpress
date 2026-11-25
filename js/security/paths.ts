import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { normalize, resolve, sep } from 'node:path';

// ---- Path Containment ----

export const UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

export async function resolveSafePath(
  root: string,
  relPath: string,
  dotfiles: 'allow' | 'deny' | 'ignore' = 'ignore'
): Promise<{ path: string; stat: Stats } | 'forbidden' | null> {
  const absRoot = resolve(root);
  const absRootPrefix = absRoot.endsWith(sep) ? absRoot : absRoot + sep;
  const rel = relPath.replace(/^[\\/]+/, '');
  if (UP_PATH_REGEXP.test(rel) || rel === '..') {
    return 'forbidden';
  }
  const normRel = normalize('.' + sep + rel);
  if (UP_PATH_REGEXP.test(normRel) || normRel === '..') {
    return 'forbidden';
  }
  const candidate = resolve(absRoot, normRel);
  if (candidate !== absRoot && !candidate.startsWith(absRootPrefix)) {
    return 'forbidden';
  }

  let canonRoot: string;
  let canonTarget: string;
  try {
    [canonRoot, canonTarget] = await Promise.all([realpath(absRoot), realpath(candidate)]);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      return 'forbidden';
    }
    return null;
  }

  const canonPrefix = canonRoot.endsWith(sep) ? canonRoot : canonRoot + sep;
  if (canonTarget !== canonRoot && !canonTarget.startsWith(canonPrefix)) {
    return 'forbidden';
  }

  if (dotfiles !== 'allow' && canonTarget !== canonRoot) {
    const relReal = canonTarget.slice(canonPrefix.length);
    const segs = relReal.split(/[\\/]+/);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.length > 1 && seg.startsWith('.')) {
        return dotfiles === 'deny' ? 'forbidden' : null;
      }
    }
  }

  try {
    const st = await stat(canonTarget);
    return { path: canonTarget, stat: st };
  } catch {
    return null;
  }
}

