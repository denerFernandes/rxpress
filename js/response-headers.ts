/*
 * Header API of `RxResponse`: the Express helpers (`set`, `append`, `type`, `vary`, `links`,
 * `location`, `redirect`, `cookie`, `attachment`...) and the Node `ServerResponse` header
 * methods (`setHeader`, `getHeader`, `getHeaders`, `hasHeader`, `removeHeader`). Plain functions
 * over the response; `RxResponse` keeps the methods as its own prototype members (so
 * `express.response` extension and the d.ts stay the same) and delegates here. The Express
 * helpers still go through `res.setHeader` / `res.getHeader` / `res.get`, so user overrides of
 * those methods keep applying.
 */
import { STATUS_CODES, validateHeaderName, validateHeaderValue } from 'node:http';
import { basename } from 'node:path';
import {
  CT_CUSTOM,
  CT_HTML,
  CT_JSON,
  CT_OCTET_STREAM,
  CT_TEXT_PLAIN,
} from './protocol.js';
import { normalizeMimeShorthand } from './request-parse.js';
import type { RxResponse } from './response.js';
import { fastCtToString, sendBufferedString, throwHeadersSent } from './response-send.js';
import {
  contentDisposition,
  encodeUrl,
  escapeHtmlText,
  serializeCookie,
  signCookieValue,
} from './security.js';
import type { CookieOptions } from './types.js';

type HeaderInput = Record<string, string | number | string[]>;

/** @internal `res.set()` / `res.header()`. */
export function setFields(res: RxResponse, field: string | HeaderInput, val?: string | number | string[]): void {
  if (typeof field === 'string') {
    if (val !== undefined) {
      if (Array.isArray(val) && field.toLowerCase() === 'content-type') {
        throw new TypeError('Content-Type cannot be set to an Array');
      }
      res.setHeader(field, val);
    }
  } else if (field && typeof field === 'object') {
    for (const k of Object.keys(field)) {
      res.setHeader(k, field[k]);
    }
  }
}

/** @internal `res.get()`. */
export function getField(res: RxResponse, field: string): string | undefined {
  const v = res.getHeader(field);
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(', ') : String(v);
}

/** @internal `res.append()`. */
export function appendField(res: RxResponse, field: string, val: string | string[]): RxResponse {
  const prev = res.getHeader(field);
  let value: string | string[] = val;
  if (prev !== undefined) {
    value = Array.isArray(prev)
      ? prev.concat(val)
      : Array.isArray(val)
        ? [String(prev)].concat(val)
        : [String(prev), val];
  }
  return res.set(field, value);
}

/** @internal `res.type()`: well-known types take the allocation-free fast content-type code. */
export function setType(res: RxResponse, type: string): void {
  if (res._headers === null && !res._streaming) {
    if (type === 'text/plain' || type === 'text' || type === 'txt') {
      res._fastCtCode = CT_TEXT_PLAIN;
      return;
    }
    if (type === 'application/json' || type === 'json') {
      res._fastCtCode = CT_JSON;
      return;
    }
    if (type === 'text/html' || type === 'html') {
      res._fastCtCode = CT_HTML;
      return;
    }
    if (type === 'application/octet-stream' || type === 'bin') {
      res._fastCtCode = CT_OCTET_STREAM;
      return;
    }
  }
  res._fastCtCode = CT_CUSTOM;
  const ct = normalizeMimeShorthand(type);
  const withCharset =
    ct.startsWith('text/') || ct === 'application/json' || ct === 'application/javascript'
      ? `${ct}; charset=utf-8`
      : ct;
  res.setHeader('content-type', withCharset);
}

/** @internal `res.vary()`. */
export function addVary(res: RxResponse, field: string): void {
  const prev = res.get('vary');
  if (!prev) {
    res.setHeader('vary', field);
    return;
  }
  if (prev === '*') return;
  const existing = prev.split(',').map((s) => s.trim().toLowerCase());
  if (!existing.includes(field.toLowerCase())) {
    res.setHeader('vary', `${prev}, ${field}`);
  }
}

/** @internal `res.links()`. */
export function setLinks(res: RxResponse, links: Record<string, string>): void {
  let link = res.get('link') || '';
  if (link) link += ', ';
  const entries = Object.keys(links).map((rel) => `<${links[rel]}>; rel="${rel}"`);
  res.setHeader('link', link + entries.join(', '));
}

/** @internal `res.location()`. */
export function setLocation(res: RxResponse, url: string): void {
  res.setHeader('location', encodeUrl(url));
}

/** @internal `res.redirect()`. */
export function redirect(res: RxResponse, statusOrUrl: number | string, maybeUrl?: string): void {
  if (res.headersSent || res.writableEnded) return;
  let status = 302;
  let url: string;
  if (typeof statusOrUrl === 'number') {
    status = statusOrUrl;
    url = maybeUrl ?? '/';
  } else {
    url = statusOrUrl;
  }
  // Express 5: the body names the *encoded* address and is negotiated (text / html / empty).
  res.location(url);
  const address = String(res.getHeader('location') ?? '');
  const message = STATUS_CODES[status] ?? String(status);
  res.vary('Accept');
  const matched = res.req.accepts(['text', 'html']);
  let body = '';
  if (matched === 'text') {
    body = `${message}. Redirecting to ${address}`;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
  } else if (matched === 'html') {
    const u = escapeHtmlText(address);
    body =
      `<!DOCTYPE html><head><title>${message}</title></head>` +
      `<body><p>${message}. Redirecting to ${u}</p></body>`;
    res.setHeader('content-type', 'text/html; charset=utf-8');
  }
  res.status(status);
  sendBufferedString(res, body, CT_CUSTOM);
}

/** @internal `res.cookie()`. */
export function setCookie(res: RxResponse, name: string, value: unknown, options: CookieOptions): RxResponse {
  const opts = { ...options };
  let val =
    typeof value === 'object' && value !== null
      ? 'j:' + JSON.stringify(value)
      : String(value);

  if (opts.signed) {
    const secret = res.req.secret ?? res.app.get('cookie secret');
    const signKey = Array.isArray(secret) ? secret[0] : secret;
    if (typeof signKey !== 'string' || signKey.length === 0) {
      throw new Error('cookieParser("secret") required for signed cookies');
    }
    val = 's:' + signCookieValue(val, signKey);
  }

  if (opts.maxAge !== undefined) {
    const maxAgeNum = Number(opts.maxAge);
    if (Number.isFinite(maxAgeNum) && !opts.expires) {
      opts.expires = new Date(Date.now() + maxAgeNum);
    }
  }

  const header = serializeCookie(name, val, opts);
  return res.append('set-cookie', header);
}

/** @internal `res.attachment()`. */
export function setAttachment(res: RxResponse, filename?: string): void {
  if (filename) {
    res.setHeader('content-disposition', contentDisposition(basename(filename)));
    const extIdx = filename.lastIndexOf('.');
    if (extIdx !== -1 && !res.hasHeader('content-type')) {
      res.type(filename.slice(extIdx));
    }
  } else {
    res.setHeader('content-disposition', 'attachment');
  }
}

/** @internal `res.setHeader()` (Node semantics, validated like `ServerResponse`). */
export function putHeader(res: RxResponse, name: string, value: string | number | readonly string[]): void {
  if (res.headersSent) {
    throwHeadersSent('set');
  }
  // Same synchronous errors as Node's ServerResponse (ERR_INVALID_HTTP_TOKEN / ERR_INVALID_CHAR /
  // ERR_HTTP_INVALID_HEADER_VALUE), so user try/catch works instead of a late opaque 500.
  validateHeaderName(name);
  if (typeof value === 'object' && value !== null) {
    for (let i = 0; i < value.length; i++) validateHeaderValue(name, value[i]);
  } else {
    validateHeaderValue(name, value as string); // Node also accepts numbers at runtime
  }
  const key = name.toLowerCase();
  if (res._headers === null) {
    res._headers = new Map();
  }
  if (key === 'content-type') {
    res._fastCtCode = CT_CUSTOM;
  }
  if (key === 'x-powered-by') {
    res._suppressXpb = false;
  }
  if (Array.isArray(value)) {
    res._headers.set(key, value.map(String));
  } else {
    res._headers.set(key, String(value));
  }
}

/** @internal `res.getHeader()`: also answers for the implicit (fast-path) headers. */
export function readHeader(res: RxResponse, name: string): string | string[] | undefined {
  const key = name.toLowerCase();
  if (res._headers !== null && res._headers.has(key)) {
    return res._headers.get(key);
  }
  if (key === 'content-type' && res._fastCtCode !== CT_CUSTOM) {
    return fastCtToString(res._fastCtCode);
  }
  if (key === 'content-length' && res.statusCode !== 204 && res.statusCode !== 304) {
    if (res._contentLength >= 0) {
      return String(res._contentLength);
    }
    if (res._lastBodyStr !== null) {
      res._contentLength = Buffer.byteLength(res._lastBodyStr, 'utf8');
      return String(res._contentLength);
    }
  }
  if (key === 'x-powered-by' && !res._suppressXpb && res.app._xPoweredBy) {
    return 'Express';
  }
  return undefined;
}

/** @internal `res.getHeaders()`. */
export function readHeaders(res: RxResponse): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  if (!res._suppressXpb && res.app._xPoweredBy) {
    out['x-powered-by'] = 'Express';
  }
  if (res._fastCtCode !== CT_CUSTOM) {
    const ct = fastCtToString(res._fastCtCode);
    if (ct) out['content-type'] = ct;
  }
  if (res._headers !== null) {
    for (const [k, v] of res._headers) {
      out[k] = v;
    }
  }
  if (
    out['content-length'] === undefined &&
    res.statusCode !== 204 &&
    res.statusCode !== 304 &&
    (res._contentLength >= 0 || res._lastBodyStr !== null)
  ) {
    if (res._contentLength < 0 && res._lastBodyStr !== null) {
      res._contentLength = Buffer.byteLength(res._lastBodyStr, 'utf8');
    }
    out['content-length'] = String(res._contentLength);
  }
  return out;
}

/** @internal `res.hasHeader()`. */
export function hasHeaderOf(res: RxResponse, name: string): boolean {
  const key = name.toLowerCase();
  if (res._headers !== null && res._headers.has(key)) return true;
  if (key === 'content-type' && res._fastCtCode !== CT_CUSTOM) return true;
  if (
    key === 'content-length' &&
    res.statusCode !== 204 &&
    res.statusCode !== 304 &&
    (res._contentLength >= 0 || res._lastBodyStr !== null)
  ) {
    return true;
  }
  if (key === 'x-powered-by' && !res._suppressXpb && res.app._xPoweredBy) {
    return true;
  }
  return false;
}

/** @internal `res.removeHeader()`. */
export function dropHeader(res: RxResponse, name: string): void {
  if (res.headersSent) {
    throwHeadersSent('remove');
  }
  const key = name.toLowerCase();
  if (key === 'x-powered-by') {
    res._suppressXpb = true;
  }
  if (key === 'content-type') {
    res._fastCtCode = CT_CUSTOM;
  }
  if (key === 'content-length') {
    res._contentLength = -1;
    res._lastBodyStr = null;
  }
  if (res._headers !== null) {
    res._headers.delete(key);
  }
}

/**
 * @internal
 * Node `writeHead` header semantics: raw `setHeader` (no Express Content-Type charset rewrite),
 * and a flat `[name, value, name, value]` array whose repeated names accumulate.
 */
export function applyWriteHeadHeaders(res: RxResponse, headers: HeaderInput | unknown[]): void {
  if (Array.isArray(headers)) {
    if (headers.length % 2 !== 0) {
      throw Object.assign(
        new TypeError(`The argument 'headers' is invalid. Received ${headers.length} items`),
        { code: 'ERR_INVALID_ARG_VALUE' }
      );
    }
    for (let i = 0; i < headers.length; i += 2) {
      const name = String(headers[i]);
      const value = headers[i + 1] as string | number | string[];
      const prev = res.getHeader(name);
      if (prev === undefined) {
        res.setHeader(name, value);
      } else {
        res.setHeader(name, ([] as (string | number)[]).concat(prev as string, value as string) as string[]);
      }
    }
    return;
  }
  for (const key of Object.keys(headers)) {
    if (key) res.setHeader(key, headers[key]);
  }
}
