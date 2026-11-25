/*
 * Buffered side of `RxResponse`: json/jsonp/send/sendStatus (with the ultra-fast batch path),
 * the buffered write helpers shared with `res.end()`, the writeHead-hook slow path, and
 * sendFile/download. Plain functions over the response; `RxResponse` keeps thin methods that
 * delegate here.
 */
import { open, realpath, stat } from 'node:fs/promises';
import { STATUS_CODES } from 'node:http';
import { basename, isAbsolute, normalize, resolve, sep } from 'node:path';
import {
  CT_CUSTOM,
  CT_HTML,
  CT_JSON,
  CT_OCTET_STREAM,
  CT_TEXT_PLAIN,
  RESP_FLAG_FILE_META,
  RESP_FLAG_IS_FILE,
  RESP_FLAG_SUPPRESS_ETAG,
  RESP_FLAG_SUPPRESS_POWERED_BY,
} from './protocol.js';
import { RxResponse } from './response.js';
import { contentDisposition, UP_PATH_REGEXP } from './security.js';
import type { SendFileOptions } from './types.js';

const MAX_AGE_CAP_SECS = 31536000;

function parseSendFileMaxAgeSecs(maxAge: number | string | undefined): number {
  if (maxAge === undefined) return 0;
  let secs = 0;
  if (typeof maxAge === 'number') {
    secs = Number.isFinite(maxAge) ? Math.floor(maxAge / 1000) : 0;
  } else if (typeof maxAge === 'string') {
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(maxAge.trim());
    if (match) {
      const n = parseFloat(match[1]);
      const u = (match[2] || 'ms').toLowerCase();
      switch (u) {
        case 's':
          secs = Math.floor(n);
          break;
        case 'm':
          secs = Math.floor(n * 60);
          break;
        case 'h':
          secs = Math.floor(n * 3600);
          break;
        case 'd':
          secs = Math.floor(n * 86400);
          break;
        default:
          secs = Math.floor(n / 1000);
          break;
      }
    }
  }
  if (secs <= 0) return 0;
  return secs > MAX_AGE_CAP_SECS ? MAX_AGE_CAP_SECS : secs;
}

/** @internal */
export function fastCtToString(ctCode: number): string | undefined {
  if (ctCode === CT_TEXT_PLAIN) return 'text/plain; charset=utf-8';
  if (ctCode === CT_JSON) return 'application/json; charset=utf-8';
  if (ctCode === CT_HTML) return 'text/html; charset=utf-8';
  if (ctCode === CT_OCTET_STREAM) return 'application/octet-stream';
  return undefined;
}

/** @internal */
export function throwHeadersSent(action: string): never {
  const err = new Error(`Cannot ${action} headers after they are sent to the client`);
  (err as NodeJS.ErrnoException).code = 'ERR_HTTP_HEADERS_SENT';
  throw err;
}

/** @internal `res.json()`. */
export function sendJson(res: RxResponse, body?: unknown): RxResponse {
  // Express: sending after headers went out (res.write/res.end/res.send) throws.
  if (res.headersSent) throwHeadersSent('set');
  const replacer = res.app._jsonReplacer;
  const spaces = res.app._jsonSpaces;
  const str =
    replacer !== undefined || spaces !== undefined
      ? JSON.stringify(body, replacer, spaces)
      : JSON.stringify(body);
  const payload = str === undefined ? '' : str;

  // Ultra-fast path: no custom headers, no wrapped writeHead/end/write, not streaming
  if (
    !res._streaming &&
    res._headers === null &&
      res._statusMessage === undefined &&
    res.writeHead === RxResponse.prototype.writeHead &&
    res.end === RxResponse.prototype.end &&
    res.write === RxResponse.prototype.write
  ) {
    let flags = 0;
    if (res._suppressXpb) flags |= RESP_FLAG_SUPPRESS_POWERED_BY;
    if (res._suppressEtag) flags |= RESP_FLAG_SUPPRESS_ETAG;
    res._lastBodyStr = payload;
    res._writer.writeFastString(
      res._reqId,
      res.statusCode,
      CT_JSON,
      flags,
      null,
      payload
    );
    res._markFinished();
    return res;
  }

  if (!res.hasHeader('content-type')) {
    if (res._streaming) {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(payload);
      return res;
    }
    sendBufferedString(res, payload, CT_JSON);
    return res;
  }
  sendBufferedString(res, payload, CT_CUSTOM);
  return res;
}

/** @internal `res.jsonp()`. */
export function sendJsonp(res: RxResponse, body?: unknown): RxResponse {
  // Express: sending after headers went out (res.write/res.end/res.send) throws.
  if (res.headersSent) throwHeadersSent('set');
  const cbName = String(res.app.get('jsonp callback name') || 'callback');
  const rawCb = res.req.query[cbName];
  const cb = Array.isArray(rawCb) ? rawCb[0] : rawCb;
  if (typeof cb === 'string' && cb.length > 0) {
    const safeCb = cb.replace(/[^[\]\w$.]/g, '');
    if (safeCb.length > 0) {
      const replacer = res.app._jsonReplacer;
      const spaces = res.app._jsonSpaces;
      const jsonStr =
        (replacer !== undefined || spaces !== undefined
          ? JSON.stringify(body, replacer, spaces)
          : JSON.stringify(body)) ?? '';
      const escaped = jsonStr
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
      const payload = `/**/ typeof ${safeCb} === 'function' && ${safeCb}(${escaped});`;
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      sendBufferedString(res, payload, CT_CUSTOM);
      return res;
    }
  }
  return res.json(body);
}

/** @internal `res.send()`. */
export function sendBody(res: RxResponse, body?: unknown): RxResponse {
  // Express: sending after headers went out (res.write/res.end/res.send) throws.
  if (res.headersSent) throwHeadersSent('set');

  if (body === undefined || body === null) {
    const ctCode =
      res.statusCode === 204 || res.statusCode === 304 ? CT_CUSTOM : res._fastCtCode;
    sendBufferedString(res, '', ctCode);
    return res;
  }

  if (typeof body === 'string') {
    const ctCode =
      res._fastCtCode !== CT_CUSTOM
        ? res._fastCtCode
        : res.hasHeader('content-type')
          ? CT_CUSTOM
          : CT_HTML;
    if (
      !res._streaming &&
      res._headers === null &&
      res._statusMessage === undefined &&
      res.writeHead === RxResponse.prototype.writeHead &&
      res.end === RxResponse.prototype.end &&
      res.write === RxResponse.prototype.write
    ) {
      let flags = 0;
      if (res._suppressXpb) flags |= RESP_FLAG_SUPPRESS_POWERED_BY;
      if (res._suppressEtag) flags |= RESP_FLAG_SUPPRESS_ETAG;
      res._lastBodyStr = body;
      res._writer.writeFastString(
        res._reqId,
        res.statusCode,
        ctCode,
        flags,
        null,
        body
      );
      res._markFinished();
      return res;
    }
    sendBufferedString(res, body, ctCode);
    return res;
  }

  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    const ctCode =
      res._fastCtCode !== CT_CUSTOM
        ? res._fastCtCode
        : res.hasHeader('content-type')
          ? CT_CUSTOM
          : CT_OCTET_STREAM;
    sendBufferedBuffer(res, body, ctCode);
    return res;
  }

  if (typeof body === 'object' || typeof body === 'boolean' || typeof body === 'number') {
    return res.json(body);
  }

  return res.send(String(body));
}

/** @internal `res.sendStatus()`. */
export function sendStatusCode(res: RxResponse, code: number): RxResponse {
  // Express: sending after headers went out (res.write/res.end/res.send) throws.
  if (res.headersSent) throwHeadersSent('set');
  const body = STATUS_CODES[code] || String(code);
  res.status(code);
  if (
    !res._streaming &&
    res._headers === null &&
      res._statusMessage === undefined &&
    res.writeHead === RxResponse.prototype.writeHead &&
    res.end === RxResponse.prototype.end &&
    res.write === RxResponse.prototype.write
  ) {
    let flags = 0;
    if (res._suppressXpb) flags |= RESP_FLAG_SUPPRESS_POWERED_BY;
    if (res._suppressEtag) flags |= RESP_FLAG_SUPPRESS_ETAG;
    res._lastBodyStr = body;
    res._writer.writeFastString(res._reqId, code, CT_TEXT_PLAIN, flags, null, body);
    res._markFinished();
    return res;
  }
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  sendBufferedString(res, body, CT_CUSTOM);
  return res;
}

/** @internal `res.download()`: `sendFile` with a Content-Disposition attachment. */
export function download(
  res: RxResponse,
  filePath: string,
  filenameOrOpts?: string | SendFileOptions | ((err?: Error) => void),
  optsOrCb?: SendFileOptions | ((err?: Error) => void),
  maybeCb?: (err?: Error) => void
): void {
  let filename = basename(filePath);
  let opts: SendFileOptions = {};
  let cb: ((err?: Error) => void) | undefined;

  if (typeof filenameOrOpts === 'string') {
    filename = filenameOrOpts;
    if (typeof optsOrCb === 'function') cb = optsOrCb;
    else if (optsOrCb) {
      opts = optsOrCb;
      cb = maybeCb;
    }
  } else if (typeof filenameOrOpts === 'function') {
    cb = filenameOrOpts;
  } else if (filenameOrOpts) {
    opts = filenameOrOpts;
    if (typeof optsOrCb === 'function') cb = optsOrCb;
  }

  const headers: Record<string, string | string[]> = {
    'Content-Disposition': contentDisposition(basename(filename)),
  };
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      headers[k] = v;
    }
  }
  const mergedOpts: SendFileOptions = { ...opts, headers };
  const resolved = opts.root ? filePath : resolve(filePath);
  res.sendFile(resolved, mergedOpts, cb);
}

/**
 * Slow path for a user-wrapped `writeHead` (`on-headers`, `morgan`, `compression`): expose the
 * implied Content-Type/Content-Length through `getHeader()` before the hook runs, then honour
 * whatever the hook changed. Returns the content-type code to put on the wire.
 * @internal
 */
function runHookedWriteHead(res: RxResponse, ctCode: number): number {
  const hasExplicitCt = res._headers !== null && res._headers.has('content-type');
  const exposedFastCt = ctCode !== CT_CUSTOM && !hasExplicitCt && res._fastCtCode === CT_CUSTOM;
  if (exposedFastCt) res._fastCtCode = ctCode;
  res._triggerWriteHeadHook();
  if (res._headers !== null && res._headers.has('content-type')) return CT_CUSTOM;
  if (res._fastCtCode !== CT_CUSTOM) return res._fastCtCode;
  // The hook removed the implied content-type: send none.
  return exposedFastCt ? CT_CUSTOM : ctCode;
}

/** @internal */
function materializeFastCt(res: RxResponse, ctCode: number): number {
  if (ctCode !== CT_CUSTOM && !res.hasHeader('content-type')) {
    const ct = fastCtToString(ctCode);
    if (ct) {
      res.setHeader('content-type', ct);
      res._fastCtCode = CT_CUSTOM;
      return CT_CUSTOM;
    }
  }
  return ctCode;
}

/** @internal */
export function writeBufferedSyncString(res: RxResponse, body: string, ctCode: number): void {
  if (res._header === null && res.writeHead !== RxResponse.prototype.writeHead) {
    res._lastBodyStr = body;
    ctCode = runHookedWriteHead(res, ctCode);
  } else {
    res._triggerWriteHeadHook();
  }
  let flags = 0;
  if (res._suppressXpb) flags |= RESP_FLAG_SUPPRESS_POWERED_BY;
  if (res._suppressEtag) flags |= RESP_FLAG_SUPPRESS_ETAG;
  res._lastBodyStr = body;
  res._writer.writeFastString(
    res._reqId,
    res.statusCode,
    ctCode,
    flags,
    res._wireHeaders(),
    body
  );
  res._markFinished();
}

/** @internal */
export function writeBufferedSyncBuffer(res: RxResponse, buf: Uint8Array, ctCode: number): void {
  if (res._header === null && res.writeHead !== RxResponse.prototype.writeHead) {
    res._contentLength = buf.byteLength;
    ctCode = runHookedWriteHead(res, ctCode);
  } else {
    res._triggerWriteHeadHook();
  }
  let flags = 0;
  if (res._suppressXpb) flags |= RESP_FLAG_SUPPRESS_POWERED_BY;
  if (res._suppressEtag) flags |= RESP_FLAG_SUPPRESS_ETAG;
  res._contentLength = buf.byteLength;
  res._writer.writeFastBuffer(
    res._reqId,
    res.statusCode,
    ctCode,
    flags,
    res._wireHeaders(),
    buf
  );
  res._markFinished();
}

/** @internal */
export function sendBufferedString(res: RxResponse, body: string, ctCode: number): void {
  if (res._streaming) {
    res.end(body);
    return;
  }
  if (res.end !== RxResponse.prototype.end || res.write !== RxResponse.prototype.write) {
    materializeFastCt(res, ctCode);
    res.end(body);
    return;
  }
  writeBufferedSyncString(res, body, ctCode);
}

/** @internal */
function sendBufferedBuffer(res: RxResponse, buf: Uint8Array, ctCode: number): void {
  if (res._streaming) {
    res.end(buf);
    return;
  }
  if (res.end !== RxResponse.prototype.end || res.write !== RxResponse.prototype.write) {
    materializeFastCt(res, ctCode);
    res.end(buf);
    return;
  }
  writeBufferedSyncBuffer(res, buf, ctCode);
}

// ---- res.sendFile() ----
// Path checks run synchronously (before the first await) exactly as they always did, so a
// rejected path still reaches `next(err)` / the callback in the same tick.

function forbiddenError(): Error {
  return Object.assign(new Error('Forbidden'), {
    status: 403,
    statusCode: 403,
    code: 'EACCES',
  });
}

/** Reject a dotfile path segment unless `dotfiles: 'allow'` (403 for 'deny', 404 for 'ignore'). */
function rejectDotfileSegments(segs: string[], dotfiles: string): void {
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.length > 1 && seg.startsWith('.')) {
      const st = dotfiles === 'deny' ? 403 : 404;
      throw Object.assign(new Error(st === 403 ? 'Forbidden' : 'Not Found'), {
        status: st,
        statusCode: st,
        code: st === 403 ? 'EACCES' : 'ENOENT',
      });
    }
  }
}

/** `root` given: the lexical path under `absRoot` (throws on traversal and hidden dotfiles). */
function resolveUnderRoot(filePath: string, absRoot: string, dotfiles: string): string {
  const rel = filePath.replace(/^[\\/]+/, '');
  if (UP_PATH_REGEXP.test(rel) || rel === '..') {
    throw forbiddenError();
  }
  const normRel = normalize('.' + sep + rel);
  if (UP_PATH_REGEXP.test(normRel) || normRel === '..') {
    throw forbiddenError();
  }
  if (dotfiles !== 'allow') {
    rejectDotfileSegments(normRel.split(/[\\/]+/), dotfiles);
  }
  const resolved = resolve(absRoot, normRel);
  const rootPrefix = absRoot.endsWith(sep) ? absRoot : absRoot + sep;
  if (resolved !== absRoot && !resolved.startsWith(rootPrefix)) {
    throw forbiddenError();
  }
  return resolved;
}

/** After realpath: the target must still live under the (canonical) root, symlinks included. */
function checkRealPathInRoot(realFile: string, canonRoot: string, dotfiles: string): void {
  const canonPrefix = canonRoot.endsWith(sep) ? canonRoot : canonRoot + sep;
  if (realFile !== canonRoot && !realFile.startsWith(canonPrefix)) {
    throw forbiddenError();
  }
  if (dotfiles !== 'allow' && realFile !== canonRoot) {
    const relReal = realFile.slice(canonPrefix.length);
    rejectDotfileSegments(relReal.split(/[\\/]+/), dotfiles);
  }
}

/** Absolute path without `root`: throws on traversal and hidden dotfiles. */
function normalizeAbsolutePath(filePath: string, dotfiles: string): string {
  if (UP_PATH_REGEXP.test(filePath)) {
    throw forbiddenError();
  }
  const normPath = normalize(filePath);
  if (dotfiles !== 'allow') {
    rejectDotfileSegments(normPath.split(/[\\/]+/), dotfiles);
  }
  return normPath;
}

/** The engine's file-response metadata: `[opts u8][maxAge u32][pathLen u32][path][rootLen u32][root]`. */
function encodeFileMeta(
  optsBits: number,
  maxAgeSecs: number,
  pathForRust: string,
  absRoot: string | undefined
): Buffer {
  const pathBytes = Buffer.from(pathForRust, 'utf8');
  const rootBytes = absRoot !== undefined ? Buffer.from(absRoot, 'utf8') : null;
  const payloadLen = 9 + pathBytes.length + (rootBytes ? 4 + rootBytes.length : 0);
  const metaBuf = Buffer.allocUnsafe(payloadLen);
  let mp = 0;
  metaBuf[mp++] = optsBits;
  metaBuf.writeUInt32LE(maxAgeSecs >>> 0, mp);
  mp += 4;
  metaBuf.writeUInt32LE(pathBytes.length >>> 0, mp);
  mp += 4;
  pathBytes.copy(metaBuf, mp);
  mp += pathBytes.length;
  if (rootBytes) {
    metaBuf.writeUInt32LE(rootBytes.length >>> 0, mp);
    mp += 4;
    rootBytes.copy(metaBuf, mp);
  }
  return metaBuf;
}

/** @internal `res.sendFile()`: argument checks are synchronous, the file work is async. */
export function sendFile(
  res: RxResponse,
  filePath: string,
  optionsOrCb?: SendFileOptions | ((err?: Error) => void),
  maybeCb?: (err?: Error) => void
): void {
  const options: SendFileOptions =
    typeof optionsOrCb === 'object' && optionsOrCb !== null ? optionsOrCb : {};
  const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;

  if (res.headersSent || res.writableEnded) {
    const err = new Error('Cannot send file after headers are sent');
    (err as NodeJS.ErrnoException).code = 'ERR_HTTP_HEADERS_SENT';
    if (cb) cb(err);
    return;
  }

  if (!filePath || typeof filePath !== 'string') {
    const err = new TypeError('path argument is required to res.sendFile');
    if (cb) {
      cb(err);
      return;
    }
    throw err;
  }

  const dotfiles = options.dotfiles ?? 'ignore';
  if (dotfiles !== 'allow' && dotfiles !== 'deny' && dotfiles !== 'ignore') {
    const err = new TypeError('dotfiles option must be "allow", "deny", or "ignore"');
    if (cb) {
      cb(err);
      return;
    }
    throw err;
  }

  if (!options.root && !isAbsolute(filePath)) {
    const err = new TypeError('path must be absolute or specify root to res.sendFile');
    if (cb) {
      cb(err);
      return;
    }
    throw err;
  }

  void sendFileAsync(res, filePath, options, dotfiles, cb);
}

async function sendFileAsync(
  res: RxResponse,
  filePath: string,
  options: SendFileOptions,
  dotfiles: string,
  cb: ((err?: Error) => void) | undefined
): Promise<void> {
  let isDir = false;
  try {
    if (filePath.includes('\0') || (options.root && options.root.includes('\0'))) {
      throw Object.assign(new Error('Invalid null byte in path'), {
        status: 400,
        statusCode: 400,
      });
    }

    let canonFile: string;
    let absRoot: string | undefined;

    if (options.root) {
      absRoot = resolve(options.root);
      const resolved = resolveUnderRoot(filePath, absRoot, dotfiles);
      const [canonRoot, realFile] = await Promise.all([
        realpath(absRoot),
        realpath(resolved),
      ]);
      checkRealPathInRoot(realFile, canonRoot, dotfiles);
      canonFile = realFile;
    } else {
      canonFile = await realpath(normalizeAbsolutePath(filePath, dotfiles));
    }

    const st = await stat(canonFile);
    if (st.isDirectory()) {
      isDir = true;
      throw Object.assign(new Error('EISDIR, read'), {
        code: 'EISDIR',
        status: 404,
        statusCode: 404,
      });
    }
    if (!st.isFile()) {
      throw Object.assign(new Error('ENOENT: not a regular file'), {
        code: 'ENOENT',
        status: 404,
        statusCode: 404,
      });
    }

    const fh = await open(canonFile, 'r');
    await fh.close();

    if (res.headersSent || res.writableEnded) {
      if (cb) {
        cb(
          Object.assign(new Error('Request aborted'), {
            code: 'ECONNABORTED',
            status: 500,
            statusCode: 500,
          })
        );
      }
      return;
    }

    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        res.setHeader(k, v);
      }
    }

    const acceptRanges = options.acceptRanges !== false;
    const lastModified = options.lastModified !== false;
    const cacheControl = options.cacheControl !== false;
    const immutable = Boolean(options.immutable);
    const maxAgeSecs = cacheControl ? parseSendFileMaxAgeSecs(options.maxAge) : 0;
    const optEtag = (options as { etag?: boolean }).etag;
    const appEtag = res.app.get('etag');
    const enableEtag =
      optEtag !== false && !res._suppressEtag && appEtag !== false && appEtag !== 'off';

    const dotCode = dotfiles === 'allow' ? 1 : dotfiles === 'deny' ? 2 : 0;
    const hasRoot = absRoot !== undefined;
    let optsBits = 0;
    if (acceptRanges) optsBits |= 0x01;
    if (lastModified) optsBits |= 0x02;
    if (cacheControl) optsBits |= 0x04;
    if (immutable) optsBits |= 0x08;
    if (hasRoot) optsBits |= 0x10;
    optsBits |= (dotCode & 0x03) << 5;
    if (enableEtag) optsBits |= 0x80;

    const pathForRust = hasRoot ? filePath : canonFile;
    const metaBuf = encodeFileMeta(optsBits, maxAgeSecs, pathForRust, absRoot);

    res._triggerWriteHeadHook();
    let flags = RESP_FLAG_IS_FILE | RESP_FLAG_FILE_META;
    if (res._suppressXpb) flags |= RESP_FLAG_SUPPRESS_POWERED_BY;
    if (!enableEtag) flags |= RESP_FLAG_SUPPRESS_ETAG;

    res._writer.writeFastBuffer(
      res._reqId,
      res.statusCode,
      CT_CUSTOM,
      flags,
      res._wireHeaders(),
      metaBuf
    );
    res._writer.flush();
    res._markFinished();
    if (cb) cb();
  } catch (rawErr) {
    sendFileFailed(res, rawErr, isDir, cb);
  }
}

/** Map a sendFile failure to an HTTP status and hand it to the callback or `next()`. */
function sendFileFailed(
  res: RxResponse,
  rawErr: unknown,
  isDir: boolean,
  cb: ((err?: Error) => void) | undefined
): void {
  const errObj: Error & { code?: string; status?: number; statusCode?: number } =
    rawErr instanceof Error
      ? (rawErr as Error & { code?: string; status?: number; statusCode?: number })
      : Object.assign(new Error(String(rawErr)), { status: 500, statusCode: 500 });
  let status = errObj.status ?? errObj.statusCode;
  if (status === undefined) {
    if (
      errObj.code === 'ENOENT' ||
      errObj.code === 'ENOTDIR' ||
      errObj.code === 'ENAMETOOLONG'
    ) {
      status = 404;
    } else if (errObj.code === 'EACCES' || errObj.code === 'EPERM') {
      status = 403;
    } else {
      status = 500;
    }
    errObj.status = status;
    errObj.statusCode = status;
  }

  if (cb) {
    try {
      cb(errObj);
    } catch (cbThrown) {
      const reqNext = res.req.next;
      if (!res.writableEnded && !res.headersSent) {
        if (typeof reqNext === 'function') {
          reqNext(cbThrown);
        } else {
          res.status(500).type('text').send('Internal Server Error');
        }
      }
    }
    return;
  }

  const dispatchErr = () => {
    if (res.writableEnded || res.headersSent) return;
    const reqNext = res.req.next;
    if (typeof reqNext === 'function') {
      reqNext(isDir ? undefined : errObj);
      return;
    }
    res.status(status).type('text').send(STATUS_CODES[status] || 'Error');
  };

  const reqNextNow = res.req.next;
  if (typeof reqNextNow === 'function') {
    if (!res.writableEnded && !res.headersSent) {
      reqNextNow(isDir ? undefined : errObj);
    }
  } else {
    queueMicrotask(dispatchErr);
  }
}
