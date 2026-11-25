import type { Router } from '../router.js';
import type { RxRequest } from '../request.js';
import type { RxResponse } from '../response.js';
import type { ErrorRequestHandler, NextFunction, ParamHandler, RequestHandler } from '../types.js';
import type { AnyHandler, Layer } from './layer.js';
import type { PathMatchResult } from './path-compile.js';

/** @internal */
export function normalizeThrownError(err: unknown): unknown {
  return err === undefined || err === null ? new Error('Unhandled error') : err;
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
          safeNext(normalizeThrownError(rejected));
        }
      });
    }
  } catch (thrown) {
    if (!res.writableEnded) {
      safeNext(normalizeThrownError(thrown));
    }
  }
}

function recordOptionsMethods(req: RxRequest, layer: Layer): void {
  if (req._optionsMethods === null) {
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

/** Mounted middleware/sub-router: move the matched prefix from `req.url` to `req.baseUrl`. */
function stripMountPrefix(
  req: RxRequest,
  matchedPath: string,
  parentBaseUrl: string,
  parentUrl: string
): void {
  const prefix = matchedPath.endsWith('/') ? matchedPath.slice(0, -1) : matchedPath;
  req.baseUrl = parentBaseUrl + prefix;
  const stripped = parentUrl.slice(prefix.length);
  req.url = stripped.startsWith('/') ? stripped : '/' + stripped;
}

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
  const parentParams = req.params;
  const parentBaseUrl = req.baseUrl;
  const parentUrl = req.url;
  const parentApp = req.app;
  const paramCalled = new Map<string, string>();

  const restore = () => {
    req.baseUrl = parentBaseUrl;
    req.url = parentUrl;
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
    let layerError = err === 'route' || err === null ? undefined : err;

    if (layerError === 'router') {
      restore();
      return out();
    }

    if (idx >= stack.length) {
      restore();
      return out(layerError);
    }

    const layer = stack[idx++];

    // Restore url/baseUrl/app between sibling layers
    req.baseUrl = parentBaseUrl;
    req.url = parentUrl;
    req.app = parentApp;
    res.app = parentApp;

    // Error-handler matching check
    if (layerError !== undefined && !layer.isRouter && !layer.isErrorHandler) {
      return next(layerError);
    }
    if (layerError === undefined && layer.isErrorHandler) {
      return next();
    }

    const currentPath = req.path || '/';

    // Method check for route layers
    if (layer.method !== null) {
      const m = req.method;
      const methodOk =
        layer.method === 'ALL' ||
        layer.method === m ||
        (m === 'HEAD' && layer.method === 'GET');
      if (!methodOk) {
        if (m === 'OPTIONS' && layerError === undefined) {
          recordOptionsIfMatched(req, layer, currentPath);
        }
        return next(layerError);
      }
    }

    // Path match
    let match: PathMatchResult | null;
    try {
      match = layer.matcher.match(currentPath);
    } catch (decodeErr) {
      // Express: a param that fails to decode becomes the layer error (400).
      return next(layerError ?? decodeErr);
    }
    if (!match) {
      return next(layerError);
    }

    // Merge params according to router options using null-prototype map
    const mergedParams: Record<string, string> = router._options.mergeParams
      ? Object.assign(Object.create(null), parentParams, match.params)
      : Object.assign(Object.create(null), match.params);
    req.params = mergedParams;

    // Strip matched prefix for mounted middleware/sub-routers
    if (layer.method === null && match.matchedPath.length > 0 && match.matchedPath !== '/') {
      stripMountPrefix(req, match.matchedPath, parentBaseUrl, parentUrl);
    }

    const runLayer = (paramErr?: unknown) => {
      if (paramErr !== undefined && paramErr !== null) {
        return next(paramErr);
      }
      if (layer.isRouter) {
        if (layer.subApp) {
          req.app = layer.subApp;
          res.app = layer.subApp;
        }
        (layer.handle as Router).handle(req, res, next, 0, layerError);
      } else {
        if (layer.route && !layer.isRoute) {
          req.route = layer.route;
        }
        invokeHandler(layer.handle as AnyHandler, layerError, req, res, next);
      }
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
  called: Map<string, string>,
  req: RxRequest,
  res: RxResponse,
  done: NextFunction
): void {
  let keyIdx = 0;

  const nextKey = (err?: unknown) => {
    if (err !== undefined && err !== null) return done(err);

    while (keyIdx < keys.length) {
      const name = keys[keyIdx++];
      const val = values[name];
      const callbacks = params.get(name);
      if (!callbacks || callbacks.length === 0) continue;
      if (called.get(name) === val) continue;
      called.set(name, val);

      let cbIdx = 0;
      const nextCb: NextFunction = (cbErr?: unknown) => {
        if (cbErr !== undefined && cbErr !== null) return done(cbErr);
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
              if (!res.writableEnded) safeCbNext(normalizeThrownError(rej));
            });
          }
        } catch (thrown) {
          if (!res.writableEnded) safeCbNext(normalizeThrownError(thrown));
        }
      };
      nextCb();
      return;
    }
    done();
  };

  nextKey();
}
