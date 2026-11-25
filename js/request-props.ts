/*
 * Express request properties derived from headers / the proxy chain (`protocol`, `host`,
 * `fresh`, `is()`, `accepts()`...). Plain functions over the request; `RxRequest` keeps the
 * getters / methods as its own prototype members (so `express.request` extension and the d.ts
 * stay the same) and delegates here. Nothing is allocated unless a property is read.
 */
import { isIP } from 'node:net';
import type { RxRequest } from './request.js';
import {
  MIME_RE,
  mimeMatch,
  normalizeIsType,
  normalizeMimeShorthand,
  resolveTrustedProxy,
} from './request-parse.js';
import {
  checkFreshness,
  listAcceptedMediaTypes,
  negotiateAccept,
  negotiateSimpleTokens,
} from './security.js';

/** @internal `req.protocol`: honours `X-Forwarded-Proto` from a trusted proxy. */
export function protocolOf(req: RxRequest): string {
  const sock = req._peekSocket();
  const proto = (sock !== null ? sock.encrypted : req._isTls) ? 'https' : 'http';
  const trustFn = req.app._trustProxyFn;
  if (trustFn && trustFn(req._getRemoteAddr(), 0)) {
    const fwd = req.get('x-forwarded-proto');
    if (fwd) {
      return fwd.split(',')[0].trim().toLowerCase();
    }
  }
  return proto;
}

/** @internal */
export function clientIpOf(req: RxRequest): string {
  return resolveTrustedProxy(req).clientIp;
}

/** @internal */
export function ipsOf(req: RxRequest): string[] {
  return resolveTrustedProxy(req).ips;
}

/** @internal `req.host`: honours `X-Forwarded-Host` from a trusted proxy. */
export function hostOf(req: RxRequest): string | undefined {
  const trustFn = req.app._trustProxyFn;
  let host =
    trustFn && trustFn(req._getRemoteAddr(), 0) ? req.get('x-forwarded-host') : undefined;
  if (!host) {
    host = req.get('host');
  }
  if (!host) return undefined;
  const comma = host.indexOf(',');
  return comma !== -1 ? host.slice(0, comma).trim() : host.trim();
}

/** @internal */
export function hostnameOf(req: RxRequest): string | undefined {
  const host = req.host;
  if (!host) return undefined;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end !== -1 ? host.slice(0, end + 1) : host;
  }
  const colon = host.indexOf(':');
  return colon !== -1 ? host.slice(0, colon) : host;
}

/** @internal */
export function subdomainsOf(req: RxRequest): string[] {
  const hostname = req.hostname;
  if (!hostname) return [];
  const offset = Number(req.app.get('subdomain offset') ?? 2);
  const parts = isIP(hostname) ? [hostname] : hostname.split('.').reverse();
  return parts.slice(offset);
}

/** @internal */
export function isXhr(req: RxRequest): boolean {
  const val = req.get('x-requested-with') || '';
  return val.toLowerCase() === 'xmlhttprequest';
}

/** @internal */
function headerString(v: string | number | string[] | undefined): string | undefined {
  return v === undefined ? undefined : Array.isArray(v) ? v.join(', ') : String(v);
}

export function isFresh(req: RxRequest): boolean {
  const m = req.method;
  if (m !== 'GET' && m !== 'HEAD' && m !== 'QUERY') return false;
  const s = req.res.statusCode;
  if (!((s >= 200 && s < 300) || s === 304)) return false;
  return checkFreshness(
    req.get('cache-control'),
    req.get('if-none-match'),
    req.get('if-modified-since'),
    headerString(req.res.getHeader('etag')),
    headerString(req.res.getHeader('last-modified'))
  );
}

/**
 * Express `req.is()` with `type-is` semantics: `null` when the request has no body,
 * `false` when it has no/invalid `Content-Type` or nothing matches, the bare mime type
 * when called without arguments.
 * @internal
 */
export function isType(req: RxRequest, types: Array<string | string[]>): string | false | null {
  const h = req.headers;
  if (
    h['transfer-encoding'] === undefined &&
    (h['content-length'] === undefined || Number.isNaN(Number(h['content-length'])))
  ) {
    return null;
  }
  const ct = req.get('content-type');
  if (!ct) return false;
  const mime = ct.split(';')[0].trim().toLowerCase();
  if (!MIME_RE.test(mime)) return false;
  const flat: string[] = [];
  for (const t of types) {
    if (Array.isArray(t)) flat.push(...t);
    else flat.push(t);
  }
  if (flat.length === 0) return mime;
  for (const pattern of flat) {
    if (typeof pattern !== 'string') continue;
    if (mimeMatch(normalizeIsType(pattern), mime)) {
      return pattern[0] === '+' || pattern.includes('*') ? mime : pattern;
    }
  }
  return false;
}

/** @internal */
export function acceptsTypes(
  req: RxRequest,
  types: Array<string | string[]>
): string | string[] | false {
  const accept = req.get('accept') || '*/*';
  const flat: string[] = [];
  for (const t of types) {
    if (Array.isArray(t)) flat.push(...t);
    else flat.push(t);
  }
  if (flat.length === 0) {
    return listAcceptedMediaTypes(accept);
  }
  return negotiateAccept(accept, flat, normalizeMimeShorthand);
}

/** @internal */
export function acceptsEncodingList(req: RxRequest, encodings: string[]): string | string[] | false {
  const hdr = req.get('accept-encoding') || 'identity';
  return negotiateSimpleTokens(hdr, encodings, false);
}

/** @internal */
export function acceptsCharsetList(req: RxRequest, charsets: string[]): string | string[] | false {
  const hdr = req.get('accept-charset') || '*';
  return negotiateSimpleTokens(hdr, charsets, false);
}

/** @internal */
export function acceptsLanguageList(req: RxRequest, langs: string[]): string | string[] | false {
  const hdr = req.get('accept-language') || '*';
  return negotiateSimpleTokens(hdr, langs, true);
}
