/*
 * Lazy decoders behind the `RxRequest` getters (params, headers, rawHeaders, cookies,
 * signedCookies, ip/ips) and the `req.is()` / `req.accepts()` mime helpers. Plain functions so
 * the request class stays a thin, monomorphic shell over the shared batch Buffer.
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { RxRequest } from './request.js';
import { isUnsafeKey, parseQueryString, safeJsonParse, unsignCookieValue } from './security.js';

/** Headers whose duplicates Node drops (keeps the first): node:_http_incoming matchKnownFields. */
const DISCARD_DUP_HEADERS = new Set([
  'age',
  'authorization',
  'content-length',
  'content-type',
  'etag',
  'expires',
  'from',
  'host',
  'if-modified-since',
  'if-unmodified-since',
  'last-modified',
  'location',
  'max-forwards',
  'proxy-authorization',
  'referer',
  'retry-after',
  'server',
  'user-agent',
]);

/** @internal Route params from the engine's `[count u16][kLen u16][key][vLen u16][val]...` block. */
export function decodeParams(b: Buffer, start: number, len: number): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (len > 0) {
    let pos = start;
    const count = b.readUInt16LE(pos);
    pos += 2;
    for (let i = 0; i < count; i++) {
      const kLen = b.readUInt16LE(pos);
      pos += 2;
      const key = b.toString('utf8', pos, pos + kLen);
      pos += kLen;
      const vLen = b.readUInt16LE(pos);
      pos += 2;
      const val = b.toString('utf8', pos, pos + vLen);
      pos += vLen;
      if (!isUnsafeKey(key)) {
        out[key] = val;
      }
    }
  }
  return out;
}

/** @internal `req.headers`: Node IncomingMessage duplicate rules over the raw header block. */
export function decodeHeaders(buf: Buffer, start: number, len: number): IncomingHttpHeaders {
  const out = Object.create(null) as IncomingHttpHeaders;
  if (len > 0) {
    const raw = buf.toString('latin1', start, start + len);
    let lineStart = 0;
    const rawLen = raw.length;
    while (lineStart < rawLen) {
      let lineEnd = raw.indexOf('\r\n', lineStart);
      if (lineEnd === -1) lineEnd = rawLen;
      if (lineEnd > lineStart) {
        const colon = raw.indexOf(':', lineStart);
        if (colon !== -1 && colon < lineEnd) {
          const key = raw.slice(lineStart, colon).trim().toLowerCase();
          if (!isUnsafeKey(key)) {
            let vStart = colon + 1;
            while (
              vStart < lineEnd &&
              (raw.charCodeAt(vStart) === 32 || raw.charCodeAt(vStart) === 9)
            ) {
              vStart++;
            }
            const val = raw.slice(vStart, lineEnd);
            const existing = out[key];
            if (existing === undefined) {
              out[key] = key === 'set-cookie' ? [val] : val;
            } else if (key === 'set-cookie') {
              (existing as string[]).push(val);
            } else if (key === 'cookie') {
              out[key] = `${existing}; ${val}`;
            } else if (DISCARD_DUP_HEADERS.has(key)) {
              // Node's IncomingMessage keeps the first value of these.
            } else {
              out[key] = `${existing}, ${val}`;
            }
          }
        }
      }
      lineStart = lineEnd + 2;
    }
  }
  return out;
}

/** @internal `req.rawHeaders`: flat `[name, value, ...]` in wire order. */
export function decodeRawHeaders(buf: Buffer, start: number, len: number): string[] {
  const arr: string[] = [];
  if (len > 0) {
    const raw = buf.toString('latin1', start, start + len);
    let lineStart = 0;
    const rawLen = raw.length;
    while (lineStart < rawLen) {
      let lineEnd = raw.indexOf('\r\n', lineStart);
      if (lineEnd === -1) lineEnd = rawLen;
      if (lineEnd > lineStart) {
        const colon = raw.indexOf(':', lineStart);
        if (colon !== -1 && colon < lineEnd) {
          arr.push(raw.slice(lineStart, colon).trim());
          arr.push(raw.slice(colon + 1, lineEnd).trim());
        }
      }
      lineStart = lineEnd + 2;
    }
  }
  return arr;
}

/** @internal `req.cookies` from the Cookie header (first occurrence of a name wins). */
export function parseCookieHeader(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (raw) {
    const parts = raw.split(';');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const k = part.slice(0, eq).trim();
      if (!k || isUnsafeKey(k) || Object.hasOwn(out, k)) continue;
      let v = part.slice(eq + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) {
        v = v.slice(1, -1);
      }
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

/**
 * @internal `req.signedCookies`: the `s:`-prefixed cookies that verify against `secrets`
 * (`false` when the signature is wrong), with `j:` JSON cookies decoded.
 */
export function decodeSignedCookies(
  cookies: Record<string, string> | null,
  secrets: string | string[] | null
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  if (secrets && cookies) {
    for (const k of Object.keys(cookies)) {
      if (isUnsafeKey(k)) continue;
      const v = cookies[k];
      if (typeof v === 'string' && v.startsWith('s:')) {
        const dec = unsignCookieValue(v.slice(2), secrets);
        if (dec === false) {
          out[k] = false;
        } else if (dec.startsWith('j:')) {
          try {
            out[k] = safeJsonParse(dec.slice(2), { strict: false });
          } catch {
            out[k] = dec;
          }
        } else {
          out[k] = dec;
        }
      }
    }
  }
  return out;
}

/** @internal `req.ip` / `req.ips` under the app's `trust proxy` setting. */
export function resolveTrustedProxy(req: RxRequest): {
  clientIp: string;
  ips: string[];
  firstHopTrusted: boolean;
} {
  const peerIp = req._getRemoteAddr();
  const trustFn = req.app._trustProxyFn;
  if (!trustFn) {
    return { clientIp: peerIp, ips: [], firstHopTrusted: false };
  }
  const firstHopTrusted = trustFn(peerIp, 0);
  if (!firstHopTrusted) {
    return { clientIp: peerIp, ips: [], firstHopTrusted: false };
  }
  const xff = req.get('x-forwarded-for');
  if (!xff) {
    return { clientIp: peerIp, ips: [], firstHopTrusted: true };
  }
  const xffParts = xff.split(',').map((s) => s.trim()).filter(Boolean);
  if (xffParts.length === 0) {
    return { clientIp: peerIp, ips: [], firstHopTrusted: true };
  }

  // Closest-to-server order: [peerIp, rightmostXff, ..., leftmostXff]
  const addrs = [peerIp];
  for (let i = xffParts.length - 1; i >= 0; i--) {
    addrs.push(xffParts[i]);
  }
  let idx = 0;
  while (idx < addrs.length - 1 && trustFn(addrs[idx], idx)) {
    idx++;
  }
  const clientIp = addrs[idx];
  const ips: string[] = [];
  for (let i = idx; i >= 1; i--) {
    ips.push(addrs[i]);
  }
  return { clientIp, ips, firstHopTrusted: true };
}

/** @internal Bare `type/subtype` token check used by `req.is()`. */
export const MIME_RE = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/;

/** @internal */
export function normalizeIsType(type: string): string {
  const lc = type.toLowerCase().trim();
  if (lc === 'urlencoded') return 'application/x-www-form-urlencoded';
  if (lc === 'multipart') return 'multipart/*';
  if (lc[0] === '+') return `*/*${lc}`;
  return normalizeMimeShorthand(lc);
}

/** `type-is` mimeMatch: `*` wildcards per part and `*+suffix` subtype patterns. */
export function mimeMatch(expected: string, actual: string): boolean {
  const e = expected.split('/');
  const a = actual.split('/');
  if (e.length !== 2 || a.length !== 2) return false;
  if (e[0] !== '*' && e[0] !== a[0]) return false;
  if (e[1].startsWith('*+')) {
    return e[1].length <= a[1].length + 1 && e[1].slice(1) === a[1].slice(1 - e[1].length);
  }
  return e[1] === '*' || e[1] === a[1];
}

export function normalizeMimeShorthand(type: string): string {
  const lc = type.toLowerCase().trim();
  if (lc.includes('/')) return lc;
  switch (lc) {
    case 'html':
    case '.html':
      return 'text/html';
    case 'text':
    case 'txt':
    case '.txt':
      return 'text/plain';
    case 'json':
    case '.json':
      return 'application/json';
    case 'xml':
    case '.xml':
      return 'application/xml';
    case 'js':
    case '.js':
      return 'application/javascript';
    case 'css':
    case '.css':
      return 'text/css';
    case 'bin':
    case 'octet-stream':
      return 'application/octet-stream';
    case 'png':
    case '.png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
    case '.jpg':
      return 'image/jpeg';
    case 'svg':
    case '.svg':
      return 'image/svg+xml';
    case 'pdf':
    case '.pdf':
      return 'application/pdf';
    default:
      return `application/${lc}`;
  }
}

/** @internal `req.query`: the app's query parser (`query parser` setting) over the raw query string. */
export function parseRequestQuery(req: RxRequest): Record<string, unknown> {
  const urlLen = req._urlEnd - req._urlStart;
  const customParser = req.app._queryParserFn;
  if (req._pathLen >= urlLen) {
    return customParser ? customParser('') : (Object.create(null) as Record<string, unknown>);
  }
  const qs = req._buf.toString('utf8', req._urlStart + req._pathLen + 1, req._urlEnd);
  if (customParser !== undefined) {
    return customParser(qs);
  }
  if (req.app._queryParserMode === false) {
    return Object.create(null) as Record<string, unknown>;
  }
  return parseQueryString(qs, {
    mode: req.app._queryParserMode,
    parameterLimit: 1000,
    maxDepth: 5,
  });
}

/** @internal `req.signedCookies`: unsigns `req.cookies` with `req.secret` / `cookie secret`. */
export function resolveSignedCookies(req: RxRequest): Record<string, unknown> {
  const rawSecret = req.secret ?? req.app.get('cookie secret');
  const secrets =
    typeof rawSecret === 'string'
      ? rawSecret
      : Array.isArray(rawSecret) && rawSecret.length > 0
        ? (rawSecret as string[])
        : null;
  return decodeSignedCookies(secrets ? req.cookies : null, secrets);
}
