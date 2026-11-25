/*
 * `res.format()` (content negotiation) and `res.render()` (view rendering). Plain functions over
 * the response; `RxResponse` keeps thin methods that delegate here.
 */
import type { Application } from './application.js';
import type { RxResponse } from './response.js';

/** @internal */
export function formatResponse(res: RxResponse, obj: Record<string, () => unknown>): void {
  const defaultFn = obj.default;
  const keys = Object.keys(obj).filter((k) => k !== 'default');
  const matched = keys.length > 0 ? res.req.accepts(keys) : false;
  res.vary('Accept');

  if (typeof matched === 'string') {
    res.type(matched);
    obj[matched]();
  } else if (defaultFn) {
    defaultFn();
  } else {
    const err = Object.assign(new Error('Not Acceptable'), { status: 406, statusCode: 406 });
    throw err;
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
