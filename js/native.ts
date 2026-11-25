import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface NativeServerConfig {
  xPoweredBy?: boolean;
  etagMode?: 'weak' | 'strong' | 'off';
  caseSensitive?: boolean;
  strictRouting?: boolean;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  tlsHandshakeTimeoutMs?: number;
  handlerTimeoutMs?: number;
  /** Write idle timeout (ms): a peer that reads nothing for this long is dropped. 0 disables; default 30000. */
  writeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxConnections?: number;
  maxHeadersCount?: number;
  maxHeaderSizeBytes?: number;
  defaultBodyLimitBytes?: number;
  streamQueueCapacity?: number;
  /** Threads of the engine's I/O runtime (created once per process; default 1). */
  ioThreads?: number;
}

export interface NativeStaticMount {
  prefix: string;
  root: string;
  index?: string[];
  maxAgeSecs?: number;
  etag?: boolean;
  lastModified?: boolean;
  dotfiles?: string;
  fallthrough?: boolean;
  extensions?: string[];
  immutable?: boolean;
  redirect?: boolean;
}

export interface NativeBodyRule {
  prefix: string;
  mode: number;
  limit: number;
  contentTypes: string[];
}

export interface NativeTlsConfig {
  cert: Buffer;
  key: Buffer;
}

export interface NativeAddressInfo {
  address: string;
  port: number;
  family: string;
}

export interface NativeServerMetrics {
  tlsHandshakeErrors: number;
  tlsHandshakeTimeouts: number;
  rejectedConnections: number;
  requestTimeouts: number;
  handlerTimeouts: number;
  activeConnections: number;
}

export interface NativeServerInstance {
  setConfig(cfg: NativeServerConfig): void;
  addRoute(method: string, path: string, routeId: number): boolean;
  addStatic(mount: NativeStaticMount): void;
  addBodyRule(rule: NativeBodyRule): void;
  start(
    host: string,
    port: number,
    onWakeup: () => void,
    tls?: NativeTlsConfig
  ): NativeAddressInfo;
  drainBatchInto(buf: Buffer, maxBatch?: number): number;
  drainClosedStreams(): Uint32Array | null;
  drainStreamEvents?(): Uint32Array | null;
  takeRequestBody(reqId: number): Array<number | Buffer> | null;
  releaseRequestBody(reqId: number): void;
  /** Upgrade requests leave the engine while JS listens for 'upgrade'. */
  setUpgradeEnabled?(enabled: boolean): void;
  /** `[fd, head]` of an upgraded request's socket (ownership of `fd` moves to JS). */
  takeUpgrade?(reqId: number): Array<number | Buffer> | null;
  flushResponses(buf: Buffer, byteLength: number): void;
  streamStart(
    reqId: number,
    status: number,
    headersFlat: string[],
    suppressXPoweredBy: boolean
  ): boolean;
  streamWrite(reqId: number, chunk: Buffer): number | boolean;
  streamEnd(reqId: number, finalChunk?: Buffer | null): void;
  streamAbort?(reqId: number): void;
  beginClose(timeoutMs: number | undefined | null, onDrained: () => void): void;
  getMetrics(): NativeServerMetrics | null;
  close(): void;
  forceClose?(): void;
  refer?(): void;
  unref?(): void;
}

export interface NativeAddon {
  NativeServer: new (cfg?: NativeServerConfig) => NativeServerInstance;
  /** `mime-types.contentType(ext)` from the engine's table (mime-db), or null. */
  mimeContentType(ext: string): string | null;
}

let cachedAddon: NativeAddon | null = null;

export function resolveCurrentDir(): string {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  return dirname(fileURLToPath(import.meta.url));
}

/** Detects musl libc on Linux (glibc exposes `glibcVersionRuntime` in the diagnostic report). */
export function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const report = (process as unknown as {
      report?: { getReport(): { header?: { glibcVersionRuntime?: string } } };
    }).report;
    const header = report?.getReport().header;
    if (header) return !header.glibcVersionRuntime;
  } catch {
    // fall through to the filesystem probe
  }
  try {
    return readdirSync('/lib').some((f) => f.startsWith('ld-musl-'));
  } catch {
    return false;
  }
}

/** napi-rs style platform suffix for the given runtime, e.g. `linux-x64-gnu` or `darwin-arm64`. */
export function platformTriple(
  platform: string = process.platform,
  arch: string = process.arch,
  musl: boolean = platform === 'linux' && isMusl()
): string {
  if (platform === 'linux') return `${platform}-${arch}-${musl ? 'musl' : 'gnu'}`;
  if (platform === 'win32') return `${platform}-${arch}-msvc`;
  return `${platform}-${arch}`;
}

/** Name of the optional dependency that carries the binary for `triple`. */
export function platformPackageName(triple: string = platformTriple()): string {
  return `@rxpress/rxpress-${triple}`;
}

export function loadNativeAddon(): NativeAddon {
  if (cachedAddon) return cachedAddon;

  const baseDir = resolveCurrentDir();
  const candidates = [
    join(baseDir, '..', 'native', 'rxpress.node'),
    join(baseDir, 'native', 'rxpress.node'),
    join(process.cwd(), 'native', 'rxpress.node'),
  ];

  const nodeRequire = createRequire(join(baseDir, 'package.json'));

  // 1. A local build (development): native/rxpress.node.
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedAddon = nodeRequire(candidate) as NativeAddon;
      return cachedAddon;
    }
  }

  // 2. The prebuilt platform package installed through optionalDependencies.
  const triple = platformTriple();
  const pkg = platformPackageName(triple);
  let cause: unknown;
  try {
    cachedAddon = nodeRequire(pkg) as NativeAddon;
    return cachedAddon;
  } catch (err) {
    cause = err;
  }

  throw new Error(
    `[rxpress] Native addon not found for ${process.platform}-${process.arch}` +
      `${process.platform === 'linux' ? (isMusl() ? ' (musl)' : ' (glibc)') : ''}.\n` +
      `Expected the npm package "${pkg}" (an optionalDependency of rxpress); reinstall without ` +
      `--omit=optional / --no-optional, and make sure this platform is supported.\n` +
      `For a source checkout, run "npm run build:native" (checked: ${candidates.join(', ')}).\n` +
      `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`
  );
}
