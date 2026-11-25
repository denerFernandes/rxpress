import type { Router } from '../router.js';
import type { RxRequest } from '../request.js';
import type { RxResponse } from '../response.js';
import type { ErrorRequestHandler, NextFunction, ParamHandler, RequestHandler } from '../types.js';
import type { AnyHandler, Layer } from './layer.js';
import type { PathMatchResult } from './path-compile.js';

/** @internal Internal failures while advancing the stack always carry an error. */
export function normalizeThrownError(err: unknown): unknown {
  return err === undefined || err === null ? new Error('Unhandled error') : err;
}

/** @internal router@2: a promise rejected with a falsy value still counts as an error. */
export function rejectionError(err: unknown): unknown {
  return err || new Error('Rejected promise');
}

/** @internal */
export function flattenHandlers(input: unknown[]): Array<AnyHandler | Router> {
  const out: Array<AnyHandler | Router> = [];
  for (const item of input) {
    if (Array.isArray(item)) {
      out.push(...flattenHandlers(item));
    } else if (item !== undefined && item !== null) {
      out.push(item as AnyHandler | Router);
    }
  }
  return out;
}

/**
 * Invoke a sync or async Express 4/5 handler safely, auto-catching thrown errors
 * AND rejected Promises (Express 5 semantics).
 * @internal
 */
export function invokeHandler(
  fn: AnyHandler,
  err: unknown,
  req: RxRequest,
  res: RxResponse,
  next: NextFunction
): void {
  let called = false;
  const safeNext: NextFunction = (nextErr?: unknown) => {
    if (called) return;
    called = true;
    next(nextErr);
  };

  try {
    req.next = safeNext;
  } catch {
    // `req` was frozen/sealed by user code: the handler still receives `safeNext` directly.
  }

  try {
    const ret =
      err !== undefined && err !== null
        ? (fn as ErrorRequestHandler)(err, req, res, safeNext)
        : (fn as RequestHandler)(req, res, safeNext);

    if (ret && typeof (ret as PromiseLike<unknown>).then === 'function') {
      (ret as PromiseLike<unknown>).then(undefined, (rejected: unknown) => {
        if (!res.writableEnded) {
          safeNext(rejectionError(rejected));
        }
      });
    }
  } catch (thrown) {
    if (!res.writableEnded) {
      safeNext(thrown);
    }
  }
}

function recordOptionsMethods(req: RxRequest, layer: Layer): void {
  if (req._optionsMethods == null) {
    req._optionsMethods = [];
  }
  const add = (m: string) => {
    if (m === 'ALL') return;
    req._optionsMethods!.push(m);
    if (m === 'GET') req._optionsMethods!.push('HEAD');
  };
  if (layer.isRoute && layer.route) {
    for (const rl of layer.route.stack) {
      add(rl.method);
    }
  } else if (layer.method) {
    add(layer.method);
  }
}

/** OPTIONS request reached a layer of another method: its methods join `Allow` if the path matches. */
function recordOptionsIfMatched(req: RxRequest, layer: Layer, currentPath: string): void {
  let optMatch: PathMatchResult | null = null;
  try {
    optMatch = layer.matcher.match(currentPath);
  } catch {
    // undecodable param: this layer simply does not contribute to Allow
  }
  if (optMatch) recordOptionsMethods(req, layer);
}

/** router@2 `getProtohost`: the `scheme://host` of an absolute-form URL, if any. */
function protohostOf(url: string): string {
  if (url.length === 0 || url.charCodeAt(0) === 0x2f) return '';
  const q = url.indexOf('?');
  const fqdn = url.slice(0, q === -1 ? url.length : q).indexOf('://');
  if (fqdn === -1) return '';
  const slash = url.indexOf('/', fqdn + 3);
  return slash === -1 ? url : url.slice(0, slash);
}

/**
 * Pathname the layers match against; `undefined` for a missing or blank URL (router@2 then
 * skips the whole stack). Requests built by the engine take their cached `req.path`.
 */
function pathOf(req: RxRequest, url: string | undefined, protohost: string): string | undefined {
  if (typeof url !== 'string' || url.length === 0) return undefined;
  if (protohost === '') {
    const p = (req as { path?: unknown }).path;
    if (typeof p === 'string') return p;
  }
  const q = url.indexOf('?');
  const path = url.slice(protohost.length, q === -1 ? url.length : q);
  return path.length === 0 ? '/' : path;
}

/**
 * router@2 `mergeParams`: parent params first, then the layer's; numeric (unnamed-capture)
 * indices of the layer are shifted after the parent's so neither side is lost.
 */
function mergeParams(
  params: Record<string, string>,
  parent: Record<string, string> | undefined
): Record<string, string> {
  const obj: Record<string, string> = Object.assign(Object.create(null), parent);
  if (typeof parent !== 'object' || parent === null || !('0' in params) || !('0' in parent)) {
    return Object.assign(obj, params);
  }
  let i = 0;
  let o = 0;
  while (String(i) in params) i++;
  while (String(o) in parent) o++;
  const shifted: Record<string, string> = Object.assign(Object.create(null), params);
  for (i--; i >= 0; i--) {
    shifted[String(i + o)] = params[String(i)];
    if (i < o) delete shifted[String(i)];
  }
  return Object.assign(obj, shifted);
}

/** router@2 yields to the event loop every 100 synchronous `next()` calls. */
const MAX_SYNC_STACK = 100;

/**
 * Body of `Router#handle`: execute `router`'s middleware & route stack on `(req, res)`
 * starting at `startIndex`.
 * @internal
 */
export function handleRouter(
  router: Router,
  req: RxRequest,
  res: RxResponse,
  out: NextFunction,
  startIndex: number,
  initialError: unknown
): void {
  const stack = router.stack;
  let idx = startIndex;
  // router@2 records the URL first seen (requests not built by the engine have none).
  if (!req.originalUrl) (req as { originalUrl?: string }).originalUrl = req.url;
  const parentParams = req.params;
  const parentBaseUrl = req.baseUrl || '';
  const parentApp = req.app;
  const paramCalled = new Map<string, ParamCall>();
  // Mount prefix moved from `req.url` to `req.baseUrl` for the current layer (router@2).
  let removed = '';
  let slashAdded = false;
  let sync = 0;

  const restore = () => {
    req.baseUrl = parentBaseUrl;
    req.params = parentParams;
    req.app = parentApp;
    res.app = parentApp;
  };

  // Framework-internal failures while advancing the stack (e.g. user code froze `req`,
  // so `req.baseUrl = ...` throws) must reach `out` instead of being swallowed by the
  // caller's already-consumed `safeNext`, which would leave the request hanging forever.
  const next: NextFunction = (err?: unknown) => {
    try {
      step(err);
    } catch (internalErr) {
      out(normalizeThrownError(internalErr));
    }
  };

  const step = (err?: unknown): void => {
    let layerError: unknown = err === 'route' || err === null ? undefined : err;

    // Put back what the previous layer's mount stripped; keep any rewrite it made.
    if (slashAdded) {
      req.url = req.url.slice(1);
      slashAdded = false;
    }
    if (removed.length !== 0) {
      const ph = protohostOf(req.url);
      req.baseUrl = parentBaseUrl;
      req.url = ph + removed + req.url.slice(ph.length);
      removed = '';
    }

    if (layerError === 'router') {
      restore();
      return out();
    }

    if (++sync > MAX_SYNC_STACK) {
      sync = 0;
      setImmediate(next, err);
      return;
    }

    const url = req.url;
    const protohost = typeof url === 'string' ? protohostOf(url) : '';
    const currentPath = pathOf(req, url, protohost);
    if (currentPath === undefined) {
      restore();
      return out(layerError);
    }

    const m = typeof req.method === 'string' ? req.method.toUpperCase() : req.method;
    // Skip non-matching layers in a loop (no recursion: thousands of routes are fine).
    let layer: Layer;
    let match: PathMatchResult | null = null;
    for (;;) {
      if (idx >= stack.length) {
        restore();
        return out(layerError);
      }
      layer = stack[idx++];

      // Error-handler matching check
      if (layerError !== undefined && !layer.isRouter && !layer.isErrorHandler) continue;
      if (layerError === undefined && layer.isErrorHandler) continue;

      // Method check for route layers
      if (layer.method !== null) {
        const methodOk =
          layer.method === 'ALL' ||
          layer.method === m ||
          (m === 'HEAD' && layer.method === 'GET');
        if (!methodOk) {
          if (m === 'OPTIONS' && layerError === undefined) {
            recordOptionsIfMatched(req, layer, currentPath);
          }
          continue;
        }
      }

      // Path match
      try {
        match = layer.matcher.match(currentPath);
      } catch (decodeErr) {
        // Express: a param that fails to decode becomes the layer error (400).
        if (layerError === undefined) layerError = decodeErr;
        continue;
      }
      if (match) break;
    }

    req.app = parentApp;
    res.app = parentApp;

    // Merge params according to router options using null-prototype map
    const mergedParams: Record<string, string> = router._options.mergeParams
      ? mergeParams(match.params, parentParams)
      : Object.assign(Object.create(null), match.params);
    req.params = mergedParams;

    const runLayer = (paramErr?: unknown) => {
      if (paramErr !== undefined && paramErr !== null) {
        next(layerError ?? paramErr);
      } else if (layer.isRouter || layer.method === null) {
        // Mounted middleware/sub-router: move the matched prefix from `req.url` to `req.baseUrl`.
        const matched = match!.matchedPath;
        if (matched.length > 0 && matched !== '/') {
          removed = matched;
          req.url = protohost + req.url.slice(protohost.length + removed.length);
          if (protohost === '' && req.url.charCodeAt(0) !== 0x2f) {
            req.url = '/' + req.url;
            slashAdded = true;
          }
          req.baseUrl =
            parentBaseUrl + (removed.endsWith('/') ? removed.slice(0, -1) : removed);
        }
        if (layer.isRouter) {
          if (layer.subApp) {
            req.app = layer.subApp;
            res.app = layer.subApp;
          }
          (layer.handle as Router).handle(req, res, next, 0, layerError);
        } else {
          invokeHandler(layer.handle as AnyHandler, layerError, req, res, next);
        }
      } else {
        if (layer.route && !layer.isRoute) {
          req.route = layer.route;
        }
        invokeHandler(layer.handle as AnyHandler, layerError, req, res, next);
      }
      sync = 0;
    };

    // Run router.param() handlers for matched params (if any)
    if (layerError === undefined && router.params.size > 0) {
      const keys = Object.keys(match.params);
      if (keys.length > 0) {
        return processParams(router.params, keys, match.params, paramCalled, req, res, runLayer);
      }
    }

    runLayer();
  };

  next(initialError);
}

/**
 * Run `router.param()` callbacks for the matched `keys`, then `done`.
 * @internal
 */
export function processParams(
  params: Map<string, ParamHandler[]>,
  keys: string[],
  values: Record<string, string>,
  called: Map<string, ParamCall>,
  req: RxRequest,
  res: RxResponse,
  done: NextFunction
): void {
  let keyIdx = 0;

  const nextKey = (err?: unknown) => {
    if (err !== undefined && err !== null && err !== false) return done(err);

    while (keyIdx < keys.length) {
      const name = keys[keyIdx++];
      const val = values[name];
      const callbacks = params.get(name);
      if (val === undefined || !callbacks || callbacks.length === 0) continue;
      // router@2: once per value per request; a later layer sees the value the callbacks left
      // in req.params, and an error (other than 'route') sticks for every value.
      const prev = called.get(name);
      if (prev && (prev.match === val || (prev.error && prev.error !== 'route'))) {
        req.params[name] = prev.value;
        if (prev.error) return done(prev.error);
        continue;
      }
      const call: ParamCall = { match: val, value: val, error: undefined };
      called.set(name, call);

      let cbIdx = 0;
      const nextCb: NextFunction = (cbErr?: unknown) => {
        call.value = req.params[name];
        if (cbErr !== undefined && cbErr !== null && cbErr !== false) {
          call.error = cbErr;
          return done(cbErr);
        }
        if (cbIdx >= callbacks.length) return nextKey();
        const cb = callbacks[cbIdx++];
        let cbCalled = false;
        const safeCbNext: NextFunction = (errArg?: unknown) => {
          if (cbCalled) return;
          cbCalled = true;
          nextCb(errArg);
        };
        req.next = safeCbNext;
        try {
          const ret = cb(req, res, safeCbNext, val, name);
          if (ret && typeof (ret as PromiseLike<unknown>).then === 'function') {
            (ret as PromiseLike<unknown>).then(undefined, (rej: unknown) => {
              safeCbNext(rejectionError(rej));
            });
          }
        } catch (thrown) {
          safeCbNext(thrown);
        }
      };
      nextCb();
      return;
    }
    done();
  };

  nextKey();
}

/** @internal Per-request record of a `router.param()` callback run (router@2 `paramCalled`). */
export interface ParamCall {
  match: string;
  value: string;
  error: unknown;
}
