import { unescape as qsUnescape } from 'node:querystring';
import { qsParse } from '../qs.js';
import { createHttpError } from './errors.js';

// ---- Prototype Pollution Guards ----

export function isUnsafeKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/**
 * body-parser's JSON parse failure: the native `SyntaxError` itself, decorated by http-errors
 * (`createError(400, err, { body, type })`). NestJS maps exactly this shape to a 400.
 */
function jsonSyntaxError(err: unknown, body: string): SyntaxError {
  const e = (err instanceof SyntaxError ? err : new SyntaxError(String((err as Error)?.message ?? err))) as SyntaxError &
    Record<string, unknown>;
  e.status = 400;
  e.statusCode = 400;
  e.expose = true;
  e.body = body;
  e.type = 'entity.parse.failed';
  return e;
}

/** body-parser `createStrictSyntaxError`: the error JSON.parse gives at the offending char. */
function strictSyntaxError(str: string, char: string): SyntaxError {
  const index = str.indexOf(char);
  const partial = index !== -1 ? str.substring(0, index) + '#'.repeat(str.length - index) : '';
  try {
    JSON.parse(partial);
    return new SyntaxError('strict violation');
  } catch (e) {
    const err = e as SyntaxError;
    err.message = err.message.replace(/#+/g, (ph) => str.substring(index, index + ph.length));
    return err;
  }
}

// ---- Query String & Form Body Parsing ----

export interface ParseQueryOptions {
  mode?: 'extended' | 'simple' | false;
  parameterLimit?: number;
  maxDepth?: number;
  /** qs `arrayLimit` (extended mode): 20 for queries (Express), max(100, params) for bodies. */
  arrayLimit?: number;
  /** qs `strictDepth` (extended mode): throw a RangeError past `maxDepth` (body-parser). */
  strictDepth?: boolean;
}

export function fastDecodeQuery(s: string): string {
  if (s.indexOf('%') === -1 && s.indexOf('+') === -1) return s;
  const replaced = s.indexOf('+') !== -1 ? s.replace(/\+/g, ' ') : s;
  try {
    return decodeURIComponent(replaced);
  } catch {
    return replaced;
  }
}

/**
 * `querystring.parse`'s decoding ('simple' mode): like `fastDecodeQuery`, but a malformed escape
 * falls back to byte-wise `querystring.unescape` (valid `%XX` decoded, bad UTF-8 -> U+FFFD)
 * instead of keeping the raw text.
 */
function simpleDecodeQuery(s: string): string {
  if (s.indexOf('%') === -1 && s.indexOf('+') === -1) return s;
  const replaced = s.indexOf('+') !== -1 ? s.replace(/\+/g, ' ') : s;
  try {
    return decodeURIComponent(replaced);
  } catch {
    // querystring.parse only decodes a key / value holding a valid `%XX`, so one with nothing
    // but malformed escapes stays raw (`+` is still a space).
    return /%[0-9a-fA-F]{2}/.test(s) ? qsUnescape(replaced) : replaced;
  }
}

export function parseQueryString(
  qs: string,
  options?: ParseQueryOptions
): Record<string, unknown> {
  const mode = options?.mode ?? 'extended';
  const extended = mode === 'extended';
  // Express 5: qs ('extended') returns an ordinary object; querystring ('simple') and a disabled
  // parser return a prototype-free one.
  const result: Record<string, unknown> = extended ? {} : Object.create(null);
  if (!qs || mode === false) return result;

  const parameterLimit = options?.parameterLimit ?? 1000;
  const maxDepth = options?.maxDepth ?? 5;
  const arrayLimit = options?.arrayLimit ?? 20;
  const qsOpts = { depth: maxDepth, arrayLimit, parameterLimit, strictDepth: options?.strictDepth };
  // Bracket syntax needs the full qs algorithm (arrays, merging, overflow); flat queries keep the
  // fast path below, which yields the same result for them. qs rewrites `%5B` / `%5D` before
  // splitting on `]=`, so a lone `]` / `%5D` needs the full parser too.
  if (extended && (qs.indexOf('[') !== -1 || qs.indexOf(']') !== -1 || /%5[bBdD]/.test(qs))) {
    return qsParse(qs, qsOpts);
  }
  const decode = extended ? fastDecodeQuery : simpleDecodeQuery;

  let count = 0;
  let start = 0;
  const len = qs.length;

  while (start < len) {
    let amp = qs.indexOf('&', start);
    if (amp === -1) amp = len;
    if (amp > start) {
      if (count >= parameterLimit) break;
      count++;

      const eq = qs.indexOf('=', start);
      let rawKey: string;
      let rawVal: string;
      if (eq !== -1 && eq < amp) {
        rawKey = qs.slice(start, eq);
        rawVal = qs.slice(eq + 1, amp);
      } else {
        rawKey = qs.slice(start, amp);
        rawVal = '';
      }

      const key = decode(rawKey);
      // qs never assigns `__proto__` and drops empty keys; querystring keeps every key as data.
      if (extended && (key === '' || key === '__proto__')) {
        start = amp + 1;
        continue;
      }
      const val = decode(rawVal);

      const existing = result[key];
      if (existing === undefined) {
        result[key] = val;
      } else if (Array.isArray(existing)) {
        // qs turns an array past `arrayLimit` into an index-keyed object.
        if (extended && existing.length >= arrayLimit) return qsParse(qs, qsOpts);
        existing.push(val);
      } else {
        result[key] = [existing, val];
      }
    }
    start = amp + 1;
  }

  return result;
}

/**
 * body-parser 2 `urlencoded` parsing: both modes use qs with `arrayLimit` (max(100, params) when
 * extended, params otherwise), `depth` (32 / 0) and `strictDepth`, so an over-deep extended key
 * is a 400, not a silently flattened key. `depth: 0` still strips one wrapping bracket pair,
 * rewrites `%5B` / `%5D` and drops empty keys.
 */
export function parseUrlencodedBody(
  str: string,
  extended: boolean,
  parameterLimit: number,
  paramCount: number
): Record<string, unknown> {
  try {
    return parseQueryString(str, {
      mode: 'extended',
      parameterLimit,
      maxDepth: extended ? 32 : 0,
      arrayLimit: extended ? Math.max(100, paramCount) : paramCount,
      strictDepth: true,
    });
  } catch (err) {
    if (err instanceof RangeError) {
      throw createHttpError(400, 'The input exceeded the depth', 'querystring.parse.rangeError');
    }
    throw err;
  }
}

export function countFormParameters(body: string, limit: number): number | undefined {
  if (body.length === 0) return 0;
  let count = 1;
  let pos = 0;
  while ((pos = body.indexOf('&', pos)) !== -1) {
    count++;
    if (count > limit) return undefined;
    pos++;
  }
  return count;
}

// ---- Hardened JSON Parsing ----

export function safeJsonParse(
  str: string,
  options?: { strict?: boolean; reviver?: (key: string, value: unknown) => unknown }
): unknown {
  const trimmed = str.trim();
  if (trimmed.length === 0) {
    return {};
  }

  const strict = options?.strict !== false;
  if (strict) {
    const ch = trimmed.charCodeAt(0);
    if (ch !== 0x7b && ch !== 0x5b) {
      throw jsonSyntaxError(strictSyntaxError(str, trimmed[0]), str);
    }
  }

  // Plain JSON.parse, as body-parser does: a `__proto__` key becomes an own data property and
  // never touches Object.prototype.
  try {
    return JSON.parse(str, options?.reviver);
  } catch (err) {
    throw jsonSyntaxError(err, str);
  }
}

