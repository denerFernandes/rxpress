import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CookieOptions } from '../types.js';

// ---- Cookie Signing & Validation (RFC 6265 / cookie-signature) ----

const COOKIE_NAME_REGEXP = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VAL_REGEXP =
  /^("?)[\u0021\u0023-\u002B\u002D-\u003A\u003C-\u005B\u005D-\u007E]*\1$/;
const DOMAIN_NAME_REGEXP =
  /^([.]?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const PATH_VALUE_REGEXP = /^[\u0020-\u003A\u003D-\u007E]*$/;

export function signCookieValue(val: string, secret: string): string {
  const sig = createHmac('sha256', secret)
    .update(val)
    .digest('base64')
    .replace(/=+$/, '');
  return `${val}.${sig}`;
}

export function unsignCookieValue(input: string, secrets: string | string[]): string | false {
  const dot = input.lastIndexOf('.');
  if (dot === -1) return false;
  const val = input.slice(0, dot);
  const mac = input.slice(dot + 1);
  const macBuf = Buffer.from(mac, 'utf8');
  const list = Array.isArray(secrets) ? secrets : [secrets];

  for (let i = 0; i < list.length; i++) {
    const expected = createHmac('sha256', list[i])
      .update(val)
      .digest('base64')
      .replace(/=+$/, '');
    const expBuf = Buffer.from(expected, 'utf8');
    if (expBuf.length === macBuf.length && timingSafeEqual(expBuf, macBuf)) {
      return val;
    }
  }
  return false;
}

export function serializeCookie(name: string, val: string, options: CookieOptions = {}): string {
  if (!COOKIE_NAME_REGEXP.test(name)) {
    throw new TypeError('argument name is invalid');
  }
  const encode = options.encode ?? encodeURIComponent;
  if (typeof encode !== 'function') {
    throw new TypeError('option encode is invalid');
  }
  const value = encode(val);
  if (value && !COOKIE_VAL_REGEXP.test(value)) {
    throw new TypeError('argument val is invalid');
  }

  let str = `${name}=${value}`;

  if (options.maxAge !== undefined) {
    const maxAge = Number(options.maxAge);
    if (!Number.isFinite(maxAge)) {
      throw new TypeError('option maxAge is invalid');
    }
    str += `; Max-Age=${Math.floor(maxAge / 1000)}`;
  }

  if (options.domain !== undefined) {
    if (!DOMAIN_NAME_REGEXP.test(options.domain)) {
      throw new TypeError('option domain is invalid');
    }
    str += `; Domain=${options.domain}`;
  }

  const path = options.path ?? '/';
  if (!PATH_VALUE_REGEXP.test(path)) {
    throw new TypeError('option path is invalid');
  }
  str += `; Path=${path}`;

  if (options.expires !== undefined) {
    if (!(options.expires instanceof Date) || Number.isNaN(options.expires.valueOf())) {
      throw new TypeError('option expires is invalid');
    }
    str += `; Expires=${options.expires.toUTCString()}`;
  }

  if (options.httpOnly) {
    str += '; HttpOnly';
  }
  if (options.secure) {
    str += '; Secure';
  }
  if (options.partitioned) {
    str += '; Partitioned';
  }

  if (options.priority !== undefined) {
    const prio = typeof options.priority === 'string' ? options.priority.toLowerCase() : '';
    switch (prio) {
      case 'low':
        str += '; Priority=Low';
        break;
      case 'medium':
        str += '; Priority=Medium';
        break;
      case 'high':
        str += '; Priority=High';
        break;
      default:
        throw new TypeError('option priority is invalid');
    }
  }

  if (options.sameSite !== undefined && options.sameSite !== false) {
    const ss =
      options.sameSite === true
        ? 'strict'
        : typeof options.sameSite === 'string'
          ? options.sameSite.toLowerCase()
          : '';
    switch (ss) {
      case 'lax':
        str += '; SameSite=Lax';
        break;
      case 'strict':
        str += '; SameSite=Strict';
        break;
      case 'none':
        str += '; SameSite=None';
        break;
      default:
        throw new TypeError('option sameSite is invalid');
    }
  }

  return str;
}

