import { resolve as resolvePath } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bridgeHandle } from './bridge.js';
import { isForeignExpressApp, mountForeignApp } from './foreign.js';
import { View, type ViewEngine } from './view.js';
import { type EventListenerFn, RxRequest } from './request.js';
import { RxResponse } from './response.js';
import { EXTRA_METHODS, Router, splitUseArgs, type Route } from './router.js';
import { parseTrustProxy, type TrustProxyFn } from './security.js';
import type {
  AddressInfo,
  ErrorRequestHandler,
  MiddlewareLike,
  NextFunction,
  ParamHandler,
  PathParams,
  RequestHandler,
  ServerHandle,
  TlsOptions,
} from './types.js';
import { startServer } from './server/lifecycle.js';

export { addUpgradeTarget } from './server/upgrade.js';

/**
 * An rxpress app is callable like an Express app: `app(req, res, next)`. That is what lets it be
 * handed to `http.createServer(app)` (served by the Rust engine, see `node-server.ts`), mounted in
 * a real Express app, or driven by tools that expect a request listener.
 */
export interface Application {
  (req: IncomingMessage | RxRequest, res: ServerResponse | RxResponse, next?: NextFunction): void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class Application {
  /** @internal */
  public readonly __isRxApp = true;
  /** @internal */
  public readonly _router: Router;
  public readonly locals: Record<string, unknown> = Object.create(null);
  public readonly settings: Record<string, unknown> = Object.create(null);
  public mountpath: string | string[] = '/';
  public parent: Application | undefined = undefined;
  /** Template engines by extension (`app.engine()`; sub-apps inherit it on mount). */
  public readonly engines: Record<string, ViewEngine> = Object.create(null);
  /** Compiled views when `view cache` is enabled. */
  public cache: Record<string, View> = Object.create(null);
  /** @internal */
  private _appListeners: Map<string, EventListenerFn[]> | null = null;
  /** @internal Most recent server started by `listen()` (backs `address()`/`close()`). */
  private _server: ServerHandle | null = null;

  // Cached hot-path settings (avoids rest-param app.get() overhead per request)
  /** @internal */
  public _xPoweredBy = true;
  /** @internal */
  public _trustProxy = false;
  /** @internal */
  public _trustProxyFn: TrustProxyFn | null = null;
  /** @internal */
  public _jsonReplacer: ((key: string, value: unknown) => unknown) | undefined = undefined;
  /** @internal */
  public _jsonSpaces: string | number | undefined = undefined;
  /** @internal */
  public _queryParserMode: 'extended' | 'simple' | false = 'simple';
  /** @internal */
  public _queryParserFn: ((qs: string) => Record<string, unknown>) | undefined = undefined;

  constructor() {
    this._router = new Router();
    this.defaultConfiguration();
  }

  /** The request prototype (`app.request` in Express). */
  get request(): RxRequest {
    return RxRequest.prototype;
  }

  /** The response prototype (`app.response` in Express). */
  get response(): RxResponse {
    return RxResponse.prototype;
  }

  /** @internal */
  private defaultConfiguration(): void {
    const env = process.env.NODE_ENV || 'development';
    this.set('x-powered-by', true);
    this.set('etag', 'weak');
    this.set('env', env);
    this.set('query parser', 'simple');
    this.set('subdomain offset', 2);
    this.set('trust proxy', false);
    this.set('case sensitive routing', false);
    this.set('strict routing', false);
    this.set('jsonp callback name', 'callback');
    this.set('view', View);
    this.set('views', resolvePath('views'));
    if (env === 'production') this.enable('view cache');
    this.locals.settings = this.settings;
  }

  /** Register a template engine for `ext` (`app.engine('html', require('ejs').renderFile)`). */
  public engine(ext: string, fn: ViewEngine): this {
    if (typeof fn !== 'function') {
      throw new Error('callback function required');
    }
    const extension = ext[0] !== '.' ? '.' + ext : ext;
    this.engines[extension] = fn;
    return this;
  }

  /**
   * Render `name` with `app.locals`, then `res.locals` (from `res.render`), then `options`, as
   * Express does.
   */
  public render(
    name: string,
    options?: Record<string, unknown> | ((err: Error | null, html?: string) => void),
    callback?: (err: Error | null, html?: string) => void
  ): void {
    let done = callback as (err: Error | null, html?: string) => void;
    let opts = (options ?? {}) as Record<string, unknown>;
    if (typeof options === 'function') {
      done = options;
      opts = {};
    }
    const renderOptions: Record<string, unknown> = {
      ...this.locals,
      ...(opts._locals as Record<string, unknown> | undefined),
      ...opts,
    };
    if (renderOptions.cache == null) renderOptions.cache = this.enabled('view cache');

    let view: View | undefined;
    if (renderOptions.cache) view = this.cache[name];
    if (!view) {
      const ViewCtor = this.get('view') as typeof View;
      view = new ViewCtor(name, {
        defaultEngine: this.get('view engine') as string | undefined,
        root: this.get('views') as string | string[],
        engines: this.engines,
      });
      if (!view.path) {
        const root = view.root;
        const dirs =
          Array.isArray(root) && root.length > 1
            ? 'directories "' + root.slice(0, -1).join('", "') + '" or "' + root[root.length - 1] + '"'
            : 'directory "' + String(root) + '"';
        const err = Object.assign(new Error('Failed to lookup view "' + name + '" in views ' + dirs), {
          view,
        });
        done(err);
        return;
      }
      if (renderOptions.cache) this.cache[name] = view;
    }
    try {
      view.render(renderOptions, done);
    } catch (err) {
      done(err as Error);
    }
  }

  public path(): string {
    if (!this.parent) return '';
    const mp = Array.isArray(this.mountpath) ? this.mountpath[0] || '' : this.mountpath;
    const clean = mp === '/' ? '' : mp;
    return this.parent.path() + clean;
  }

  public on(event: string, listener: EventListenerFn): this {
    if (this._appListeners === null) this._appListeners = new Map();
    let arr = this._appListeners.get(event);
    if (!arr) {
      arr = [];
      this._appListeners.set(event, arr);
    }
    arr.push(listener);
    return this;
  }

  public once(event: string, listener: EventListenerFn): this {
    const wrapper: EventListenerFn = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  public off(event: string, listener: EventListenerFn): this {
    if (this._appListeners === null) return this;
    const arr = this._appListeners.get(event);
    if (!arr) return this;
    const idx = arr.indexOf(listener);
    if (idx !== -1) arr.splice(idx, 1);
    return this;
  }

  public removeListener(event: string, listener: EventListenerFn): this {
    return this.off(event, listener);
  }

  public emit(event: string, ...args: unknown[]): boolean {
    if (this._appListeners === null) return false;
    const arr = this._appListeners.get(event);
    if (!arr || arr.length === 0) return false;
    const snap = arr.slice();
    for (let i = 0; i < snap.length; i++) {
      snap[i](...args);
    }
    return true;
  }

  /**
   * Express `app.handle(req, res, callback)`: run a request through this app. rxpress requests
   * are routed directly; Node `IncomingMessage`/`ServerResponse` pairs (a real Express parent,
   * a plain `http.Server`, serverless adapters...) go through the engine bridge.
   */
  public handle(
    req: IncomingMessage | RxRequest,
    res: ServerResponse | RxResponse,
    callback?: NextFunction
  ): void {
    if (req instanceof RxRequest) {
      const rxRes = res as RxResponse;
      const prevApp = req.app;
      const prevResApp = rxRes.app;
      req.app = this;
      rxRes.app = this;
      this._router.handle(req, rxRes, (err?: unknown) => {
        req.app = prevApp;
        rxRes.app = prevResApp;
        if (callback) {
          callback(err);
        } else if (!rxRes.headersSent) {
          // No parent to fall back to: answer like Express's finalhandler would.
          rxRes.status(err ? 500 : 404).send(err ? 'Internal Server Error' : `Cannot ${req.method} ${req.originalUrl}`);
        }
      }, 0, undefined);
      return;
    }
    bridgeHandle(this, req, res as ServerResponse, callback);
  }

  /**
   * `net.Server#address()` of the server most recently started with `listen()`, or `null`.
   * Lets tools that treat the app as a server (supertest's `listen(0)` flow) work unchanged.
   */
  public address(): AddressInfo | null {
    return this._server ? this._server.address() : null;
  }

  /** `net.Server#close()` for the server most recently started with `listen()`. */
  public close(cb?: (err?: Error) => void): this {
    const server = this._server;
    if (!server || !server.listening) {
      if (cb) {
        const err = new Error('Server is not running.') as NodeJS.ErrnoException;
        err.code = 'ERR_SERVER_NOT_RUNNING';
        process.nextTick(cb, err);
      }
      return this;
    }
    void server.close(cb);
    return this;
  }

  // ---- Express Settings API ----

  public set(setting: string, val: unknown): this {
    this.settings[setting] = val;
    if (setting === 'x-powered-by') {
      this._xPoweredBy = Boolean(val);
    } else if (setting === 'trust proxy') {
      this._trustProxyFn = parseTrustProxy(val);
      this._trustProxy = Boolean(this._trustProxyFn);
      this.settings['trust proxy fn'] = this._trustProxyFn;
    } else if (setting === 'json replacer') {
      this._jsonReplacer =
        typeof val === 'function' ? (val as (k: string, v: unknown) => unknown) : undefined;
    } else if (setting === 'json spaces') {
      this._jsonSpaces =
        typeof val === 'number' || typeof val === 'string' ? val : undefined;
    } else if (setting === 'case sensitive routing') {
      this._router._options.caseSensitive = Boolean(val);
    } else if (setting === 'strict routing') {
      this._router._options.strict = Boolean(val);
    } else if (setting === 'query parser') {
      if (typeof val === 'function') {
        this._queryParserFn = val as (qs: string) => Record<string, unknown>;
        this._queryParserMode = 'extended';
        this.settings['query parser fn'] = val;
      } else if (val === 'simple' || val === true) {
        this._queryParserFn = undefined;
        this._queryParserMode = 'simple';
      } else if (val === false) {
        this._queryParserFn = undefined;
        this._queryParserMode = false;
      } else {
        this._queryParserFn = undefined;
        this._queryParserMode = 'extended';
      }
    }
    return this;
  }

  public enable(setting: string): this {
    return this.set(setting, true);
  }

  public disable(setting: string): this {
    return this.set(setting, false);
  }

  public enabled(setting: string): boolean {
    return Boolean(this.settings[setting]);
  }

  public disabled(setting: string): boolean {
    return !this.settings[setting];
  }

  // ---- Express Routing & Middleware API ----

  public use(...handlers: RequestHandler[]): this;
  public use(handler: ErrorRequestHandler, ...handlers: MiddlewareLike[]): this;
  public use(handler: RequestHandler, ...handlers: MiddlewareLike[]): this;
  public use(path: PathParams, ...handlers: RequestHandler[]): this;
  public use(path: PathParams, handler: ErrorRequestHandler, ...handlers: MiddlewareLike[]): this;
  public use(path: PathParams, handler: RequestHandler, ...handlers: MiddlewareLike[]): this;
  public use(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public use(...handlers: MiddlewareLike[]): this;
  public use(...args: unknown[]): this {
    const { path: first, hasPath, handlers: flat } = splitUseArgs(args);
    if (flat.length === 0) throw new TypeError('app.use() requires a middleware function');
    // Apps from another Express copy are mounted here, as Express mounts its sub-apps.
    let routed: unknown[] = hasPath ? [first, ...flat] : flat;
    if (flat.some(isForeignExpressApp)) {
      const mounted = flat.map((h) =>
        isForeignExpressApp(h) ? mountForeignApp(h, hasPath ? first : '/', this) : h
      );
      routed = hasPath ? [first, ...mounted] : mounted;
    }
    (this._router.use as (...a: unknown[]) => Router)(...routed);

    for (let i = 0; i < flat.length; i++) {
      const h = flat[i];
      if (isRxApp(h)) {
        const subApp = h as unknown as Application;
        subApp.parent = this;
        subApp.emit('mount', this);
      }
    }
    return this;
  }

  public route(path: PathParams): Route {
    return this._router.route(path);
  }

  public param(name: string | string[], handler: ParamHandler): this {
    if (Array.isArray(name)) {
      for (const n of name) this.param(n, handler);
      return this;
    }
    this._router.param(name, handler);
    return this;
  }

  public get(setting: string): unknown;
  public get(path: PathParams, ...handlers: RequestHandler[]): this;
  public get(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public get(pathOrSetting: PathParams, ...handlers: MiddlewareLike[]): unknown {
    if (handlers.length === 0 && typeof pathOrSetting === 'string') {
      return this.settings[pathOrSetting];
    }
    this._router.get(pathOrSetting, ...handlers);
    return this;
  }

  public post(path: PathParams, ...handlers: RequestHandler[]): this;
  public post(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public post(path: PathParams, ...handlers: MiddlewareLike[]): this {
    this._router.post(path, ...handlers);
    return this;
  }

  public put(path: PathParams, ...handlers: RequestHandler[]): this;
  public put(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public put(path: PathParams, ...handlers: MiddlewareLike[]): this {
    this._router.put(path, ...handlers);
    return this;
  }

  public delete(path: PathParams, ...handlers: RequestHandler[]): this;
  public delete(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public delete(path: PathParams, ...handlers: MiddlewareLike[]): this {
    this._router.delete(path, ...handlers);
    return this;
  }

  public patch(path: PathParams, ...handlers: RequestHandler[]): this;
  public patch(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public patch(path: PathParams, ...handlers: MiddlewareLike[]): this {
    this._router.patch(path, ...handlers);
    return this;
  }

  public options(path: PathParams, ...handlers: RequestHandler[]): this;
  public options(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public options(path: PathParams, ...handlers: MiddlewareLike[]): this {
    this._router.options(path, ...handlers);
    return this;
  }

  public head(path: PathParams, ...handlers: RequestHandler[]): this;
  public head(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public head(path: PathParams, ...handlers: MiddlewareLike[]): this {
    this._router.head(path, ...handlers);
    return this;
  }

  public all(path: PathParams, ...handlers: RequestHandler[]): this;
  public all(path: PathParams, ...handlers: MiddlewareLike[]): this;
  public all(path: PathParams, ...handlers: MiddlewareLike[]): this {
    this._router.all(path, ...handlers);
    return this;
  }

  // ---- Server Lifecycle (HTTP & HTTPS/TLS) ----

  public listen(cb?: () => void): ServerHandle;
  public listen(port: number, cb?: () => void): ServerHandle;
  public listen(port: number, host: string, cb?: () => void): ServerHandle;
  public listen(port: number, host: string, backlog: number, cb?: () => void): ServerHandle;
  public listen(
    portOrCb?: number | (() => void),
    hostOrCb?: string | (() => void),
    backlogOrCb?: number | (() => void),
    maybeCb?: () => void
  ): ServerHandle {
    let port = 0;
    let host = '0.0.0.0';
    let cb: (() => void) | undefined;

    if (portOrCb === undefined || typeof portOrCb === 'function') {
      port = 0;
      cb = typeof portOrCb === 'function' ? portOrCb : undefined;
    } else {
      port = portOrCb;
      if (typeof hostOrCb === 'string') {
        host = hostOrCb;
        if (typeof backlogOrCb === 'function') {
          cb = backlogOrCb;
        } else {
          cb = maybeCb;
        }
      } else if (typeof hostOrCb === 'function') {
        cb = hostOrCb;
      }
    }

    return this._startServer(host, port, undefined, cb);
  }

  public listenTls(tlsOptions: TlsOptions, cb?: () => void): ServerHandle;
  public listenTls(
    tlsOptions: TlsOptions,
    port: number,
    hostOrCb?: string | (() => void),
    maybeCb?: () => void
  ): ServerHandle;
  public listenTls(
    tlsOptions: TlsOptions,
    portOrCb?: number | (() => void),
    hostOrCb?: string | (() => void),
    maybeCb?: () => void
  ): ServerHandle {
    let port = 0;
    let host = '0.0.0.0';
    let cb: (() => void) | undefined;

    if (portOrCb === undefined || typeof portOrCb === 'function') {
      port = 0;
      cb = typeof portOrCb === 'function' ? portOrCb : undefined;
    } else {
      port = portOrCb;
      host = typeof hostOrCb === 'string' ? hostOrCb : '0.0.0.0';
      cb = typeof hostOrCb === 'function' ? hostOrCb : maybeCb;
    }
    return this._startServer(host, port, tlsOptions, cb);
  }

  /** @internal Private loopback engine instance behind `bridgeHandle()` (never keeps the process alive). */
  public _startBridge(): ServerHandle {
    const handle = this._startServer('127.0.0.1', 0, undefined, undefined, true);
    handle.unref();
    return handle;
  }

  /** @internal */
  private _startServer(
    host: string,
    port: number,
    tlsOptions?: TlsOptions,
    callback?: () => void,
    bridgeMode = false
  ): ServerHandle {
    const handle = startServer(this, {
      host,
      port,
      tlsOptions,
      callback,
      bridgeMode,
      isCurrent: (h) => this._server === h,
    });
    if (!bridgeMode) this._server = handle;
    return handle;
  }
}

/** An rxpress app (callable function or plain instance), from either module copy (ESM/CJS). */
export function isRxApp(h: unknown): boolean {
  return (
    (typeof h === 'function' || (typeof h === 'object' && h !== null)) &&
    (h as { __isRxApp?: unknown }).__isRxApp === true
  );
}

// Callable apps keep Function.prototype (call/apply/bind) below the app API, like Express's.
Object.setPrototypeOf(Application.prototype, Function.prototype);

/**
 * `express()`: a function `app(req, res, next)` carrying the whole Application API.
 * The state lives as own properties of the function, exactly as on an Application instance.
 */
for (const method of EXTRA_METHODS) {
  Object.defineProperty(Application.prototype, method, {
    configurable: true,
    writable: true,
    value: function (this: Application, path: PathParams, ...handlers: MiddlewareLike[]) {
      (this._router as unknown as Record<string, (...a: unknown[]) => unknown>)[method](path, ...handlers);
      return this;
    },
  });
}

export function createApplication(): Application {
  const app = function app(
    req: IncomingMessage | RxRequest,
    res: ServerResponse | RxResponse,
    next?: NextFunction
  ): void {
    self.handle(req, res, next);
  } as unknown as Application;
  const self = app;
  Object.setPrototypeOf(app, Application.prototype);
  const init = new Application();
  for (const key of Reflect.ownKeys(init)) {
    Object.defineProperty(app, key, Reflect.getOwnPropertyDescriptor(init, key)!);
  }
  // `defaultConfiguration()` ran against `init`; nothing in it captures `this`.
  return app;
}

export interface HttpsServer {
  listen(cb?: () => void): ServerHandle;
  listen(port: number, cb?: () => void): ServerHandle;
  listen(port: number, host: string, cb?: () => void): ServerHandle;
  listen(port: number, host?: string, maybeCb?: () => void): ServerHandle;
}

export function createHttpsServer(tlsOptions: TlsOptions, app: Application): HttpsServer {
  return {
    listen(
      portOrCb?: number | (() => void),
      hostOrCb?: string | (() => void),
      maybeCb?: () => void
    ): ServerHandle {
      if (portOrCb === undefined || typeof portOrCb === 'function') {
        return app.listenTls(tlsOptions, portOrCb);
      }
      return app.listenTls(tlsOptions, portOrCb, hostOrCb, maybeCb);
    },
  };
}
