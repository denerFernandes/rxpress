import { METHODS as HTTP_METHODS } from 'node:http';
import type { Application } from './application.js';
import { isForeignExpressApp, mountForeignApp } from './foreign.js';
import { nativeMiddlewareMeta } from './middleware.js';
import type { RxRequest } from './request.js';
import type { RxResponse } from './response.js';
import type {
  ErrorRequestHandler,
  MiddlewareLike,
  NextFunction,
  ParamHandler,
  PathParams,
  RequestHandler,
  RouterOptions,
} from './types.js';
import { flattenHandlers, handleRouter, invokeHandler } from './router/dispatch.js';
import type { AnyHandler, Layer } from './router/layer.js';
import { compilePathMatcher } from './router/path-compile.js';

// Route/Router classes live here; the path compiler, Layer type and dispatch loop live in
// `./router/*` and are re-exported so importers of this module are unaffected.
/** @internal */
export type { AnyHandler, Layer } from './router/layer.js';
/** @internal */
export type { CompiledPathMatcher, PathMatchResult } from './router/path-compile.js';
/** @internal */
export { compilePathMatcher } from './router/path-compile.js';
/** @internal */
export { flattenHandlers, invokeHandler, normalizeThrownError, rejectionError } from './router/dispatch.js';

/** A middleware or route handler: a function, an rxpress Router or an rxpress app. */
function isHandlerLike(h: unknown): boolean {
  return (
    typeof h === 'function' ||
    (typeof h === 'object' &&
      h !== null &&
      ('__isRxRouter' in h || (h as { __isRxApp?: unknown }).__isRxApp === true))
  );
}

/**
 * rxpress parses `req.cookies` on its own, but the `cookie-parser` middleware skips everything
 * (including `req.secret` for signed cookies) when `req.cookies` is already set. While it runs,
 * the built-in value is hidden so it does its full work, as it would under Express.
 */
function withCookieParserShim<T>(h: T): T {
  if (typeof h !== 'function' || h.name !== 'cookieParser' || h.length !== 3) return h;
  const fn = h as unknown as (req: RxRequest, res: RxResponse, next: NextFunction) => unknown;
  const shim = function cookieParser(req: RxRequest, res: RxResponse, next: NextFunction) {
    const own = (req as { _hideCookies?: boolean })._hideCookies;
    if (own === false) (req as { _hideCookies: boolean })._hideCookies = true;
    try {
      return fn(req, res, next);
    } finally {
      if (own === false) (req as { _hideCookies: boolean })._hideCookies = false;
    }
  };
  return shim as unknown as T;
}

/** Deep flatten that keeps `null` / `undefined`, so they can be rejected like Express does. */
function flattenAll(input: unknown[], out: unknown[] = []): unknown[] {
  for (const item of input) {
    if (Array.isArray(item)) flattenAll(item, out);
    else out.push(item);
  }
  return out;
}

/** router@2's argument checks for `route.VERB()` / `router.use()`. */
function checkHandlers(list: unknown[]): void {
  if (list.length === 0) throw new TypeError('argument handler is required');
  for (const fn of list) {
    if (!isHandlerLike(fn)) throw new TypeError('argument handler must be a function');
  }
}

/** Splits `use()` arguments into the mount path(s) and the handlers, like router@2. */
export function splitUseArgs(args: unknown[]): { path: unknown; hasPath: boolean; handlers: unknown[] } {
  const first = args[0];
  if (!isHandlerLike(first)) {
    let arg = first;
    while (Array.isArray(arg) && arg.length !== 0) arg = arg[0];
    if (!isHandlerLike(arg)) {
      return { path: first, hasPath: true, handlers: flattenAll(args.slice(1)) };
    }
  }
  return { path: '/', hasPath: false, handlers: flattenAll(args) };
}

export class Route {
  public readonly path: PathParams;
  public readonly stack: Array<{ method: string; handle: RequestHandler | ErrorRequestHandler }> = [];
  public readonly methods: Record<string, boolean> = Object.create(null);

  constructor(path: PathParams) {
    this.path = path;
  }

  public all(...handlers: RequestHandler[]): this;
  public all(...handlers: MiddlewareLike[]): this;
  public all(...handlers: MiddlewareLike[]): this {
    return this._add('ALL', handlers);
  }

  public get(...handlers: RequestHandler[]): this;
  public get(...handlers: MiddlewareLike[]): this;
  public get(...handlers: MiddlewareLike[]): this {
    return this._add('GET', handlers);
  }

  public post(...handlers: RequestHandler[]): this;
  public post(...handlers: MiddlewareLike[]): this;
  public post(...handlers: MiddlewareLike[]): this {
    return this._add('POST', handlers);
  }

  public put(...handlers: RequestHandler[]): this;
  public put(...handlers: MiddlewareLike[]): this;
  public put(...handlers: MiddlewareLike[]): this {
    return this._add('PUT', handlers);
  }

  public delete(...handlers: RequestHandler[]): this;
  public delete(...handlers: MiddlewareLike[]): this;
  public delete(...handlers: MiddlewareLike[]): this {
    return this._add('DELETE', handlers);
  }

  public patch(...handlers: RequestHandler[]): this;
  public patch(...handlers: MiddlewareLike[]): this;
  public patch(...handlers: MiddlewareLike[]): this {
    return this._add('PATCH', handlers);
  }

  public options(...handlers: RequestHandler[]): this;
  public options(...handlers: MiddlewareLike[]): this;
  public options(...handlers: MiddlewareLike[]): this {
    return this._add('OPTIONS', handlers);
  }

  public head(...handlers: RequestHandler[]): this;
  public head(...handlers: MiddlewareLike[]): this;
  public head(...handlers: MiddlewareLike[]): this {
    return this._add('HEAD', handlers);
  }

  /** @internal */
  private _add(method: string, handlers: MiddlewareLike[]): this {
    const flat = flattenAll(handlers);
    checkHandlers(flat);
    this.methods[method.toLowerCase()] = true;
    for (const fn of flat) {
      if (typeof fn === 'function') {
        this.stack.push({ method, handle: fn as AnyHandler });
      }
    }
    return this;
  }

  public dispatch(req: RxRequest, res: RxResponse, done: NextFunction): void {
    const stack = this.stack;
    const reqMethod = typeof req.method === 'string' ? req.method.toUpperCase() : req.method;
    let idx = 0;

    req.route = this;
    let sync = 0;

    const next: NextFunction = (err?: unknown) => {
      if (err === 'route') return done();
      if (err === 'router') return done('router');
      // router@2: yield to the event loop every 100 synchronous next() calls.
      if (++sync > 100) {
        sync = 0;
        setImmediate(next, err);
        return;
      }

      const hasErr = err !== undefined && err !== null;

      while (idx < stack.length) {
        const layer = stack[idx++];
        const methodMatch =
          layer.method === 'ALL' ||
          layer.method === reqMethod ||
          (reqMethod === 'HEAD' && layer.method === 'GET');
        if (!methodMatch) continue;

        const isErrFn = layer.handle.length === 4;
        if (hasErr && !isErrFn) continue;
        if (!hasErr && isErrFn) continue;

        invokeHandler(layer.handle, hasErr ? err : undefined, req, res, next);
        sync = 0;
        return;
      }

      done(hasErr ? err : undefined);
    };

    next();
  }
}

export class Router {
  /** @internal */
  public readonly stack: Layer[] = [];
  public readonly params: Map<string, ParamHandler[]> = new Map();
  /** @internal */
  public readonly _options: RouterOptions;
  /** @internal */
  public readonly __isRxRouter = true;

  constructor(options: RouterOptions = {}) {
    this._options = options;
  }

  public param(name: string | string[], handler: ParamHandler): this {
    if (!name) throw new TypeError('argument name is required');
    if (typeof name !== 'string' && !Array.isArray(name)) {
      throw new TypeError('argument name must be a string');
    }
    if (!handler) throw new TypeError('argument fn is required');
    if (typeof handler !== 'function') throw new TypeError('argument fn must be a function');
    const names = Array.isArray(name) ? name : [name];
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      let list = this.params.get(n);
      if (!list) {
        list = [];
        this.params.set(n, list);
      }
      list.push(handler);
    }
    return this;
  }

  public route(path: PathParams): Route {
    const route = new Route(path);
    const paths = Array.isArray(path) ? path : [path];
    for (const p of paths) {
      const matcher = compilePathMatcher(p, {
        end: true,
        sensitive: this._options.caseSensitive,
        strict: this._options.strict,
      });
      this.stack.push({
        path: p,
        matcher,
        method: 'ALL',
        handle: (req: RxRequest, res: RxResponse, next: NextFunction) =>
          route.dispatch(req, res, next),
        isErrorHandler: false,
        isRouter: false,
        isRoute: true,
        route,
      });
    }
    return route;
  }

  public use(...handlers: RequestHandler[]): this;
  public use(handler: ErrorRequestHandler, ...handlers: MiddlewareLike[]): this;
  public use(handler: RequestHandler, ...handlers: MiddlewareLike[]): this;
  public use(path: PathParams, ...handlers: RequestHandler[]): this;
  public use(path: PathParams, handler: ErrorRequestHandler, ...handlers: MiddlewareLike[]): this;
  public use(path: PathParams, handler: RequestHandler, ...handlers: MiddlewareLike[]): this;
  public use(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public use(...handlers: MiddlewareLike[]): this;
  public use(...args: unknown[]): this {
    const split = splitUseArgs(args);
    checkHandlers(split.handlers);
    const paths = (
      split.hasPath ? (Array.isArray(split.path) ? split.path : [split.path]) : ['/']
    ) as Array<string | RegExp>;

    // An app from another Express copy: mounted under `req.app` when first reached.
    const mountPath = paths.length === 1 ? paths[0] : paths;
    const handlers = (split.handlers as Array<AnyHandler | Router>).map((h) =>
      isForeignExpressApp(h)
        ? (mountForeignApp(h, mountPath, null) as unknown as AnyHandler)
        : withCookieParserShim(h)
    );
    for (const p of paths) {
      const matcher = compilePathMatcher(p, {
        end: false,
        sensitive: this._options.caseSensitive,
        strict: false,
      });
      for (const h of handlers) {
        const isRouter =
          (typeof h === 'object' || typeof h === 'function') && h !== null && '__isRxRouter' in h;
        const isSubApp =
          (typeof h === 'function' || (typeof h === 'object' && h !== null)) &&
          (h as { __isRxApp?: unknown }).__isRxApp === true;
        const subApp = isSubApp ? (h as unknown as Application) : undefined;
        if (subApp) {
          subApp.mountpath =
            paths.length === 1
              ? typeof paths[0] === 'string'
                ? paths[0]
                : paths[0].source
              : paths.map((mp) => (typeof mp === 'string' ? mp : mp.source));
        }
        const target = isSubApp
          ? (h as unknown as { _router: Router })._router
          : h;
        const isRouterLike = isRouter || isSubApp;
        const nativeMeta =
          typeof h === 'function' ? nativeMiddlewareMeta.get(h) : undefined;

        this.stack.push({
          path: p,
          matcher,
          method: null,
          handle: target,
          isErrorHandler: !isRouterLike && typeof target === 'function' && target.length === 4,
          isRouter: isRouterLike,
          isRoute: false,
          subApp,
          nativeMeta,
        });
      }
    }
    return this;
  }

  /** @internal */
  private _addMethod(method: string, path: PathParams, handlers: MiddlewareLike[]): this {
    const flat = flattenAll(handlers) as Array<AnyHandler | Router>;
    checkHandlers(flat);
    const paths = Array.isArray(path) ? path : [path];
    for (const p of paths) {
      const matcher = compilePathMatcher(p, {
        end: true,
        sensitive: this._options.caseSensitive,
        strict: this._options.strict,
      });
      if (flat.length === 1 && typeof flat[0] === 'function') {
        const route = new Route(p);
        route.stack.push({ method, handle: flat[0] as AnyHandler });
        route.methods[method.toLowerCase()] = true;
        this.stack.push({
          path: p,
          matcher,
          method,
          handle: flat[0] as AnyHandler,
          isErrorHandler: flat[0].length === 4,
          isRouter: false,
          isRoute: false,
          route,
        });
      } else {
        const route = new Route(p);
        route.methods[method.toLowerCase()] = true;
        for (const h of flat) {
          if (typeof h === 'function') {
            route.stack.push({ method, handle: h as AnyHandler });
          }
        }
        this.stack.push({
          path: p,
          matcher,
          method,
          handle: (req: RxRequest, res: RxResponse, next: NextFunction) =>
            route.dispatch(req, res, next),
          isErrorHandler: false,
          isRouter: false,
          isRoute: true,
          route,
        });
      }
    }
    return this;
  }

  public get(path: PathParams, ...handlers: RequestHandler[]): this;
  public get(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public get(path: PathParams, ...handlers: MiddlewareLike[]): this {
    return this._addMethod('GET', path, handlers);
  }

  public post(path: PathParams, ...handlers: RequestHandler[]): this;
  public post(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public post(path: PathParams, ...handlers: MiddlewareLike[]): this {
    return this._addMethod('POST', path, handlers);
  }

  public put(path: PathParams, ...handlers: RequestHandler[]): this;
  public put(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public put(path: PathParams, ...handlers: MiddlewareLike[]): this {
    return this._addMethod('PUT', path, handlers);
  }

  public delete(path: PathParams, ...handlers: RequestHandler[]): this;
  public delete(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public delete(path: PathParams, ...handlers: MiddlewareLike[]): this {
    return this._addMethod('DELETE', path, handlers);
  }

  public patch(path: PathParams, ...handlers: RequestHandler[]): this;
  public patch(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public patch(path: PathParams, ...handlers: MiddlewareLike[]): this {
    return this._addMethod('PATCH', path, handlers);
  }

  public options(path: PathParams, ...handlers: RequestHandler[]): this;
  public options(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public options(path: PathParams, ...handlers: MiddlewareLike[]): this {
    return this._addMethod('OPTIONS', path, handlers);
  }

  public head(path: PathParams, ...handlers: RequestHandler[]): this;
  public head(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public head(path: PathParams, ...handlers: MiddlewareLike[]): this {
    return this._addMethod('HEAD', path, handlers);
  }

  public all(path: PathParams, ...handlers: RequestHandler[]): this;
  public all(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public all(path: PathParams, ...handlers: MiddlewareLike[]): this {
    return this._addMethod('ALL', path, handlers);
  }

  /**
   * Execute this router's middleware & route stack on `(req, res)` starting at `startIndex`.
   */
  public handle(
    req: RxRequest,
    res: RxResponse,
    out: NextFunction,
    startIndex = 0,
    initialError?: unknown
  ): void {
    handleRouter(this, req, res, out, startIndex, initialError);
  }
}

// Every other method Node knows (`app.acl()`, `router.propfind()`, `route['m-search']()`...),
// as Express and router@2 define them from `http.METHODS`.
/** @internal */
export const EXTRA_METHODS = HTTP_METHODS.map((m) => m.toLowerCase()).filter(
  (m) => !(m in Route.prototype)
);
for (const method of EXTRA_METHODS) {
  const upper = method.toUpperCase();
  Object.defineProperty(Route.prototype, method, {
    configurable: true,
    writable: true,
    value: function (this: Route, ...handlers: MiddlewareLike[]) {
      return (this as unknown as { _add(m: string, h: MiddlewareLike[]): Route })._add(upper, handlers);
    },
  });
  Object.defineProperty(Router.prototype, method, {
    configurable: true,
    writable: true,
    value: function (this: Router, path: PathParams, ...handlers: MiddlewareLike[]) {
      return (
        this as unknown as { _addMethod(m: string, p: PathParams, h: MiddlewareLike[]): Router }
      )._addMethod(upper, path, handlers);
    },
  });
}

/**
 * `express.Router()`: like router@2, the router is itself a middleware function
 * (`router(req, res, next)`) that also carries every Router method.
 */
export function createRouter(options?: RouterOptions): Router {
  const inner = new Router(options);
  const router = function router(req: RxRequest, res: RxResponse, next: NextFunction): void {
    (router as unknown as Router).handle(req, res, next);
  };
  Object.setPrototypeOf(router, Router.prototype);
  const fields = Object.keys(inner) as Array<keyof Router>;
  for (let i = 0; i < fields.length; i++) {
    (router as unknown as Record<string, unknown>)[fields[i]] = inner[fields[i]];
  }
  return router as unknown as Router;
}
