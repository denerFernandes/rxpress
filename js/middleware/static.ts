import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { RxRequest } from '../request.js';
import type { RxResponse } from '../response.js';
import { UP_PATH_REGEXP } from '../security.js';
import type { NextFunction, RequestHandler, StaticOptions } from '../types.js';
import { nativeMiddlewareMeta } from './body-common.js';

/** @internal */
export const staticExtraMeta = new WeakMap<
  RequestHandler,
  { immutable: boolean; redirect: boolean }
>();

function collapseLeadingSlashes(s: string): string {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 0x2f) {
    i++;
  }
  return i > 1 ? '/' + s.slice(i) : s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Express-compatible `express.static(root, options)`.
 * Automatically accelerated 100% in Rust (zero JS crossing) when mounted before JS middlewares/routes
 * and without custom `setHeaders`, or streams via Rust `res.sendFile()` when inside a JS middleware chain.
 */
export function serveStatic(root: string, options: StaticOptions = {}): RequestHandler {
  if (!root) {
    throw new TypeError('root path required');
  }
  if (typeof root !== 'string') {
    throw new TypeError('root path must be a string');
  }
  if (options.setHeaders !== undefined && typeof options.setHeaders !== 'function') {
    throw new TypeError('option setHeaders must be function');
  }
  const dotfiles = options.dotfiles ?? 'ignore';
  if (dotfiles !== 'allow' && dotfiles !== 'deny' && dotfiles !== 'ignore') {
    throw new TypeError('option dotfiles must be "allow", "deny", or "ignore"');
  }

  const absRoot = resolve(root);
  const absRootPrefix = absRoot.endsWith(sep) ? absRoot : absRoot + sep;
  const index =
    options.index === false
      ? []
      : typeof options.index === 'string'
        ? [options.index]
        : Array.isArray(options.index)
          ? options.index
          : ['index.html'];
  const maxAgeSecs = parseMaxAgeSeconds(options.maxAge);
  const etag = options.etag !== false;
  const lastModified = options.lastModified !== false;
  const fallthrough = options.fallthrough !== false;
  const redirect = options.redirect !== false;
  const immutable = Boolean(options.immutable);
  const extensions = Array.isArray(options.extensions) ? options.extensions : [];

  let canonRootPromise: Promise<string | null> | null = null;
  const getCanonRoot = (): Promise<string | null> => {
    if (canonRootPromise === null) {
      canonRootPromise = realpath(absRoot).catch(() => null);
    }
    return canonRootPromise;
  };

  const resolveInsideRoot = async (
    candidate: string,
  ): Promise<{ path: string; stat: Stats } | 'forbidden' | null> => {
    const norm = normalize(candidate);
    if (norm !== absRoot && !norm.startsWith(absRootPrefix)) {
      return 'forbidden';
    }
    const canonRoot = await getCanonRoot();
    if (!canonRoot) return null;
    const canonPrefix = canonRoot.endsWith(sep) ? canonRoot : canonRoot + sep;

    let canonTarget: string;
    try {
      canonTarget = await realpath(norm);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        return 'forbidden';
      }
      return null;
    }

    if (canonTarget !== canonRoot && !canonTarget.startsWith(canonPrefix)) {
      return 'forbidden';
    }
    if (dotfiles !== 'allow' && canonTarget !== canonRoot) {
      const rel = canonTarget.slice(canonPrefix.length);
      const segs = rel.split(/[\\/]+/);
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (seg.length > 1 && seg.startsWith('.')) {
          return dotfiles === 'deny' ? 'forbidden' : null;
        }
      }
    }

    let st: Stats;
    try {
      st = await stat(canonTarget);
    } catch {
      return null;
    }
    return { path: canonTarget, stat: st };
  };

  const runAsync = async (req: RxRequest, res: RxResponse, next: NextFunction): Promise<void> => {
    let relPath: string;
    try {
      relPath = decodeURIComponent(req.path);
    } catch {
      res.status(400).send('Bad Request');
      return;
    }

    if (relPath.includes('\0')) {
      res.status(400).send('Bad Request');
      return;
    }
    if (UP_PATH_REGEXP.test(relPath)) {
      if (fallthrough) {
        next();
      } else {
        res.sendStatus(403);
      }
      return;
    }

    const segments = relPath.split('/').filter(Boolean);
    const hasDotfile = segments.some((s) => s.startsWith('.'));
    if (hasDotfile) {
      if (dotfiles === 'deny') {
        res.sendStatus(403);
        return;
      }
      if (dotfiles === 'ignore') {
        if (fallthrough) {
          next();
        } else {
          res.sendStatus(404);
        }
        return;
      }
    }

    const rawOrig = req.originalUrl || req.url || req.path || '/';
    const qIdx = rawOrig.indexOf('?');
    const origPath = qIdx >= 0 ? rawOrig.slice(0, qIdx) : rawOrig;
    const querySuffix = qIdx >= 0 ? rawOrig.slice(qIdx) : '';
    const hasTrailingSlash = origPath.endsWith('/');

    const candidate = join(absRoot, ...segments);
    let resolvedFile: string | null = null;
    let resolvedStat: Stats | null = null;

    const direct = await resolveInsideRoot(candidate);
    if (direct === 'forbidden') {
      res.sendStatus(403);
      return;
    }

    if (direct && direct.stat.isFile()) {
      if (hasTrailingSlash && segments.length > 0) {
        if (fallthrough) {
          next();
        } else {
          res.sendStatus(404);
        }
        return;
      }
      resolvedFile = direct.path;
      resolvedStat = direct.stat;
    } else if (direct && direct.stat.isDirectory()) {
      if (!hasTrailingSlash) {
        if (redirect) {
          const loc = (collapseLeadingSlashes(origPath + '/') + querySuffix).replace(
            /[\x00-\x1f\x7f]/g,
            '',
          );
          const doc =
            '<!DOCTYPE html>\n' +
            '<html lang="en">\n' +
            '<head>\n' +
            '<meta charset="utf-8">\n' +
            '<title>Redirecting</title>\n' +
            '</head>\n' +
            '<body>\n' +
            `<pre>Redirecting to ${escapeHtml(loc)}</pre>\n` +
            '</body>\n' +
            '</html>\n';
          res.status(301);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Content-Security-Policy', "default-src 'none'");
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Location', loc);
          res.end(doc);
          return;
        }
        if (fallthrough) {
          next();
        } else {
          res.sendStatus(404);
        }
        return;
      }

      for (const idx of index) {
        const idxRes = await resolveInsideRoot(join(candidate, idx));
        if (idxRes === 'forbidden') {
          res.sendStatus(403);
          return;
        }
        if (idxRes && idxRes.stat.isFile()) {
          resolvedFile = idxRes.path;
          resolvedStat = idxRes.stat;
          break;
        }
      }
    } else if (!direct && !hasTrailingSlash && !extname(candidate) && extensions.length > 0) {
      for (const ext of extensions) {
        const clean = ext.startsWith('.') ? ext : `.${ext}`;
        const extRes = await resolveInsideRoot(candidate + clean);
        if (extRes === 'forbidden') {
          res.sendStatus(403);
          return;
        }
        if (extRes && extRes.stat.isFile()) {
          resolvedFile = extRes.path;
          resolvedStat = extRes.stat;
          break;
        }
      }
    }

    if (!resolvedFile || !resolvedStat) {
      if (fallthrough) {
        next();
      } else {
        res.sendStatus(404);
      }
      return;
    }

    if (options.setHeaders) {
      try {
        (options.setHeaders as (r: RxResponse, p: string, st: Stats) => void)(
          res,
          resolvedFile,
          resolvedStat,
        );
      } catch (err) {
        next(err);
        return;
      }
    }

    if (!etag) {
      res._suppressEtag = true;
    }

    res.sendFile(
      resolvedFile,
      {
        maxAge: maxAgeSecs * 1000,
        cacheControl: true,
        immutable,
        lastModified,
        dotfiles: 'allow',
      },
      (err) => {
        if (err) {
          const st = (err as { status?: number }).status;
          if (fallthrough && st === 404) {
            next();
            return;
          }
          next(err);
        }
      },
    );
  };

  const handler: RequestHandler = (req: RxRequest, res: RxResponse, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (fallthrough) return next();
      res.status(405).setHeader('Allow', 'GET, HEAD').setHeader('Content-Length', '0').end();
      return;
    }
    void runAsync(req, res, next).catch((err) => {
      if (!res.writableEnded) {
        next(err);
      }
    });
  };

  staticExtraMeta.set(handler, { immutable, redirect });
  nativeMiddlewareMeta.set(handler, {
    __rxNativeKind: 'static',
    staticConfig: {
      root: absRoot,
      index,
      maxAgeSecs,
      etag,
      lastModified,
      dotfiles,
      fallthrough,
      extensions,
      hasSetHeaders: typeof options.setHeaders === 'function',
    },
  });
  return handler;
}

export function parseMaxAgeSeconds(maxAge: number | string | undefined): number {
  if (maxAge === undefined) return 0;
  if (typeof maxAge === 'number') return Math.max(0, Math.floor(maxAge / 1000));
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(maxAge.trim());
  if (!match) return 0;
  const n = parseFloat(match[1]);
  const u = (match[2] || 'ms').toLowerCase();
  switch (u) {
    case 's':
      return Math.floor(n);
    case 'm':
      return Math.floor(n * 60);
    case 'h':
      return Math.floor(n * 3600);
    case 'd':
      return Math.floor(n * 86400);
    default:
      return Math.floor(n / 1000);
  }
}
