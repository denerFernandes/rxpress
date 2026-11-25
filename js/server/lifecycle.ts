/**
 * Server lifecycle: engine configuration from app settings, start (HTTP or TLS), and the
 * `net.Server`-like handle returned by `listen()` (close, ref/unref, events).
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { Application } from '../application.js';
import {
  loadNativeAddon,
  type NativeServerConfig,
  type NativeTlsConfig,
} from '../native.js';
import type { AddressInfo, ServerHandle, TlsOptions } from '../types.js';
import { compileIntoNative } from './fast-routes.js';
import { ServerRuntime } from './runtime.js';

const OPTIONAL_NUMERIC_SETTINGS: Array<[string, keyof NativeServerConfig]> = [
  ['headersTimeoutMs', 'headersTimeoutMs'],
  ['requestTimeoutMs', 'requestTimeoutMs'],
  ['keepAliveTimeoutMs', 'keepAliveTimeoutMs'],
  ['tlsHandshakeTimeoutMs', 'tlsHandshakeTimeoutMs'],
  ['handlerTimeoutMs', 'handlerTimeoutMs'],
  ['writeTimeoutMs', 'writeTimeoutMs'],
  ['shutdownTimeoutMs', 'shutdownTimeoutMs'],
  ['maxConnections', 'maxConnections'],
  ['maxHeadersCount', 'maxHeadersCount'],
  ['maxHeaderSizeBytes', 'maxHeaderSizeBytes'],
  ['defaultBodyLimitBytes', 'defaultBodyLimitBytes'],
  ['streamQueueCapacity', 'streamQueueCapacity'],
];

function buildNativeConfig(app: Application): NativeServerConfig {
  const etagSetting = app.get('etag');
  const etagMode: 'weak' | 'strong' | 'off' =
    etagSetting === false || etagSetting === 'off'
      ? 'off'
      : etagSetting === 'strong'
        ? 'strong'
        : 'weak';

  const nativeCfg: NativeServerConfig = {
    xPoweredBy: Boolean(app.get('x-powered-by')),
    etagMode,
    caseSensitive: Boolean(app.get('case sensitive routing')),
    strictRouting: Boolean(app.get('strict routing')),
  };
  for (const [settingKey, cfgKey] of OPTIONAL_NUMERIC_SETTINGS) {
    const val = app.settings[settingKey];
    if (val === undefined) continue;
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > 0xffffffff) {
      throw new RangeError(
        `Invalid ${settingKey}: ${String(val)} (expected integer 0..4294967295)`
      );
    }
    (nativeCfg as Record<string, unknown>)[cfgKey] = val === 0 ? 0 : val;
  }
  return nativeCfg;
}

function loadPemBuffer(input: string | Buffer): Buffer {
  if (
    input === undefined ||
    input === null ||
    (typeof input !== 'string' && !Buffer.isBuffer(input))
  ) {
    throw new TypeError('TLS certificate and key must be a file path, PEM string, or Buffer');
  }
  if (Buffer.isBuffer(input)) return input;
  if (input.includes('-----BEGIN')) {
    return Buffer.from(input, 'utf8');
  }
  return readFileSync(input);
}

export interface StartOptions {
  host: string;
  port: number;
  tlsOptions: TlsOptions | undefined;
  callback: ((err?: Error) => void) | undefined;
  bridgeMode: boolean;
  /** Whether `handle` is still the app's current server (app-level 'listening'/'close'). */
  isCurrent: (handle: ServerHandle) => boolean;
}

/** Start an engine instance serving `app`; returns its handle. */
export function startServer(app: Application, opts: StartOptions): ServerHandle {
  const { host, port, tlsOptions, callback, bridgeMode } = opts;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`Invalid port: ${port} (expected integer 0..65535)`);
  }

  const addon = loadNativeAddon();
  const nativeCfg = buildNativeConfig(app);

  const native = new addon.NativeServer(nativeCfg);
  const fastRoutes = compileIntoNative(app._router, native, nativeCfg);
  const runtime = new ServerRuntime(app, native, fastRoutes, bridgeMode);

  const nativeTls: NativeTlsConfig | undefined = tlsOptions
    ? {
        cert: loadPemBuffer(tlsOptions.cert),
        key: loadPemBuffer(tlsOptions.key),
      }
    : undefined;

  let addrInfo: AddressInfo;
  try {
    addrInfo = native.start(host, port, runtime.drainLoop, nativeTls);
  } catch (err) {
    if (err instanceof Error && /address already in use|EADDRINUSE/i.test(err.message)) {
      (err as NodeJS.ErrnoException).code = 'EADDRINUSE';
    }
    // Express 5 hands server errors to the listen callback (`server.once('error', cb)`);
    // without one the error is thrown here.
    if (!callback || !(err instanceof Error)) throw err;
    const failed = failedServerHandle();
    queueMicrotask(() => {
      if (failed.listenerCount('error') > 0) failed.emit('error', err);
      callback(err);
    });
    return failed;
  }

  const handle = createServerHandle(app, runtime, nativeCfg, addrInfo, opts);

  if (!bridgeMode) {
    runtime.upgrades.attach(handle);
  }
  queueMicrotask(() => {
    if (!runtime.closed && !runtime.closing) {
      handle.emit('listening');
      if (!bridgeMode && opts.isCurrent(handle)) app.emit('listening');
    }
    if (callback) {
      callback();
    }
  });

  return handle;
}

/** The handle `listen()` returns when the engine could not bind (like a Node server that failed). */
function failedServerHandle(): ServerHandle {
  const emitter = new EventEmitter();
  const handle: ServerHandle = Object.assign(emitter, {
    listening: false,
    timeout: 0,
    keepAliveTimeout: 5000,
    headersTimeout: 60000,
    requestTimeout: 300000,
    address(): AddressInfo | null {
      return null;
    },
    async close(cb?: (err?: Error) => void): Promise<void> {
      const err = Object.assign(new Error('Server is not running.'), {
        code: 'ERR_SERVER_NOT_RUNNING',
      });
      if (cb) cb(err);
    },
    closeAllConnections(): void {},
    closeIdleConnections(): void {},
    ref(): ServerHandle {
      return handle;
    },
    unref(): ServerHandle {
      return handle;
    },
    setTimeout(msecs?: number, cb?: () => void): ServerHandle {
      if (typeof msecs === 'number') handle.timeout = msecs;
      if (cb) handle.on('timeout', cb);
      return handle;
    },
  }) as ServerHandle;
  return handle;
}

function createServerHandle(
  app: Application,
  runtime: ServerRuntime,
  nativeCfg: NativeServerConfig,
  addrInfo: AddressInfo,
  opts: StartOptions
): ServerHandle {
  const native = runtime.native;
  const bridgeMode = opts.bridgeMode;
  let closeEmitted = false;
  let closePromise: Promise<void> | null = null;

  const emitter = new EventEmitter();
  const handle: ServerHandle = Object.assign(emitter, {
    listening: true,
    timeout: 0,
    keepAliveTimeout: nativeCfg.keepAliveTimeoutMs ?? 5000,
    headersTimeout: nativeCfg.headersTimeoutMs ?? 60000,
    requestTimeout: nativeCfg.requestTimeoutMs ?? 300000,
    address(): AddressInfo | null {
      return runtime.closed || runtime.closing ? null : addrInfo;
    },
    async close(cb?: (err?: Error) => void): Promise<void> {
      handle.listening = false;
      if (!closePromise) {
        runtime.closing = true;
        closePromise = new Promise<void>((resolve) => {
          native.beginClose(nativeCfg.shutdownTimeoutMs, () => {
            runtime.closed = true;
            native.close();
            if (!closeEmitted) {
              closeEmitted = true;
              handle.emit('close');
              if (!bridgeMode && opts.isCurrent(handle)) app.emit('close');
            }
            resolve();
          });
        });
      }
      await closePromise;
      if (cb) cb();
    },
    closeAllConnections(): void {
      handle.listening = false;
      runtime.closing = true;
      native.forceClose?.();
    },
    closeIdleConnections(): void {
      // Idle keep-alive connections are drained cleanly on close()
    },
    ref(): ServerHandle {
      native.refer?.();
      return handle;
    },
    unref(): ServerHandle {
      native.unref?.();
      return handle;
    },
    setTimeout(msecs?: number, cb?: () => void): ServerHandle {
      if (typeof msecs === 'number') {
        handle.timeout = msecs;
      }
      if (cb) {
        handle.on('timeout', cb);
      }
      return handle;
    },
  }) as ServerHandle;
  return handle;
}
