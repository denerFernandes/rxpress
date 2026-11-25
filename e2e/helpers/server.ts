import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import rxpress, {
  createHttpsServer as rxCreateHttpsServer,
  json as rxJson,
  raw as rxRaw,
  serveStatic as rxServeStatic,
  text as rxText,
  urlencoded as rxUrlencoded,
} from 'rxpress';
import { it } from 'vitest';

export type E2ETarget = 'rxpress' | 'express';

export function getE2ETarget(): E2ETarget {
  return process.env.E2E_TARGET === 'express' ? 'express' : 'rxpress';
}

export function isExpressBaseline(): boolean {
  return getE2ETarget() === 'express';
}

export const itRxpress: typeof it = isExpressBaseline() ? (it.skip as typeof it) : it;

export interface E2EAddressInfo {
  address: string;
  port: number;
  family: string;
}

export interface E2ETlsOptions {
  key: string | Buffer;
  cert: string | Buffer;
}

export interface E2EServerConfigOptions {
  xPoweredBy?: boolean;
  etagMode?: 'weak' | 'strong' | 'off';
  caseSensitive?: boolean;
  strictRouting?: boolean;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  tlsHandshakeTimeoutMs?: number;
  handlerTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxConnections?: number;
  maxHeadersCount?: number;
  maxHeaderSizeBytes?: number;
  defaultBodyLimitBytes?: number;
  streamQueueCapacity?: number;
}

export interface E2ECookieOptions {
  maxAge?: number;
  signed?: boolean;
  expires?: Date;
  httpOnly?: boolean;
  path?: string;
  domain?: string;
  secure?: boolean;
  encode?: (val: string) => string;
  sameSite?: boolean | 'lax' | 'strict' | 'none';
  priority?: 'low' | 'medium' | 'high';
  partitioned?: boolean;
}

export interface E2ESendFileOptions {
  maxAge?: number | string;
  root?: string;
  lastModified?: boolean;
  headers?: Record<string, string | string[]>;
  dotfiles?: 'allow' | 'deny' | 'ignore';
  acceptRanges?: boolean;
  cacheControl?: boolean;
  immutable?: boolean;
}

export interface E2ERouterOptions {
  caseSensitive?: boolean;
  mergeParams?: boolean;
  strict?: boolean;
}

export interface E2EJsonOptions {
  limit?: number | string;
  strict?: boolean;
  type?: string | string[] | ((req: E2ERequest) => boolean);
  reviver?: (key: string, value: unknown) => unknown;
  verify?: (req: E2ERequest, res: E2EResponse, buf: Buffer, encoding: string) => void;
}

export interface E2EUrlencodedOptions {
  extended?: boolean;
  limit?: number | string;
  parameterLimit?: number;
  type?: string | string[] | ((req: E2ERequest) => boolean);
  verify?: (req: E2ERequest, res: E2EResponse, buf: Buffer, encoding: string) => void;
}

export interface E2ETextOptions {
  defaultCharset?: string;
  limit?: number | string;
  type?: string | string[] | ((req: E2ERequest) => boolean);
  verify?: (req: E2ERequest, res: E2EResponse, buf: Buffer, encoding: string) => void;
}

export interface E2ERawOptions {
  limit?: number | string;
  type?: string | string[] | ((req: E2ERequest) => boolean);
  verify?: (req: E2ERequest, res: E2EResponse, buf: Buffer, encoding: string) => void;
}

export interface E2EStaticOptions {
  dotfiles?: 'allow' | 'deny' | 'ignore';
  etag?: boolean;
  extensions?: string[] | false;
  fallthrough?: boolean;
  immutable?: boolean;
  index?: boolean | string | string[];
  lastModified?: boolean;
  maxAge?: number | string;
  redirect?: boolean;
  setHeaders?: (res: E2EResponse, path: string) => void;
}

export interface E2ERequest {
  readonly app: E2EApplication;
  res: E2EResponse;
  method: string;
  baseUrl: string;
  originalUrl: string;
  url: string;
  readonly path: string;
  params: Record<string, string>;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawHeaders: string[];
  query: Record<string, unknown>;
  body: unknown;
  cookies: Record<string, string>;
  signedCookies?: Record<string, unknown>;
  route: unknown;
  httpVersion: string;
  httpVersionMajor: number;
  httpVersionMinor: number;
  readable: boolean;
  complete: boolean;
  readonly protocol: string;
  readonly secure: boolean;
  readonly ip: string | undefined;
  readonly ips: string[];
  readonly host: string | undefined;
  readonly hostname: string | undefined;
  readonly subdomains: string[];
  readonly xhr: boolean;
  readonly fresh: boolean;
  readonly stale: boolean;
  readonly socket: {
    remoteAddress?: string;
    encrypted?: boolean;
  };
  readonly connection: {
    remoteAddress?: string;
    encrypted?: boolean;
  };
  get(name: string): string | undefined;
  header(name: string): string | undefined;
  is(...types: Array<string | string[]>): string | false | null;
  accepts(...types: Array<string | string[]>): string | string[] | false;
  acceptsEncodings(...encodings: string[]): string | string[] | false;
  acceptsCharsets(...charsets: string[]): string | string[] | false;
  acceptsLanguages(...langs: string[]): string | string[] | false;
  range?: (
    size: number,
    options?: { combine?: boolean }
  ) => Array<{ start: number; end: number }> & { type: string } | number | undefined;
  on(event: string, listener: (...args: unknown[]) => void): this;
  addListener(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
  emit(event: string, ...args: unknown[]): boolean;
  [key: string]: unknown;
}

export interface E2EResponse {
  readonly app: E2EApplication;
  req: E2ERequest;
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  writableEnded: boolean;
  writableFinished?: boolean;
  finished: boolean;
  locals: Record<string, unknown>;
  status(code: number): this;
  set(
    field: string | Record<string, string | number | string[]>,
    val?: string | number | string[]
  ): this;
  header(
    field: string | Record<string, string | number | string[]>,
    val?: string | number | string[]
  ): this;
  get(field: string): string | undefined;
  append(field: string, val: string | string[]): this;
  type(type: string): this;
  contentType(type: string): this;
  vary(field: string): this;
  links(links: Record<string, string>): this;
  location(url: string): this;
  redirect(statusOrUrl: number | string, maybeUrl?: string): void;
  cookie(name: string, value: unknown, options?: E2ECookieOptions): this;
  clearCookie(name: string, options?: E2ECookieOptions): this;
  attachment(filename?: string): this;
  format(obj: Record<string, () => unknown>): this;
  json(body?: unknown): this;
  jsonp(body?: unknown): this;
  send(body?: unknown): this;
  sendStatus(code: number): this;
  sendFile(
    filePath: string,
    optionsOrCb?: E2ESendFileOptions | ((err?: Error) => void),
    maybeCb?: (err?: Error) => void
  ): void;
  download(
    filePath: string,
    filenameOrOpts?: string | E2ESendFileOptions | ((err?: Error) => void),
    optsOrCb?: E2ESendFileOptions | ((err?: Error) => void),
    maybeCb?: (err?: Error) => void
  ): void;
  setHeader(name: string, value: string | number | readonly string[]): this;
  getHeader(name: string): number | string | string[] | undefined;
  getHeaders(): Record<string, number | string | string[] | undefined>;
  getHeaderNames(): string[];
  hasHeader(name: string): boolean;
  removeHeader(name: string): void;
  writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | Record<string, string | number | string[]>,
    maybeHeaders?: Record<string, string | number | string[]>
  ): this;
  flushHeaders(): void;
  write(
    chunk: string | Buffer | Uint8Array,
    encodingOrCb?: BufferEncoding | (() => void),
    maybeCb?: () => void
  ): boolean;
  end(
    dataOrCb?: string | Buffer | Uint8Array | (() => void),
    encodingOrCb?: BufferEncoding | (() => void),
    maybeCb?: () => void
  ): this;
  cork?: () => void;
  uncork?: () => void;
  on(event: string, listener: (...args: unknown[]) => void): this;
  addListener(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
  removeAllListeners?: (event?: string) => this;
  listeners?: (event: string) => Array<(...args: unknown[]) => void>;
  listenerCount?: (event: string) => number;
  emit(event: string, ...args: unknown[]): boolean;
  [key: string]: unknown;
}

export type E2ENextFunction = (err?: unknown) => void;

export type E2ERequestHandler = (
  req: E2ERequest,
  res: E2EResponse,
  next: E2ENextFunction
) => unknown | Promise<unknown>;

export type E2EErrorRequestHandler = (
  err: unknown,
  req: E2ERequest,
  res: E2EResponse,
  next: E2ENextFunction
) => unknown | Promise<unknown>;

export type E2EMiddlewareLike =
  | E2ERequestHandler
  | E2EErrorRequestHandler
  | E2ERouter
  | E2EApplication
  | E2EMiddlewareLike[];

export type E2EParamHandler = (
  req: E2ERequest,
  res: E2EResponse,
  next: E2ENextFunction,
  value: string,
  name: string
) => unknown | Promise<unknown>;

export type E2EPathParams = string | RegExp | Array<string | RegExp>;

export interface E2ERoute {
  all(...handlers: E2ERequestHandler[]): this;
  all(...handlers: E2EMiddlewareLike[]): this;
  get(...handlers: E2ERequestHandler[]): this;
  get(...handlers: E2EMiddlewareLike[]): this;
  post(...handlers: E2ERequestHandler[]): this;
  post(...handlers: E2EMiddlewareLike[]): this;
  put(...handlers: E2ERequestHandler[]): this;
  put(...handlers: E2EMiddlewareLike[]): this;
  delete(...handlers: E2ERequestHandler[]): this;
  delete(...handlers: E2EMiddlewareLike[]): this;
  patch(...handlers: E2ERequestHandler[]): this;
  patch(...handlers: E2EMiddlewareLike[]): this;
  options(...handlers: E2ERequestHandler[]): this;
  options(...handlers: E2EMiddlewareLike[]): this;
  head(...handlers: E2ERequestHandler[]): this;
  head(...handlers: E2EMiddlewareLike[]): this;
}

export interface E2ERouter {
  param(name: string | string[], handler: E2EParamHandler): this;
  route(path: E2EPathParams): E2ERoute;
  use(handler: E2ERequestHandler): this;
  use(handler: E2EErrorRequestHandler): this;
  use(subRouter: E2ERouter | E2EApplication): this;
  use(path: E2EPathParams, ...handlers: E2ERequestHandler[]): this;
  use(path: E2EPathParams, handler: E2EErrorRequestHandler): this;
  use(path: E2EPathParams, ...handlers: E2EMiddlewareLike[]): this;
  use(...handlers: E2EMiddlewareLike[]): this;
  get(path: E2EPathParams, ...handlers: E2ERequestHandler[]): this;
  get(path: E2EPathParams, ...handlers: E2EMiddlewareLike[]): this;
  post(path: E2EPathParams, ...handlers: E2ERequestHandler[]): this;
  post(path: E2EPathParams, ...handlers: E2EMiddlewareLike[]): this;
  put(path: E2EPathParams, ...handlers: E2ERequestHandler[]): this;
  put(path: E2EPathParams, ...handlers: E2EMiddlewareLike[]): this;
  delete(path: E2EPathParams, ...handlers: E2ERequestHandler[]): this;
  delete(path: E2EPathParams, ...handlers: E2EMiddlewareLike[]): this;
  patch(path: E2EPathParams, ...handlers: E2ERequestHandler[]): this;
  patch(path: E2EPathParams, ...handlers: E2EMiddlewareLike[]): this;
  options(path: E2EPathParams, ...handlers: E2ERequestHandler[]): this;
  options(path: E2EPathParams, ...handlers: E2EMiddlewareLike[]): this;
  head(path: E2EPathParams, ...handlers: E2ERequestHandler[]): this;
  head(path: E2EPathParams, ...handlers: E2EMiddlewareLike[]): this;
  all(path: E2EPathParams, ...handlers: E2ERequestHandler[]): this;
  all(path: E2EPathParams, ...handlers: E2EMiddlewareLike[]): this;
}

export interface E2EServerHandle {
  address(): E2EAddressInfo | null;
  close(callback?: (err?: Error) => void): Promise<void> | unknown;
  listening: boolean;
  closeAllConnections?: () => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface E2EApplication extends E2ERouter {
  readonly locals: Record<string, unknown>;
  readonly settings: Record<string, unknown>;
  mountpath?: string | string[];
  path?: () => string;
  set(setting: string, val: unknown): this;
  enable(setting: string): this;
  disable(setting: string): this;
  enabled(setting: string): boolean;
  disabled(setting: string): boolean;
  get(setting: string): unknown;
  get(path: E2EPathParams, ...handlers: E2ERequestHandler[]): this;
  get(path: E2EPathParams, ...handlers: E2EMiddlewareLike[]): this;
  listen(
    port?: number,
    hostOrCb?: string | (() => void),
    maybeCb?: (() => void) | E2EServerConfigOptions,
    finalCb?: () => void
  ): E2EServerHandle;
  listenTls?: (
    tlsOptions: E2ETlsOptions,
    port?: number,
    hostOrCb?: string | (() => void),
    maybeCb?: (() => void) | E2EServerConfigOptions,
    finalCb?: () => void
  ) => E2EServerHandle;
}

export interface StartedServer {
  baseUrl: string;
  port: number;
  host: string;
  server: E2EServerHandle;
  close: () => Promise<void>;
  closeAllConnections: () => void;
}

function applyAppConfigOptions(app: E2EApplication, options?: E2EServerConfigOptions): void {
  if (!options) return;
  if (options.xPoweredBy !== undefined) {
    app.set('x-powered-by', options.xPoweredBy);
  }
  if (options.etagMode !== undefined) {
    app.set('etag', options.etagMode === 'off' ? false : options.etagMode);
  }
  if (options.caseSensitive !== undefined) {
    app.set('case sensitive routing', options.caseSensitive);
  }
  if (options.strictRouting !== undefined) {
    app.set('strict routing', options.strictRouting);
  }
  if (!isExpressBaseline()) {
    const engineKeys: Array<keyof E2EServerConfigOptions> = [
      'headersTimeoutMs',
      'requestTimeoutMs',
      'keepAliveTimeoutMs',
      'tlsHandshakeTimeoutMs',
      'handlerTimeoutMs',
      'shutdownTimeoutMs',
      'maxConnections',
      'maxHeadersCount',
      'maxHeaderSizeBytes',
      'defaultBodyLimitBytes',
      'streamQueueCapacity',
    ];
    for (const key of engineKeys) {
      const value = options[key];
      if (value !== undefined) {
        app.set(key, value);
      }
    }
  }
}

export function createApp(options?: E2EServerConfigOptions): E2EApplication {
  const app = (isExpressBaseline()
    ? (express as unknown as () => E2EApplication)()
    : (rxpress as unknown as (opts?: E2EServerConfigOptions) => E2EApplication)(options));
  applyAppConfigOptions(app, options);
  return app;
}

export function createRouter(options?: E2ERouterOptions): E2ERouter {
  if (isExpressBaseline()) {
    return (express as unknown as { Router: (o?: E2ERouterOptions) => E2ERouter }).Router(options);
  }
  return (rxpress as unknown as { Router: (o?: E2ERouterOptions) => E2ERouter }).Router(options);
}

export function jsonMiddleware(opts?: E2EJsonOptions): E2ERequestHandler {
  if (isExpressBaseline()) {
    return (express as unknown as { json: (o?: E2EJsonOptions) => E2ERequestHandler }).json(opts);
  }
  return rxJson(opts as unknown as Parameters<typeof rxJson>[0]) as unknown as E2ERequestHandler;
}

export function urlencodedMiddleware(opts?: E2EUrlencodedOptions): E2ERequestHandler {
  if (isExpressBaseline()) {
    return (
      express as unknown as { urlencoded: (o?: E2EUrlencodedOptions) => E2ERequestHandler }
    ).urlencoded(opts);
  }
  return rxUrlencoded(
    opts as unknown as Parameters<typeof rxUrlencoded>[0]
  ) as unknown as E2ERequestHandler;
}

export function textMiddleware(opts?: E2ETextOptions): E2ERequestHandler {
  if (isExpressBaseline()) {
    return (express as unknown as { text: (o?: E2ETextOptions) => E2ERequestHandler }).text(opts);
  }
  return rxText(opts as unknown as Parameters<typeof rxText>[0]) as unknown as E2ERequestHandler;
}

export function rawMiddleware(opts?: E2ERawOptions): E2ERequestHandler {
  if (isExpressBaseline()) {
    return (express as unknown as { raw: (o?: E2ERawOptions) => E2ERequestHandler }).raw(opts);
  }
  return rxRaw(opts as unknown as Parameters<typeof rxRaw>[0]) as unknown as E2ERequestHandler;
}

export function staticMiddleware(root: string, opts?: E2EStaticOptions): E2ERequestHandler {
  if (isExpressBaseline()) {
    return (
      express as unknown as {
        static: (r: string, o?: E2EStaticOptions) => E2ERequestHandler;
      }
    ).static(root, opts);
  }
  return rxServeStatic(
    root,
    opts as unknown as Parameters<typeof rxServeStatic>[1]
  ) as unknown as E2ERequestHandler;
}

export function createHttpsServer(
  tlsOpts: E2ETlsOptions,
  app: E2EApplication
): {
  listen(
    port?: number,
    hostOrCb?: string | (() => void),
    maybeCb?: () => void
  ): E2EServerHandle;
} {
  if (isExpressBaseline()) {
    throw new Error('createHttpsServer is rxpress-specific and not supported on express baseline');
  }
  return rxCreateHttpsServer(
    tlsOpts,
    app as unknown as Parameters<typeof rxCreateHttpsServer>[1]
  ) as unknown as {
    listen(
      port?: number,
      hostOrCb?: string | (() => void),
      maybeCb?: () => void
    ): E2EServerHandle;
  };
}

function applyServerTimeouts(server: E2EServerHandle, timeouts?: E2EServerConfigOptions): void {
  if (!timeouts) return;
  if (isExpressBaseline()) {
    const nodeSrv = server as unknown as http.Server;
    if (timeouts.headersTimeoutMs !== undefined) {
      nodeSrv.headersTimeout = timeouts.headersTimeoutMs;
    }
    if (timeouts.requestTimeoutMs !== undefined) {
      nodeSrv.requestTimeout = timeouts.requestTimeoutMs;
    }
    if (timeouts.keepAliveTimeoutMs !== undefined) {
      nodeSrv.keepAliveTimeout = timeouts.keepAliveTimeoutMs;
    }
    if (timeouts.maxConnections !== undefined) {
      nodeSrv.maxConnections = timeouts.maxConnections;
    }
    if (timeouts.maxHeadersCount !== undefined) {
      nodeSrv.maxHeadersCount = timeouts.maxHeadersCount;
    }
    return;
  }

  const mutable = server as unknown as Record<string, unknown>;
  if (timeouts.headersTimeoutMs !== undefined && 'headersTimeout' in mutable) {
    mutable.headersTimeout = timeouts.headersTimeoutMs;
  }
  if (timeouts.requestTimeoutMs !== undefined && 'requestTimeout' in mutable) {
    mutable.requestTimeout = timeouts.requestTimeoutMs;
  }
  if (timeouts.keepAliveTimeoutMs !== undefined && 'keepAliveTimeout' in mutable) {
    mutable.keepAliveTimeout = timeouts.keepAliveTimeoutMs;
  }
}

export async function startServer(
  app: E2EApplication,
  opts?: {
    port?: number;
    host?: string;
    tls?: E2ETlsOptions;
    timeouts?: E2EServerConfigOptions;
  }
): Promise<StartedServer> {
  const host = opts?.host ?? '127.0.0.1';
  const port = opts?.port ?? 0;

  if (opts?.tls && isExpressBaseline()) {
    throw new Error('startServer with tls is rxpress-specific and not supported on express baseline');
  }

  applyAppConfigOptions(app, opts?.timeouts);

  const server = await new Promise<E2EServerHandle>((resolve, reject) => {
    let settled = false;
    let cbFired = false;
    let handle: E2EServerHandle | undefined;

    const finish = () => {
      if (settled || !handle) return;
      settled = true;
      resolve(handle);
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    try {
      const onListening = () => {
        cbFired = true;
        finish();
      };

      const srv = opts?.tls
        ? (() => {
            if (typeof app.listenTls !== 'function') {
              throw new Error('app.listenTls is not available on this target');
            }
            return app.listenTls(opts.tls, port, host, onListening);
          })()
        : app.listen(port, host, onListening);

      handle = srv;

      if (typeof srv.on === 'function') {
        srv.on('error', fail);
      }

      if (cbFired) {
        finish();
      } else if (!isExpressBaseline() && srv.listening && srv.address()?.port) {
        finish();
      }
    } catch (err) {
      fail(err);
    }
  });

  applyServerTimeouts(server, opts?.timeouts);

  const addr = server.address();
  if (!addr || !addr.port) {
    throw new Error('Server bound without a valid listening port');
  }

  const resolvedHost = addr.address === '0.0.0.0' || addr.address === '::' ? '127.0.0.1' : addr.address;
  const formattedHost =
    resolvedHost.includes(':') && !resolvedHost.startsWith('[')
      ? `[${resolvedHost}]`
      : resolvedHost;
  const protocol = opts?.tls ? 'https' : 'http';
  const baseUrl = `${protocol}://${formattedHost}:${addr.port}`;

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (isExpressBaseline()) {
        const nodeSrv = server as unknown as http.Server;
        if (!nodeSrv.listening) return;
        await new Promise<void>((resolve, reject) => {
          nodeSrv.close((err?: Error) => {
            if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      } else {
        await Promise.resolve(server.close());
      }
    })();
    return closePromise;
  };

  const closeAllConnections = (): void => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  };

  return {
    baseUrl,
    port: addr.port,
    host: resolvedHost,
    server,
    close,
    closeAllConnections,
  };
}

export async function startTlsServer(
  app: E2EApplication,
  tlsOpts: E2ETlsOptions,
  opts?: {
    port?: number;
    host?: string;
    timeouts?: E2EServerConfigOptions;
  }
): Promise<StartedServer> {
  return startServer(app, {
    ...opts,
    tls: tlsOpts,
  });
}

export function createSelfSignedCert(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'rxpress-e2e-cert-'));
  try {
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-nodes',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' }
    );
    return {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
