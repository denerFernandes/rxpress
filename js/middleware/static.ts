import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { RxRequest } from '../request.js';
import type { RxResponse } from '../response.js';
import { UP_PATH_REGEXP, encodeUrl, httpError } from '../security.js';
import type { NextFunction, RequestHandler, StaticOptions } from '../types.js';
import { nativeMiddlewareMeta } from './body-common.js';

/** @internal */
export const staticExtraMeta = new WeakMap<
  RequestHandler,
  { immutable: boolean; redirect: boolean }
>();

/** `send`'s cap on `maxAge`: one year. */
const MAX_MAXAGE_MS = 60 * 60 * 24 * 365 * 1000;

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

/** `send`'s `normalizeList`. */
function normalizeList(val: unknown, name: string): string[] {
  const list = ([] as unknown[]).concat(val || []);
  for (let i = 0; i < list.length; i++) {
    if (typeof list[i] !== 'string') {
      throw new TypeError(name + ' must be array of strings or false');
    }
  }
  return list as string[];
}

/** `send`'s `containsDotFile`. */
function containsDotFile(parts: string[]): boolean {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.length > 1 && part[0] === '.') return true;
  }
  return false;
}

function splitUrl(url: string): { pathname: string; search: string } {
  const q = url.indexOf('?');
  return q === -1 ? { pathname: url, search: '' } : { pathname: url.slice(0, q), search: url.slice(q) };
}

/** `send`'s `parseTokenList`. */
function parseTokenList(str: string): string[] {
  const list: string[] = [];
  let start = 0;
  let end = 0;
  for (let i = 0; i < str.length; i++) {
    switch (str.charCodeAt(i)) {
      case 0x20:
        if (start === end) start = end = i + 1;
        break;
      case 0x2c:
        if (start !== end) list.push(str.substring(start, end));
        start = end = i + 1;
        break;
      default:
        end = i + 1;
        break;
    }
  }
  if (start !== end) list.push(str.substring(start, end));
  return list;
}

function parseHttpDate(date: unknown): number {
  const ts = typeof date === 'string' ? Date.parse(date) : NaN;
  return typeof ts === 'number' ? ts : NaN;
}

/** The ETag / Last-Modified the engine sends for a file (`etag`'s weak stat tag). */
function statEtag(st: Stats): string {
  return `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

/** `send`'s `isPreconditionFailure`, against the validators the engine will send. */
function isPreconditionFailure(
  req: RxRequest,
  res: RxResponse,
  st: Stats,
  etag: boolean,
  lastModified: boolean
): boolean {
  const match = req.headers['if-match'];
  if (match) {
    const set = res.getHeader('ETag');
    const tag =
      set !== undefined ? String(set) : etag && !res._suppressEtag ? statEtag(st) : undefined;
    return (
      !tag ||
      (match !== '*' &&
        parseTokenList(match).every((m) => m !== tag && m !== 'W/' + tag && 'W/' + m !== tag))
    );
  }
  const unmodifiedSince = parseHttpDate(req.headers['if-unmodified-since']);
  if (!Number.isNaN(unmodifiedSince)) {
    const set = res.getHeader('Last-Modified');
    const lm =
      set !== undefined
        ? parseHttpDate(String(set))
        : lastModified
          ? parseHttpDate(st.mtime.toUTCString())
          : NaN;
    return Number.isNaN(lm) || lm > unmodifiedSince;
  }
  return false;
}

/**
 * Express-compatible `express.static(root, options)` (`serve-static` over `send`).
 * Served by the engine without crossing into JS when mounted before JS middleware/routes,
 * without `setHeaders` and with the default `acceptRanges`/`cacheControl`; anything the engine
 * does not answer itself (errors, preconditions, misses) comes back through this handler.
 */
export function serveStatic(root: string, opts?: StaticOptions): RequestHandler {
  const options: StaticOptions = opts ?? {};
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
    throw new TypeError('dotfiles option must be "allow", "deny", or "ignore"');
  }

  const absRoot = resolve(root);
  const index =
    options.index === undefined ? ['index.html'] : normalizeList(options.index, 'index option');
  const extensions =
    options.extensions === undefined ? [] : normalizeList(options.extensions, 'extensions option');
  const maxAgeSecs = parseMaxAgeSeconds(options.maxAge);
  const etag = options.etag !== false;
  const lastModified = options.lastModified !== false;
  const fallthrough = options.fallthrough !== false;
  const redirect = options.redirect !== false;
  const immutable = Boolean(options.immutable);
  const acceptRanges = options.acceptRanges !== false;
  const cacheControl = options.cacheControl !== false;
  const setHeaders = options.setHeaders as
    | ((res: RxResponse, path: string, st: Stats) => void)
    | undefined;

  let canonRootPromise: Promise<string | null> | null = null;
  const getCanonRoot = (): Promise<string | null> => {
    if (canonRootPromise === null) {
      canonRootPromise = realpath(absRoot).catch(() => null);
    }
    return canonRootPromise;
  };

  /** Hardening on top of `send`: a symlink must not lead outside the root. */
  const escapesRoot = async (file: string): Promise<boolean> => {
    const canonRoot = await getCanonRoot();
    if (canonRoot === null) return false;
    let canon: string;
    try {
      canon = await realpath(file);
    } catch {
      return false;
    }
    const prefix = canonRoot.endsWith(sep) ? canonRoot : canonRoot + sep;
    return canon !== canonRoot && !canon.startsWith(prefix);
  };

  const statOrError = async (p: string): Promise<Stats | NodeJS.ErrnoException> => {
    try {
      return await stat(p);
    } catch (e) {
      return e as NodeJS.ErrnoException;
    }
  };

  const run = async (
    req: RxRequest,
    res: RxResponse,
    next: NextFunction,
    reqPath: string
  ): Promise<void> => {
    let forwardError = !fallthrough;
    const fail = (status: number, cause?: unknown): void => {
      const err = httpError(status, cause);
      if (forwardError || !(err.statusCode < 500)) {
        next(err);
        return;
      }
      next();
    };
    const statError = (e: NodeJS.ErrnoException): void => {
      const c = e.code;
      fail(c === 'ENAMETOOLONG' || c === 'ENOENT' || c === 'ENOTDIR' ? 404 : 500, e);
    };
    const hasTrailingSlash = reqPath[reqPath.length - 1] === '/';

    const sendFound = async (file: string, st: Stats): Promise<void> => {
      // `send` 'file' event: past this point a fall-through mount forwards errors.
      if (fallthrough) forwardError = true;
      if (await escapesRoot(file)) {
        fail(403);
        return;
      }
      if (res.headersSent) {
        fail(500, new Error("Can't set headers after they are sent."));
        return;
      }
      if (setHeaders) {
        try {
          setHeaders(res, file, st);
        } catch (err) {
          next(err);
          return;
        }
      }
      if (
        (req.headers['if-match'] || req.headers['if-unmodified-since']) &&
        isPreconditionFailure(req, res, st, etag, lastModified)
      ) {
        fail(412);
        return;
      }
      if (!etag) res._suppressEtag = true;
      res.sendFile(
        file,
        {
          maxAge: maxAgeSecs * 1000,
          cacheControl,
          acceptRanges,
          immutable,
          lastModified,
          dotfiles: 'allow',
        },
        (err) => {
          if (err) {
            const st2 = (err as { status?: number }).status ?? 500;
            fail(st2, err);
          }
        }
      );
    };

    const onDirectory = (): void => {
      if (!redirect || hasTrailingSlash) {
        fail(404);
        return;
      }
      const orig = splitUrl(req.originalUrl || req.url || '/');
      const loc = encodeUrl(collapseLeadingSlashes(orig.pathname + '/') + orig.search);
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
      res.statusCode = 301;
      res.setHeader('Content-Type', 'text/html; charset=UTF-8');
      res.setHeader('Content-Length', Buffer.byteLength(doc));
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Location', loc);
      res.end(doc);
    };

    // send.pipe()
    let path: string;
    try {
      path = decodeURIComponent(reqPath);
    } catch {
      fail(400);
      return;
    }
    if (path.includes('\0')) {
      fail(400);
      return;
    }
    if (path) path = normalize('.' + sep + path);
    if (UP_PATH_REGEXP.test(path)) {
      fail(403);
      return;
    }
    const parts = path.split(sep);
    path = normalize(join(absRoot, path));

    if (containsDotFile(parts)) {
      if (dotfiles === 'deny') {
        fail(403);
        return;
      }
      if (dotfiles === 'ignore') {
        fail(404);
        return;
      }
    }

    if (index.length && hasTrailingSlash) {
      // send.sendIndex()
      let lastErr: NodeJS.ErrnoException | undefined;
      for (const idx of index) {
        const p = join(path, idx);
        const st = await statOrError(p);
        if (st instanceof Error) {
          lastErr = st;
          continue;
        }
        if (st.isDirectory()) {
          lastErr = undefined;
          continue;
        }
        await sendFound(p, st);
        return;
      }
      if (lastErr) statError(lastErr);
      else fail(404);
      return;
    }

    // send.sendFile()
    const st = await statOrError(path);
    const endsWithSep = path[path.length - 1] === sep;
    if (st instanceof Error) {
      if (st.code === 'ENOENT' && !extname(path) && !endsWithSep) {
        let lastErr: NodeJS.ErrnoException | undefined = st;
        for (const ext of extensions) {
          const p = path + '.' + ext;
          const est = await statOrError(p);
          if (est instanceof Error) {
            lastErr = est;
            continue;
          }
          if (est.isDirectory()) {
            lastErr = undefined;
            continue;
          }
          await sendFound(p, est);
          return;
        }
        if (lastErr) statError(lastErr);
        else fail(404);
        return;
      }
      statError(st);
      return;
    }
    if (st.isDirectory()) {
      onDirectory();
      return;
    }
    if (endsWithSep) {
      fail(404);
      return;
    }
    await sendFound(path, st);
  };

  const handler: RequestHandler = (req: RxRequest, res: RxResponse, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (fallthrough) return next();
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }
    let path = splitUrl(req.url || '/').pathname;
    if (path === '/' && !splitUrl(req.originalUrl || req.url || '/').pathname.endsWith('/')) {
      path = '';
    }
    void run(req, res, next, path).catch((err) => {
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
      jsOnly: !acceptRanges || !cacheControl,
    },
  });
  return handler;
}

/** `maxAge` in whole seconds, as `send` computes it (`ms` strings, capped at one year). */
export function parseMaxAgeSeconds(maxAge: number | string | undefined): number {
  if (maxAge === undefined) return 0;
  let ms: number;
  if (typeof maxAge === 'number') {
    ms = maxAge;
  } else {
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(maxAge.trim());
    if (!match) return 0;
    const n = parseFloat(match[1]);
    const unit = (match[2] || 'ms').toLowerCase();
    const mult = unit === 's' ? 1e3 : unit === 'm' ? 6e4 : unit === 'h' ? 36e5 : unit === 'd' ? 864e5 : 1;
    ms = n * mult;
  }
  if (Number.isNaN(ms)) return 0;
  return Math.floor(Math.min(Math.max(0, ms), MAX_MAXAGE_MS) / 1000);
}
