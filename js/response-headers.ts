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
import { basename, extname } from 'node:path';
import {
  CT_CUSTOM,
  CT_HTML,
  CT_JSON,
  CT_OCTET_STREAM,
  CT_TEXT_PLAIN,
} from './protocol.js';
import { loadNativeAddon } from './native.js';
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

/** Charsets mime-db declares outside `text/*` (which defaults to UTF-8 in `mime-types`). */
const MIME_CHARSETS: Record<string, string> = {
  'application/javascript': 'utf-8',
  'application/json': 'utf-8',
  'application/manifest+json': 'utf-8',
  'application/elm+json': 'utf-8',
  'application/fhir+json': 'utf-8',
  'application/fhir+xml': 'utf-8',
  'application/3gpdash-qoe-report+xml': 'utf-8',
  'application/beep+xml': 'utf-8',
  'application/cda+xml': 'utf-8',
  'application/emergencycalldata.cap+xml': 'utf-8',
  'application/hl7v2+xml': 'utf-8',
  'application/im-iscomposing+xml': 'utf-8',
  'application/msc-ivr+xml': 'utf-8',
  'application/msc-mixer+xml': 'utf-8',
  'application/pidf+xml': 'utf-8',
  'application/pidf-diff+xml': 'utf-8',
  'application/poc-settings+xml': 'utf-8',
  'application/vnd.omads-email+xml': 'utf-8',
  'application/vnd.omads-file+xml': 'utf-8',
  'application/vnd.omads-folder+xml': 'utf-8',
  'application/vnd.syncml+xml': 'utf-8',
  'application/vnd.syncml.dm+wbxml': 'utf-8',
  'application/vnd.syncml.dm+xml': 'utf-8',
  'application/vnd.syncml.dmddf+xml': 'utf-8',
  'application/vnd.syncml.dmtnds+xml': 'utf-8',
  'application/vnd.wap.wbxml': 'utf-8',
  'application/news-checkgroups': 'us-ascii',
  'application/news-groupinfo': 'us-ascii',
  'application/prs.cyn': '7-bit',
  'application/vnd.fdsn.stationxml+xml': 'xml-based',
};

/** `mime-types` `contentType()` for a full type: append the default charset when missing. */
function withDefaultCharset(value: string): string {
  if (value.indexOf('charset') !== -1) return value;
  const semi = value.indexOf(';');
  const base = (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase();
  const charset = MIME_CHARSETS[base] ?? (base.startsWith('text/') ? 'utf-8' : undefined);
  return charset ? `${value}; charset=${charset}` : value;
}

const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Express `utils.setCharset` (content-type parse + format): lower-cased type, parameters kept in
 * order with lower-cased names, malformed parameters dropped, `charset` replaced or appended.
 * @internal
 */
export function setCharset(type: string, charset: string): string {
  if (!type || !charset) return type;
  const parts = type.split(';');
  const base = parts[0].trim().toLowerCase();
  const params: Array<[string, string]> = [];
  let replaced = false;
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq === -1) continue;
    const key = parts[i].slice(0, eq).trim().toLowerCase();
    let val = parts[i].slice(eq + 1).trim();
    if (!TOKEN_RE.test(key)) continue;
    if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
      val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    if (key === 'charset') {
      if (replaced) continue;
      val = charset;
      replaced = true;
    }
    params.push([key, val]);
  }
  if (!replaced) params.push(['charset', charset]);
  let out = base;
  for (const [k, v] of params) {
    out += `; ${k}=${TOKEN_RE.test(v) ? v : `"${v.replace(/(["\\])/g, '\\$1')}"`}`;
  }
  return out;
}

/**
 * Express `res.set('Content-Type', v)`: `mime.contentType(v)`. An unknown extension yields
 * `false` there, which Node then sends as the string "false".
 */
function expressContentType(value: string): string {
  if (value.indexOf('/') === -1) {
    const ext = extname('x.' + value).toLowerCase().slice(1);
    return (ext && loadNativeAddon().mimeContentType(ext)) || 'false';
  }
  return withDefaultCharset(value);
}

/** @internal `res.set()` / `res.header()`. */
export function setFields(res: RxResponse, field: string | HeaderInput, val?: string | number | string[]): void {
  if (typeof field === 'string') {
    if (val !== undefined) {
      if (field.toLowerCase() === 'content-type') {
        if (Array.isArray(val)) throw new TypeError('Content-Type cannot be set to an Array');
        res.setHeader(field, expressContentType(String(val)));
        return;
      }
      res.setHeader(field, Array.isArray(val) ? val.map(String) : String(val));
    }
  } else if (field && typeof field === 'object') {
    for (const k of Object.keys(field)) {
      setFields(res, k, field[k]);
    }
  }
}

/** @internal `res.get()`. */
export function getField(res: RxResponse, field: string): string | string[] | undefined {
  // Express: `res.get()` is `res.getHeader()` (arrays stay arrays).
  return res.getHeader(field);
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
  res.setHeader('content-type', withDefaultCharset(expressTypeLookup(type)));
}

/**
 * Express `res.type()`: a value with `/` is used as is, anything else is a file name or
 * extension looked up like `mime-types.contentType()`, falling back to octet-stream.
 */
function expressTypeLookup(type: string): string {
  if (type.indexOf('/') !== -1) return type;
  const ext = extname('x.' + type).toLowerCase().slice(1);
  return (ext && loadNativeAddon().mimeContentType(ext)) || 'application/octet-stream';
}

const VARY_FIELD_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** `vary` package `parse`: comma-separated list, surrounding spaces dropped. */
function parseVaryList(header: string): string[] {
  const list: string[] = [];
  for (const part of header.split(',')) {
    const v = part.trim();
    if (v) list.push(v);
  }
  return list;
}

/** @internal `res.vary()`: the `vary` package. */
export function addVary(res: RxResponse, field: string | string[]): void {
  if (!field) throw new TypeError('field argument is required');
  const fields = Array.isArray(field) ? field : parseVaryList(String(field));
  for (const f of fields) {
    if (!VARY_FIELD_RE.test(f)) throw new TypeError('field argument contains an invalid header name');
  }
  const prev = res.getHeader('vary') ?? '';
  const header = Array.isArray(prev) ? prev.join(', ') : String(prev);
  if (header === '*') return;
  let val = header;
  const vals = parseVaryList(header.toLowerCase());
  if (fields.includes('*') || vals.includes('*')) {
    res.setHeader('vary', '*');
    return;
  }
  for (const f of fields) {
    const lower = f.toLowerCase();
    if (!vals.includes(lower)) {
      vals.push(lower);
      val = val ? `${val}, ${f}` : f;
    }
  }
  if (val) res.setHeader('vary', val);
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

/** @internal `res.attachment()`: same steps as Express 5. */
export function setAttachment(res: RxResponse, filename?: string): void {
  const name = filename !== undefined ? basename(filename) : undefined;
  if (name) res.type(extname(name));
  res.setHeader('content-disposition', contentDisposition(name));
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
