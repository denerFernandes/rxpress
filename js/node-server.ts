// `http.createServer(app)` / `https.createServer(opts, app)` served by the Rust engine.
//
// Frameworks that own the server (NestJS's ExpressAdapter, Vendure, supertest given a function,
// Apollo setups...) create it themselves with `http.createServer(app)` and then `listen()`.
// When the listener is an rxpress app, the interception below returns an `RxServer`: a
// `net.Server`-shaped object whose `listen()` starts the native engine for that app, so that code
// gets full rxpress performance unchanged. Any other listener gets Node's own server.
//
// Opt-outs (the app then runs on Node's server through the engine bridge, see bridge.ts):
//   - per app: `app.set('native server', false)` before `createServer`;
//   - globally: `RXPRESS_NODE_HTTP=1`.
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { addUpgradeTarget, type Application } from './application.js';
import type { AddressInfo, ServerHandle, TlsOptions } from './types.js';

type AnyFn = (...args: unknown[]) => unknown;

/** Node `http.Server` defaults; a value changed on the server is forwarded to the engine. */
const NODE_DEFAULTS = {
  keepAliveTimeout: 5000,
  headersTimeout: 60000,
  requestTimeout: 300000,
};

function isRxApp(h: unknown): h is Application {
  return typeof h === 'function' && (h as { __isRxApp?: unknown }).__isRxApp === true;
}

function wantsNative(app: Application): boolean {
  return process.env.RXPRESS_NODE_HTTP !== '1' && app.get('native server') !== false;
}

function notRunning(): NodeJS.ErrnoException {
  const err = new Error('Server is not running.') as NodeJS.ErrnoException;
  err.code = 'ERR_SERVER_NOT_RUNNING';
  return err;
}

interface ListenArgs {
  port: number;
  host: string | undefined;
  cb: (() => void) | undefined;
}

function parseListenArgs(args: unknown[]): ListenArgs {
  let cb: (() => void) | undefined;
  if (args.length > 0 && typeof args[args.length - 1] === 'function') {
    cb = args.pop() as () => void;
  }
  let portArg: unknown = args[0];
  let host: string | undefined;
  if (portArg !== null && typeof portArg === 'object') {
    const o = portArg as { port?: unknown; host?: unknown; path?: unknown };
    if (o.path !== undefined) {
      throw new Error('rxpress: listening on a pipe/UNIX socket is not supported by the native server');
    }
    portArg = o.port;
    host = typeof o.host === 'string' ? o.host : undefined;
  } else if (typeof args[1] === 'string') {
    host = args[1];
  }
  let port = 0;
  if (typeof portArg === 'number') {
    port = portArg;
  } else if (typeof portArg === 'string' && portArg !== '') {
    if (!/^\d+$/.test(portArg)) {
      throw new Error('rxpress: listening on a pipe/UNIX socket is not supported by the native server');
    }
    port = Number(portArg);
  }
  if (host === 'localhost') host = '127.0.0.1';
  return { port, host, cb };
}

/**
 * The `net.Server` surface frameworks use, backed by the native engine. Created by the
 * intercepted `http.createServer(app)`; `listen()` may be called again after `close()`.
 */
export class RxServer extends EventEmitter {
  public listening = false;
  public timeout = 0;
  public keepAliveTimeout = NODE_DEFAULTS.keepAliveTimeout;
  public headersTimeout = NODE_DEFAULTS.headersTimeout;
  public requestTimeout = NODE_DEFAULTS.requestTimeout;
  public maxHeadersCount: number | null = null;
  public maxConnections: number | undefined = undefined;
  public maxRequestsPerSocket = 0;
  /** The rxpress app this server runs. */
  public readonly app: Application;
  /** @internal */
  private readonly _tls: TlsOptions | undefined;
  /** @internal */
  private _handle: ServerHandle | null = null;
  /** @internal */
  private _unref = false;

  constructor(app: Application, tls?: TlsOptions, options?: Record<string, unknown>) {
    super();
    this.app = app;
    this._tls = tls;
    if (options) {
      if (typeof options.keepAliveTimeout === 'number') this.keepAliveTimeout = options.keepAliveTimeout;
      if (typeof options.headersTimeout === 'number') this.headersTimeout = options.headersTimeout;
      if (typeof options.requestTimeout === 'number') this.requestTimeout = options.requestTimeout;
      if (typeof options.maxHeaderSize === 'number') app.set('maxHeaderSizeBytes', options.maxHeaderSize);
    }
    // Node registers the listener for 'request'; keep that observable.
    super.on('request', app as unknown as AnyFn);
  }

  /** @internal Forward `net.Server` tunables the user changed into engine settings. */
  private _applySettings(): void {
    const app = this.app;
    if (this.keepAliveTimeout !== NODE_DEFAULTS.keepAliveTimeout) {
      app.set('keepAliveTimeoutMs', this.keepAliveTimeout);
    }
    if (this.headersTimeout !== NODE_DEFAULTS.headersTimeout) {
      app.set('headersTimeoutMs', this.headersTimeout);
    }
    if (this.requestTimeout !== NODE_DEFAULTS.requestTimeout) {
      app.set('requestTimeoutMs', this.requestTimeout);
    }
    if (typeof this.maxHeadersCount === 'number' && this.maxHeadersCount > 0) {
      app.set('maxHeadersCount', this.maxHeadersCount);
    }
    if (typeof this.maxConnections === 'number' && this.maxConnections > 0) {
      app.set('maxConnections', this.maxConnections);
    }
  }

  public listen(...args: unknown[]): this {
    let parsed: ListenArgs;
    try {
      parsed = parseListenArgs(args);
    } catch (err) {
      process.nextTick(() => this.emit('error', err));
      return this;
    }
    if (this._handle !== null && this.listening) {
      const err = new Error('Listen method has been called more than once without closing.') as NodeJS.ErrnoException;
      err.code = 'ERR_SERVER_ALREADY_LISTEN';
      throw err;
    }
    if (parsed.cb) this.once('listening', parsed.cb);
    let handle: ServerHandle;
    try {
      this._applySettings();
      const host = parsed.host ?? '0.0.0.0';
      handle = this._tls
        ? this.app.listenTls(this._tls, parsed.port, host)
        : this.app.listen(parsed.port, host);
    } catch (err) {
      // net.Server reports bind failures (EADDRINUSE...) as an async 'error' event.
      process.nextTick(() => this.emit('error', err));
      return this;
    }
    this._handle = handle;
    // 'upgrade' listeners on this server (ws, socket.io...) receive the engine's upgrades.
    addUpgradeTarget(handle, this);
    if (this._unref) handle.unref();
    if (this.timeout) handle.setTimeout(this.timeout);
    handle.once('listening', () => {
      if (this._handle !== handle) return;
      this.listening = true;
      this.emit('listening');
    });
    handle.once('close', () => {
      if (this._handle !== handle) return;
      this.listening = false;
      this._handle = null;
      this.emit('close');
    });
    return this;
  }

  public address(): AddressInfo | null {
    return this._handle ? this._handle.address() : null;
  }

  public close(cb?: (err?: Error) => void): this {
    const handle = this._handle;
    if (handle === null || !this.listening) {
      if (cb) process.nextTick(cb, notRunning());
      return this;
    }
    this.listening = false;
    if (cb) this.once('close', () => cb());
    void handle.close();
    return this;
  }

  public closeAllConnections(): void {
    this._handle?.closeAllConnections();
  }

  public closeIdleConnections(): void {
    this._handle?.closeIdleConnections();
  }

  public getConnections(cb: (err: Error | null, count: number) => void): this {
    process.nextTick(cb, null, 0);
    return this;
  }

  public setTimeout(msecs?: number, cb?: () => void): this {
    if (typeof msecs === 'number') this.timeout = msecs;
    if (cb) this.on('timeout', cb);
    this._handle?.setTimeout(msecs);
    return this;
  }

  public ref(): this {
    this._unref = false;
    this._handle?.ref();
    return this;
  }

  public unref(): this {
    this._unref = true;
    this._handle?.unref();
    return this;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    if (this._handle !== null && this.listening) {
      await new Promise<void>((resolve) => this.close(() => resolve()));
    }
  }
}

/** Map Node TLS options onto the engine's when it can serve them natively. */
function nativeTls(opts: Record<string, unknown> | undefined): TlsOptions | null {
  if (!opts) return null;
  const { key, cert } = opts;
  const ok = (v: unknown): v is string | Buffer => typeof v === 'string' || Buffer.isBuffer(v);
  if (!ok(key) || !ok(cert)) return null;
  // Options the engine has no equivalent for keep Node's TLS server (bridge path).
  for (const k of [
    'pfx',
    'passphrase',
    'ca',
    'requestCert',
    'SNICallback',
    'ALPNProtocols',
    'ciphers',
    'secureOptions',
    'ecdhCurve',
    'honorCipherOrder',
    'dhparam',
    'secureProtocol',
  ]) {
    if (opts[k] !== undefined) return null;
  }
  // The engine is fixed at TLS 1.2..1.3; anything else needs Node's TLS stack.
  if (opts.minVersion !== undefined && opts.minVersion !== 'TLSv1.2') return null;
  if (opts.maxVersion !== undefined && opts.maxVersion !== 'TLSv1.3') return null;
  return { key, cert };
}

interface PatchState {
  http: AnyFn;
  https: AnyFn;
}

const PATCH = Symbol.for('rxpress.nodeServerPatch');

/** Idempotent across the ESM and CJS copies of rxpress. */
export function installNodeServerInterception(): void {
  const g = globalThis as unknown as Record<symbol, PatchState | undefined>;
  if (g[PATCH]) return;
  const origHttp = http.createServer as unknown as AnyFn;
  const origHttps = https.createServer as unknown as AnyFn;
  g[PATCH] = { http: origHttp, https: origHttps };

  const patchedHttp = function createServer(this: unknown, ...args: unknown[]): unknown {
    const [a, b] = args;
    const listener = typeof a === 'function' ? a : b;
    if (isRxApp(listener) && wantsNative(listener)) {
      const opts = a !== null && typeof a === 'object' ? (a as Record<string, unknown>) : undefined;
      return new RxServer(listener, undefined, opts);
    }
    return origHttp.apply(this, args);
  };
  const patchedHttps = function createServer(this: unknown, ...args: unknown[]): unknown {
    const [a, b] = args;
    const listener = typeof a === 'function' ? a : b;
    if (isRxApp(listener) && wantsNative(listener)) {
      const opts = a !== null && typeof a === 'object' ? (a as Record<string, unknown>) : undefined;
      const tls = nativeTls(opts);
      if (tls) return new RxServer(listener, tls, opts);
    }
    return origHttps.apply(this, args);
  };
  (http as unknown as Record<string, unknown>).createServer = patchedHttp;
  (https as unknown as Record<string, unknown>).createServer = patchedHttps;
  // Update `import { createServer } from 'node:http'` bindings as well.
  syncBuiltinESMExports();
}
