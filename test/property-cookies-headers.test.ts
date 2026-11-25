// Property tests for cookie parsing and header-value validation.
//
// - `req.cookies` vs `cookie.parse` (the parser cookie-parser uses).
//   Intentional divergences, normalised away: rxpress drops the empty cookie name (`=v`) and the
//   `__proto__` / `constructor` / `prototype` names; containers have a null prototype.
// - `hasInvalidHeaderValue` / `validateHeaderValue` (js/security.ts, used by the protocol encoder)
//   vs `http.validateHeaderValue`.
import fc from 'fast-check';
import http from 'node:http';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { RxRequest } from '../js/request.js';
import { hasInvalidHeaderValue, validateHeaderValue } from '../js/security.js';
import { fcParams, plain, prototypeSnapshot, tokenString, UNSAFE_KEYS } from './helpers/property.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cookie = require('cookie') as { parse: (s: string) => Record<string, string> };

// The `cookies` getter only touches `this._cookies` and `this.get('cookie')`.
const cookiesGetter = Object.getOwnPropertyDescriptor(RxRequest.prototype, 'cookies')?.get;
function rxCookies(raw: string): Record<string, string> {
  if (!cookiesGetter) throw new Error('RxRequest.prototype.cookies getter not found');
  return cookiesGetter.call({ _cookies: null, get: () => raw }) as Record<string, string>;
}

function refCookies(raw: string): Record<string, string> {
  const out = { ...cookie.parse(raw) };
  delete out[''];
  for (const k of UNSAFE_KEYS) delete out[k];
  return out;
}

const COOKIE_TOKENS = [
  'a', 'b', 'k', 'sid', '=', '==', ';', '; ', ' ', '\t', '"', '""', '%', '%41', '%zz', '%E2%82%AC',
  '%E0', 'é', ',', '$', 'x=1', 'y="q"', 'j:{}', 's:abc.def', '+', '\\', '{', '}',
] as const;

describe('req.cookies vs cookie.parse', () => {
  it('deep-equals cookie.parse (minus the empty name)', () => {
    fc.assert(
      fc.property(tokenString(COOKIE_TOKENS, 30), (s) => {
        expect(plain(rxCookies(s))).toEqual(plain(refCookies(s)));
      }),
      fcParams(6000)
    );
  });

  it('deep-equals cookie.parse on arbitrary header-legal strings', () => {
    const headerChar = fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c));
    const legal = fc
      .array(fc.oneof(headerChar, fc.constantFrom('\t', '=', ';', '%', '"')), { maxLength: 60 })
      .map((a) => a.join(''));
    fc.assert(
      fc.property(legal, (s) => {
        expect(plain(rxCookies(s))).toEqual(plain(refCookies(s)));
      }),
      fcParams(4000)
    );
  });

  it('never throws, never exposes or pollutes prototype keys', () => {
    const before = prototypeSnapshot();
    const hostile = tokenString(
      [...COOKIE_TOKENS, '__proto__', 'constructor', 'prototype', '__proto__=1', 'toString=x', 'hasOwnProperty=1'],
      30
    );
    fc.assert(
      fc.property(hostile, (s) => {
        const out = rxCookies(s);
        for (const k of UNSAFE_KEYS) expect(Object.prototype.hasOwnProperty.call(out, k)).toBe(false);
        for (const v of Object.values(out)) expect(typeof v).toBe('string');
      }),
      fcParams(3000)
    );
    expect(prototypeSnapshot()).toEqual(before);
    expect(({} as Record<string, unknown>)['1']).toBeUndefined();
  });

  it('documented divergence: the empty cookie name is dropped (cookie.parse keeps it)', () => {
    expect(cookie.parse('=x; a=1')).toEqual({ '': 'x', a: '1' });
    expect(plain(rxCookies('=x; a=1'))).toEqual({ a: '1' });
  });
});

function nodeRejects(v: string): boolean {
  try {
    http.validateHeaderValue('x-test', v);
    return false;
  } catch {
    return true;
  }
}

describe('header-value validation vs http.validateHeaderValue', () => {
  it('agrees with Node for every Latin-1 character, alone and embedded', () => {
    const diffs: string[] = [];
    for (let c = 0; c <= 0xff; c++) {
      for (const v of [String.fromCharCode(c), 'a' + String.fromCharCode(c) + 'b']) {
        if (hasInvalidHeaderValue(v) !== nodeRejects(v)) diffs.push(c.toString(16));
      }
    }
    expect(diffs).toEqual([]);
  });

  it('agrees with Node on random Latin-1 strings, and validateHeaderValue throws ERR_INVALID_CHAR', () => {
    const latin1 = fc
      .array(fc.integer({ min: 0, max: 0xff }), { maxLength: 40 })
      .map((a) => String.fromCharCode(...a));
    fc.assert(
      fc.property(latin1, (v) => {
        const nodeBad = nodeRejects(v);
        expect(hasInvalidHeaderValue(v)).toBe(nodeBad);
        if (nodeBad) {
          expect(() => validateHeaderValue('x-test', v)).toThrow(
            expect.objectContaining({ code: 'ERR_INVALID_CHAR' })
          );
        } else {
          expect(validateHeaderValue('x-test', v)).toBe(v);
        }
      }),
      fcParams(5000)
    );
  });

  it('security property: anything carrying CR, LF or NUL is always rejected', () => {
    const any = fc.string({ unit: 'binary', maxLength: 40 });
    fc.assert(
      fc.property(any, fc.constantFrom('\r', '\n', '\0', '\r\n'), fc.nat(40), (s, bad, at) => {
        const i = Math.min(at, s.length);
        expect(hasInvalidHeaderValue(s.slice(0, i) + bad + s.slice(i))).toBe(true);
      }),
      fcParams(3000)
    );
  });

  // Regression: Node rejects any code unit above 0xFF (`/[^\t\x20-\x7e\x80-\xff]/`);
  // rxpress's `hasInvalidHeaderValue` (protocol encoder) used to accept them.
  //   value `€` (U+20AC)   expected: rejected (ERR_INVALID_CHAR)
  it('code units above 0xFF are rejected like Node', () => {
    for (const v of ['€', 'aĀb', '😀', ' ']) {
      expect(nodeRejects(v)).toBe(true);
      expect(hasInvalidHeaderValue(v)).toBe(true);
    }
  });
});
