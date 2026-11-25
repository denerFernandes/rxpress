import * as zlib from 'node:zlib';
import type { RxRequest } from '../request.js';
import type { RxResponse } from '../response.js';
import { createHttpError } from '../security.js';
import type { NativeMiddlewareMeta, NextFunction } from '../types.js';

/** @internal */
export const nativeMiddlewareMeta = new WeakMap<Function, NativeMiddlewareMeta>();

export function parseSizeLimit(limit: number | string | undefined, defaultBytes = 102400): number {
  if (limit === undefined) return defaultBytes;
  if (typeof limit === 'number') return limit;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(limit.trim());
  if (!match) return defaultBytes;
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  switch (unit) {
    case 'kb':
      return Math.floor(num * 1024);
    case 'mb':
      return Math.floor(num * 1024 * 1024);
    case 'gb':
      return Math.floor(num * 1024 * 1024 * 1024);
    default:
      return Math.floor(num);
  }
}

export function normalizeTypes(
  type: string | string[] | ((req: RxRequest) => boolean) | undefined,
  defaultTypes: string[],
): { list: string[]; customFn?: (req: RxRequest) => boolean } {
  if (typeof type === 'function') {
    return { list: ['*/*'], customFn: type };
  }
  if (typeof type === 'string') {
    return { list: [type] };
  }
  if (Array.isArray(type)) {
    return { list: type };
  }
  return { list: defaultTypes };
}

// ---- body-parser@2 shared reading semantics ----

/** body-parser: `verify` may be omitted or false, anything else must be a function. */
export function checkVerifyOption(verify: unknown): void {
  if (verify !== undefined && verify !== false && typeof verify !== 'function') {
    throw new TypeError('option verify must be function');
  }
}

/** type-is `hasBody`: a Transfer-Encoding header or a numeric Content-Length. */
function hasBody(req: RxRequest): boolean {
  if (req._bodyLen > 0 || req._isStreamedBody()) return true;
  const h = req.headers;
  if (h['transfer-encoding'] !== undefined) return true;
  const cl = h['content-length'];
  return cl !== undefined && !Number.isNaN(Number(cl));
}

/**
 * Whether this parser handles the request: the engine already matched it (`nativeMode`), or it
 * has a body whose type matches. As in body-parser, a custom `type` function is never called
 * for a request without a body.
 */
export function shouldParse(
  req: RxRequest,
  nativeMode: number,
  list: string[],
  customFn: ((req: RxRequest) => boolean) | undefined,
): boolean {
  if (req._bodyMode === nativeMode) return true;
  if (!hasBody(req)) return false;
  return customFn ? Boolean(customFn(req)) : Boolean(req.is(...list));
}

export type HttpError = Error & {
  status: number;
  statusCode: number;
  type: string;
  [k: string]: unknown;
};

export function bodyError(
  status: number,
  message: string,
  type: string,
  extra?: Record<string, unknown>,
): HttpError {
  const err = createHttpError(status, message, type) as unknown as HttpError;
  if (extra) Object.assign(err, extra);
  return err;
}

/** `charset` parameter of Content-Type, lower-cased (body-parser `getCharset`). */
export function requestCharset(req: RxRequest): string | undefined {
  const ct = req.headers['content-type'];
  if (typeof ct !== 'string') return undefined;
  const m = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(ct);
  const v = m ? (m[1] ?? m[2]) : undefined;
  return v ? v.toLowerCase() : undefined;
}

export function unsupportedCharset(charset: string): HttpError {
  return bodyError(415, `unsupported charset "${charset.toUpperCase()}"`, 'charset.unsupported', {
    charset,
  });
}

export type ZlibAsync = (
  buf: Buffer,
  opts: zlib.ZlibOptions | zlib.BrotliOptions,
  cb: (err: Error | null, result: Buffer) => void,
) => void;
const zstdDecompress = (zlib as unknown as { zstdDecompress?: ZlibAsync }).zstdDecompress;

/**
 * Undo `Content-Encoding` (deflate, gzip, br, zstd) like body-parser's `inflate: true`, with the
 * size limit applied to the *decoded* bytes so a decompression bomb is a 413, not an OOM.
 * Decompression runs on the libuv threadpool (never blocks the event loop); an identity body
 * completes synchronously. Unsupported encodings throw synchronously.
 */
export function inflateBody(
  req: RxRequest,
  raw: Buffer,
  limit: number,
  inflate: boolean,
  cb: (err: Error | null, out?: Buffer) => void,
): void {
  const header = req.headers['content-encoding'];
  const encoding = (typeof header === 'string' ? header : 'identity').toLowerCase();
  if (encoding === 'identity') return cb(null, raw);
  if (!inflate) {
    throw bodyError(415, 'content encoding unsupported', 'encoding.unsupported', { encoding });
  }
  let fn: ZlibAsync | undefined;
  switch (encoding) {
    case 'deflate':
      fn = zlib.inflate as unknown as ZlibAsync;
      break;
    case 'gzip':
      fn = zlib.gunzip as unknown as ZlibAsync;
      break;
    case 'br':
      fn = zlib.brotliDecompress as unknown as ZlibAsync;
      break;
    case 'zstd':
      fn = zstdDecompress;
      break;
  }
  if (fn === undefined) {
    throw bodyError(415, `unsupported content encoding "${encoding}"`, 'encoding.unsupported', {
      encoding,
    });
  }
  const fail = (err: unknown): HttpError =>
    (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError
      ? bodyError(413, 'request entity too large', 'entity.too.large', {
          limit,
        })
      : bodyError(400, (err as Error).message || 'invalid compressed body', 'entity.parse.failed');
  try {
    // limit + 1 so an overflow is detectable by the caller's length check.
    fn(raw, { maxOutputLength: Math.max(1, limit) + 1 }, (err, out) => {
      if (err) return cb(fail(err));
      cb(null, out);
    });
  } catch (err) {
    cb(fail(err));
  }
}

/** body-parser wraps `verify` failures in a 403 unless the thrown error carries its own status. */
export function runVerify(fn: () => void, body: Buffer): void {
  try {
    fn();
  } catch (err) {
    const e = (err instanceof Error ? err : new Error(String(err))) as HttpError;
    if (!('body' in e)) e.body = body;
    if (typeof e.status !== 'number' && typeof e.statusCode !== 'number') {
      e.status = 403;
      e.statusCode = 403;
    }
    if (typeof e.type !== 'string') e.type = 'entity.verify.failed';
    throw e;
  }
}

/** iconv-style decode: BOM stripped; unknown charsets are a 415. */
export function decodeCharset(buf: Buffer, charset: string): string {
  let str: string;
  if (charset === 'utf-8' || charset === 'utf8') {
    str = buf.toString('utf8');
  } else if (charset === 'iso-8859-1' || charset === 'latin1' || charset === 'binary') {
    return buf.toString('latin1');
  } else if (charset === 'us-ascii' || charset === 'ascii') {
    return buf.toString('latin1');
  } else {
    let decoder: { decode(input: Uint8Array): string };
    let label = charset;
    // iconv-lite: plain "utf-16" follows the BOM (big-endian when it says so), else LE.
    if (charset === 'utf-16' || charset === 'utf16') {
      label = buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff ? 'utf-16be' : 'utf-16le';
    }
    try {
      decoder = new TextDecoder(label);
    } catch {
      throw unsupportedCharset(charset);
    }
    return decoder.decode(buf);
  }
  return str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
}

/**
 * Shared body-parser pipeline after type matching: limit, inflate, verify, then charset decode.
 * Hands the decoded Buffer (raw) or string to `cb`, or an http error for `next(err)`.
 */
export function readParsedBody(
  req: RxRequest,
  res: RxResponse,
  limit: number,
  inflate: boolean,
  verify: ((req: never, res: never, buf: Buffer, encoding: string) => void) | undefined,
  charset: string | null,
  body: Buffer,
  cb: (err: unknown, out?: Buffer | string) => void,
): void {
  if (body.length > limit) {
    return cb(bodyError(413, 'request entity too large', 'entity.too.large', { limit }));
  }
  // raw-body: the bytes read must match a declared Content-Length (identity encoding only).
  const declared = req.headers['content-length'];
  if (declared !== undefined && req.headers['content-encoding'] === undefined) {
    const expected = Number(declared);
    if (!Number.isNaN(expected) && expected !== body.length) {
      return cb(
        bodyError(400, 'request size did not match content length', 'request.size.invalid', {
          expected,
          length: expected,
          received: body.length,
        }),
      );
    }
  }
  let called = false;
  const after = (err: Error | null, raw?: Buffer): void => {
    called = true;
    if (err) return cb(err);
    let out: Buffer | string;
    try {
      if (raw!.length > limit) {
        throw bodyError(413, 'request entity too large', 'entity.too.large', {
          limit,
        });
      }
      if (verify) {
        if (charset !== null && charset !== 'utf-8' && charset !== 'iso-8859-1') {
          // body-parser checks the charset exists before calling verify
          decodeCharset(Buffer.alloc(0), charset);
        }
        const buf = raw!;
        runVerify(() => verify(req as never, res as never, buf, charset ?? 'binary'), buf);
      }
      out = charset === null ? raw! : decodeCharset(raw!, charset);
    } catch (e) {
      return cb(e);
    }
    cb(null, out);
  };
  try {
    inflateBody(req, body, limit, inflate, after);
  } catch (e) {
    if (called) throw e; // came from the continuation, not from inflating
    cb(e);
  }
}

export type VerifyFn =
  ((req: never, res: never, buf: Buffer, encoding: string) => void) | undefined;

/**
 * Run `readParsedBody` over the request body and hand the result to `use`. Bodies the engine
 * buffered are processed synchronously (hot path); a streamed body (no native parser rule
 * matched this request) is collected first, enforcing `limit` while it arrives.
 */
export function withParsedBody(
  req: RxRequest,
  res: RxResponse,
  next: NextFunction,
  limit: number,
  inflate: boolean,
  verify: VerifyFn,
  charset: string | null,
  use: (body: Buffer | string) => void,
): void {
  const finish = (raw: Buffer): void => {
    readParsedBody(req, res, limit, inflate, verify, charset, raw, (err, out) => {
      if (err) return next(err);
      use(out!);
    });
  };
  if (!req._isStreamedBody()) {
    req._markBodyConsumed();
    finish(req._getRawBody());
    return;
  }
  req._collectBody(limit, (err, raw) => {
    if (err) return next(err);
    finish(raw!);
  });
}
