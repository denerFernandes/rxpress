/*
 * `res.format()` (content negotiation) and `res.render()` (view rendering). Plain functions over
 * the response; `RxResponse` keeps thin methods that delegate here.
 */
import { extname } from 'node:path';
import type { Application } from './application.js';
import { loadNativeAddon } from './native.js';
import type { RxRequest } from './request.js';
import type { RxResponse } from './response.js';

/** Express `normalizeType`: a full type keeps its first part, an extension is looked up. */
function formatType(key: string): string {
  if (key.indexOf('/') !== -1) return key.split(/ *; */)[0];
  const ext = extname('x.' + key).toLowerCase().slice(1);
  const ct = ext ? loadNativeAddon().mimeContentType(ext) : null;
  return ct ? ct.split(';')[0] : 'application/octet-stream';
}

/** @internal `res.format()`, step for step as in Express 5. */
export function formatResponse(
  res: RxResponse,
  obj: Record<string, (req: RxRequest, res: RxResponse, next: (err?: unknown) => void) => unknown>
): void {
  const req = res.req;
  const next = req.next;
  const keys = Object.keys(obj).filter((k) => k !== 'default');
  const key = keys.length > 0 ? req.accepts(keys) : false;
  res.vary('Accept');

  if (key) {
    res.set('Content-Type', formatType(key as string));
    obj[key as string](req, res, next as (err?: unknown) => void);
  } else if (obj.default) {
    obj.default(req, res, next as (err?: unknown) => void);
  } else {
    const err = Object.assign(new Error('Not Acceptable'), {
      status: 406,
      statusCode: 406,
      expose: true,
      types: keys.map(formatType),
    });
    if (typeof next === 'function') next(err);
    else throw err;
  }
}

/**
 * Render a view with `res.locals` and send it (or hand it to `callback`), like Express:
 * rendering errors go to `next(err)`.
 * @internal
 */
export function renderView(
  res: RxResponse,
  view: string,
  options?: Record<string, unknown> | ((err: Error | null, html?: string) => void),
  callback?: (err: Error | null, html?: string) => void
): void {
  const req = res.req;
  let done = callback;
  let opts = (options ?? {}) as Record<string, unknown>;
  if (typeof options === 'function') {
    done = options;
    opts = {};
  }
  opts._locals = res.locals;
  const finish =
    done ??
    ((err: Error | null, html?: string) => {
      if (err) {
        if (typeof req.next === 'function') {
          req.next(err);
        } else {
          res.status(500).send('Internal Server Error');
        }
        return;
      }
      res.send(html);
    });
  // `req.app`: inside a mounted (sub-)app it renders with that app's views and engines.
  (req.app as unknown as { render: Application['render'] }).render(view, opts, finish);
}
