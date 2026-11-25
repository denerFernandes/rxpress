// Property tests for query-string and urlencoded-body parsing.
//
// References, configured exactly like Express 5 / body-parser 2:
// - query parser 'extended' -> `qs.parse(str, { allowPrototypes: true })`  (express/lib/utils.js)
// - query parser 'simple'   -> `querystring.parse(str)`                    (express/lib/utils.js)
// - urlencoded body         -> `qs.parse(body, { allowPrototypes, arrayLimit: extended ? max(100, n) : n,
//                              depth: extended ? 32 : 0, parameterLimit, strictDepth: true })`
//                              (body-parser/lib/types/urlencoded.js; used for BOTH extended modes)
//
// Intentional divergences that are normalised away before comparing:
// - rxpress containers have a null prototype (compared through JSON).
// - rxpress drops `__proto__` / `constructor` / `prototype` keys entirely; the deep-equality
//   properties never generate them, the invariant properties do.
import fc from 'fast-check';
import { createRequire } from 'node:module';
import querystring from 'node:querystring';
import { describe, expect, it } from 'vitest';
import { qsParse } from '../js/qs.js';
import { countFormParameters, parseQueryString, parseUrlencodedBody } from '../js/security.js';
import {
  fcParams,
  hasProtoKeyOnOrdinaryObject,
  plain,
  protoShape,
  prototypeSnapshot,
  QS_TOKENS,
  QS_TOKENS_HOSTILE,
  tokenString,
} from './helpers/property.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const qs = require('qs') as { parse: (s: string, o?: Record<string, unknown>) => unknown };

const rxQuery = (s: string, mode: 'extended' | 'simple') =>
  parseQueryString(s, { mode, parameterLimit: 1000, maxDepth: 5 });

const expressExtended = (s: string) => qs.parse(s, { allowPrototypes: true });
const expressSimple = (s: string) => querystring.parse(s) as Record<string, unknown>;

function rxBody(s: string, extended: boolean): unknown {
  const n = countFormParameters(s, 1000);
  // The urlencoded middleware answers 413 before parsing (body-parser does the same).
  if (n === undefined) throw Object.assign(new Error('too many parameters'), { status: 413 });
  return parseUrlencodedBody(s, extended, 1000, n);
}

function bodyParserBody(s: string, extended: boolean): unknown {
  if (!s.length) return {};
  const n = countFormParameters(s, 1000) as number;
  return qs.parse(s, {
    allowPrototypes: true,
    arrayLimit: extended ? Math.max(100, n) : n,
    depth: extended ? 32 : 0,
    parameterLimit: 1000,
    strictDepth: true,
    charset: 'utf-8',
  });
}

const benign = tokenString(QS_TOKENS);
const hostile = tokenString(QS_TOKENS_HOSTILE, 32);

describe('query parser "extended" vs qs (Express 5 options)', () => {
  it('deep-equals qs.parse(str, { allowPrototypes: true })', () => {
    fc.assert(
      fc.property(benign, (s) => {
        const ours = rxQuery(s, 'extended');
        const ref = expressExtended(s);
        expect(plain(ours)).toEqual(plain(ref));
        expect(protoShape(ours)).toEqual(protoShape(ref));
      }),
      fcParams(4000)
    );
  });

  it('deep-equals qs on bracket-heavy strings (arrays, overflow past arrayLimit 20, depth 5)', () => {
    const BR = ['a', 'b', '[', ']', '[]', '[0]', '[1]', '[19]', '[20]', '[21]', '[a]', '[b]', '=', '&', '1', 'x'];
    fc.assert(
      fc.property(tokenString(BR, 40), (s) => {
        expect(plain(rxQuery(s, 'extended'))).toEqual(plain(expressExtended(s)));
      }),
      fcParams(3000)
    );
  });

  it('qsParse alone (no fast path) deep-equals qs even in the %5D gap', () => {
    fc.assert(
      fc.property(benign, (s) => {
        const ours = qsParse(s, { depth: 5, arrayLimit: 20, parameterLimit: 1000 });
        expect(plain(ours)).toEqual(plain(expressExtended(s)));
      }),
      fcParams(3000)
    );
  });

  // Regression: the flat fast path used to be taken when the string had `%5D` (or `]`) but no
  // `[`/`%5B`. qs rewrites `%5D` -> `]` first and then splits key/value on `]=`.
  //   input `q=x%5D=y`   expected (Express) {"q=x]":"y"}
  //   input `%zz%5d`     expected {"%zz]":""}
  it('%5D / ] without [ / %5B goes through the full qs parser', () => {
    for (const s of ['q=x%5D=y', '%zz%5d', '====%5D==', 'a=x]=y', 'q=x%5d=y&q=z']) {
      expect(plain(rxQuery(s, 'extended'))).toEqual(plain(expressExtended(s)));
    }
  });
});

describe('query parser "simple" vs node:querystring', () => {
  it('deep-equals querystring.parse (malformed escapes included)', () => {
    fc.assert(
      fc.property(benign, (s) => {
        const ours = rxQuery(s, 'simple');
        const ref = expressSimple(s);
        expect(plain(ours)).toEqual(plain(ref));
        expect(protoShape(ours)).toEqual(protoShape(ref));
      }),
      fcParams(4000)
    );
  });

  // Regression: querystring.parse decodes valid %XX escapes even when a neighbour is malformed
  // (and maps invalid UTF-8 to U+FFFD); rxpress used to keep the whole key/value undecoded.
  //   input `a=%41%`      expected (Express 'simple') {"a":"A%"}
  //   input `a=%E0%41`    expected {"a":"\uFFFDA"}
  it('malformed escapes are decoded byte-wise like querystring', () => {
    for (const s of ['a=%41%', 'a=%E0%41', 'k%41%zz=1', 'a😀+%zz=1', '😀%zz=😀+%41%']) {
      expect(plain(rxQuery(s, 'simple'))).toEqual(plain(expressSimple(s)));
    }
  });
});

describe('urlencoded body vs body-parser 2 (qs)', () => {
  it('extended: deep-equals body-parser', () => {
    fc.assert(
      fc.property(benign, (s) => {
        const ours = rxBody(s, true);
        const ref = bodyParserBody(s, true);
        expect(plain(ours)).toEqual(plain(ref));
        expect(protoShape(ours)).toEqual(protoShape(ref));
      }),
      fcParams(3000)
    );
  });

  it('extended: keys nested deeper than 32 are a 400 (strictDepth), like body-parser', () => {
    fc.assert(
      fc.property(fc.integer({ min: 33, max: 80 }), fc.constantFrom('', '=1', '=a&b=2'), (d, tail) => {
        const s = 'a' + '[x]'.repeat(d) + tail;
        expect(() => bodyParserBody(s, true)).toThrow(RangeError);
        let status: unknown;
        try {
          rxBody(s, true);
        } catch (err) {
          status = (err as { status?: number }).status;
        }
        expect(status).toBe(400);
      }),
      fcParams(100)
    );
  });

  it('non-extended: deep-equals body-parser (qs depth: 0)', () => {
    fc.assert(
      fc.property(benign, (s) => {
        expect(plain(rxBody(s, false))).toEqual(plain(bodyParserBody(s, false)));
      }),
      fcParams(3000)
    );
  });

  // Regression: body-parser 2 parses non-extended bodies with qs `depth: 0`, which still strips a
  // leading bracket pair, rewrites %5B/%5D and drops empty keys; rxpress used the 'simple'
  // querystring-style parser.
  //   body `[a]=1`   expected (Express 5) {"a":"1"}
  //   body `=x`      expected {}
  it('urlencoded({ extended: false }) is qs depth:0 like body-parser 2', () => {
    for (const s of ['[a]=1', '=x', 'a%5Bb%5D=1']) {
      expect(plain(rxBody(s, false))).toEqual(plain(bodyParserBody(s, false)));
    }
  });
});

describe('parser invariants under hostile input', () => {
  const before = prototypeSnapshot();
  const parsers: Array<[string, (s: string) => unknown]> = [
    ['query extended', (s) => rxQuery(s, 'extended')],
    ['query simple', (s) => rxQuery(s, 'simple')],
    ['body extended', (s) => rxBody(s, true)],
    ['body simple', (s) => rxBody(s, false)],
  ];

  for (const [name, parse] of parsers) {
    it(`${name}: never throws and never pollutes prototypes`, () => {
      fc.assert(
        fc.property(hostile, (s) => {
          const out = parse(s);
          expect(hasProtoKeyOnOrdinaryObject(out)).toBe(false);
          expect(({} as Record<string, unknown>).polluted).toBeUndefined();
          expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'x')).toBe(false);
        }),
        fcParams(2500)
      );
      expect(prototypeSnapshot()).toEqual(before);
    });
  }

  it('explicit pollution payloads leave Object.prototype untouched', () => {
    const payloads = [
      '__proto__[polluted]=1',
      'a[__proto__][polluted]=1',
      'constructor[prototype][polluted]=1',
      'a[constructor][prototype][polluted]=1',
      '__proto__.polluted=1',
      '%5F%5Fproto%5F%5F[polluted]=1',
      'a=1&__proto__=x&__proto__[]=y',
    ];
    for (const [, parse] of parsers) {
      for (const p of payloads) {
        const out = parse(p);
        expect(hasProtoKeyOnOrdinaryObject(out)).toBe(false);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(([] as unknown as Record<string, unknown>).polluted).toBeUndefined();
      }
    }
    expect(prototypeSnapshot()).toEqual(before);
  });

  it('bounded time: 20-60 KB adversarial strings parse in < 150 ms each', () => {
    const unit = fc.constantFrom('[', ']', '[]', '[0]', '[a]', 'a', '=', '&', '%', '%5B', '%5D', '[21]', '[999999]');
    fc.assert(
      fc.property(fc.array(unit, { minLength: 1, maxLength: 6 }), fc.integer({ min: 4000, max: 12000 }), (u, reps) => {
        const s = 'k' + u.join('').repeat(reps);
        for (const [name, parse] of parsers) {
          const t0 = performance.now();
          try {
            parse(s);
          } catch (err) {
            // Only body-parser-style HTTP errors (400 depth / 413 too many params) are acceptable.
            expect([400, 413], name).toContain((err as { status?: number }).status);
          }
          const ms = performance.now() - t0;
          expect(ms, `${name} len=${s.length}`).toBeLessThan(150);
        }
      }),
      fcParams(25)
    );
  });
});
