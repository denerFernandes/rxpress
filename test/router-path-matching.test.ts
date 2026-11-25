// Route-pattern compiler: ReDoS regression + Express 5 parity.
//
// The differential half compares rxpress's matcher against path-to-regexp 8's
// `match()` (the engine behind Express 5's `router`) configured exactly as
// `router/lib/layer.js` configures it.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { compilePathMatcher } from '../js/router.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ptr = require('path-to-regexp') as {
  match: (
    path: string,
    opts: { sensitive?: boolean; end?: boolean; trailing?: boolean; decode?: (s: string) => string }
  ) => (input: string) => false | { path: string; params: Record<string, unknown> };
};

type Opts = { end: boolean; sensitive: boolean; strict: boolean };

/** Express 5 `Layer` matcher (router@2): `loosen()` + path-to-regexp 8 `match()`. */
function expressMatcher(path: string, o: Opts) {
  const p = o.strict || path === '/' ? path : path.replace(/\/+$/, '');
  return ptr.match(p, {
    sensitive: o.sensitive,
    end: o.end,
    trailing: !o.strict,
    decode: decodeURIComponent,
  });
}

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ['a', 'b', 'Z', 'x', '1', '-', '-', '.', '.', '~', '/', '/', '/', '%20', '%2F', '%E0', '_'];

function randomTail(next: () => number, maxLen: number): string {
  const len = Math.floor(next() * (maxLen + 1));
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return s;
}

function staticPrefix(pattern: string): string {
  const m = /^[^:*{\\]*/.exec(pattern);
  return m ? m[0] : '';
}

/**
 * A prefix (`end: false`) match may or may not include one trailing `/` (Express adds
 * `(?:/$)?`); the router drops it before computing `req.baseUrl`, so compare without it.
 */
function consumed(path: string, o: Opts): string {
  return !o.end && path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function outcome(fn: () => unknown): unknown {
  try {
    return { ok: fn() };
  } catch (err) {
    return { threw: (err as Error).name };
  }
}

const PATTERNS = [
  '/users/:id',
  '/users/:id/posts/:postId',
  '/Users/:id/',
  '/flights/:from-:to',
  '/f/:a-:b-:c',
  '/f/:a-:b-:c-:d',
  '/f/:a.:b',
  '/f/:a.:b.:c',
  '/f/:a~:b~:c~:d',
  '/f/:a--:b',
  '/f/:a-:b.:c',
  '/:file{.:ext}',
  '/dl/:name{.:ext}{.:gz}',
  '/opt{/:opt}',
  '/a{/:b{/:c}}',
  '/{:lang/}docs/:page',
  '/p/:p{-:q}{-:r}',
  '/files/*splat',
  '/files/*splat/edit',
  '/w/*a-*b',
  '/w/*a.*b.*c',
  '/x/:a/*rest',
  '/x/:a-*rest',
  '/y/*rest.:ext',
  '*splat',
  '/q/:"quoted name"',
  '/esc/\\{lit\\}/:id',
  '/v/:café',
];

const OPTION_SETS: Opts[] = [];
for (const end of [true, false])
  for (const sensitive of [false, true])
    for (const strict of [false, true]) OPTION_SETS.push({ end, sensitive, strict });

describe('route matching: ReDoS regression', () => {
  const BUDGET_MS = 50;
  const N = 20_000;
  const cases: Array<[string, string]> = [];
  for (const sep of ['-', '.', '~']) {
    for (const nParams of [2, 3, 4]) {
      const pattern = '/f/' + Array.from({ length: nParams }, (_, i) => `:p${i}`).join(sep);
      cases.push(
        [pattern, '/f/' + sep.repeat(N) + '/x'],
        [pattern, '/f/' + sep.repeat(N)],
        [pattern, '/f/' + sep.repeat(N) + '!'],
        [pattern, '/f/' + ('a' + sep).repeat(N / 2) + '/x'],
        [pattern, '/f/' + (sep + 'a').repeat(N / 2) + '/'],
        [pattern, '/f/' + (sep + sep + 'a').repeat(N / 3) + '/x/y'],
        [pattern, '/f/a' + sep.repeat(N) + 'b/x']
      );
    }
    // Wildcards and optional groups in the same segment.
    for (const pattern of [
      `/w/*a${sep}*b${sep}*c`,
      `/w/:a${sep}*b`,
      `/w/*a${sep}:b`,
      `/w/:a{${sep}:b}{${sep}:c}`,
      `/w/:a${sep}:b{/*rest}`,
    ]) {
      cases.push(
        [pattern, '/w/' + sep.repeat(N) + '/x'],
        [pattern, '/w/' + (sep + '/').repeat(N / 2) + '!'],
        [pattern, '/w/' + ('a' + sep).repeat(N / 2) + '/']
      );
    }
  }
  // Express 4 sugar.
  cases.push(
    ['/o/:a-:b?', '/o/' + '-'.repeat(N) + '/x'],
    ['/o/*-*-*', '/o/' + '-'.repeat(N) + '/x']
  );

  it(`${cases.length} adversarial inputs each match/miss in < ${BUDGET_MS} ms`, () => {
    const slow: string[] = [];
    for (const [pattern, input] of cases) {
      for (const end of [true, false]) {
        const matcher = compilePathMatcher(pattern, { end });
        const t0 = performance.now();
        matcher.match(input);
        const ms = performance.now() - t0;
        if (ms >= BUDGET_MS) slow.push(`${pattern} end=${end} len=${input.length}: ${ms.toFixed(1)} ms`);
      }
    }
    expect(slow).toEqual([]);
  });

  it('the original report (GET /f/ + 1500 "-" + /x against /f/:a-:b-:c) is a fast 404', () => {
    const m = compilePathMatcher('/f/:a-:b-:c', { end: true });
    const t0 = performance.now();
    expect(m.match('/f/' + '-'.repeat(1500) + '/x')).toBeNull();
    expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
  });
});

describe('route matching: differential vs path-to-regexp 8 (Express 5)', () => {
  it('agrees on match / params / matched path for generated inputs', () => {
    const next = rng(0x5eed);
    let compared = 0;
    let matched = 0;
    const mismatches: string[] = [];

    for (const pattern of PATTERNS) {
      const prefix = staticPrefix(pattern);
      const inputs = new Set<string>(['/', '', prefix, prefix + '/', prefix.toUpperCase()]);
      for (let i = 0; i < 250; i++) {
        inputs.add(prefix + randomTail(next, 10));
        inputs.add('/' + randomTail(next, 14));
      }

      for (const opts of OPTION_SETS) {
        const ours = compilePathMatcher(pattern, opts);
        const theirs = expressMatcher(pattern, opts);
        for (const input of inputs) {
          compared++;
          const a = outcome(() => {
            const r = ours.match(input);
            return r ? { params: { ...r.params }, path: consumed(r.matchedPath, opts) } : false;
          }) as { ok?: false | { params: object; path: string }; threw?: string };
          const b = outcome(() => {
            const r = theirs(input);
            if (!r) return false;
            return { params: { ...r.params }, path: consumed(r.path, opts) };
          }) as typeof a;
          if (a.ok) matched++;
          try {
            expect(a).toEqual(b);
          } catch {
            if (mismatches.length < 20) {
              mismatches.push(
                `${pattern} ${JSON.stringify(opts)} ${JSON.stringify(input)}: rxpress=${JSON.stringify(a)} express=${JSON.stringify(b)}`
              );
            }
          }
        }
      }
    }

    expect(mismatches).toEqual([]);
    expect(compared).toBeGreaterThan(50_000);
    expect(matched).toBeGreaterThan(2_000); // the generator actually exercises matches
  });

  it('rejects ambiguous adjacent captures like Express 5', () => {
    for (const pattern of ['/:a:b', '/x/:a*rest', '/*a*b']) {
      expect(() => expressMatcher(pattern, { end: true, sensitive: false, strict: false })).toThrow(
        TypeError
      );
      expect(() => compilePathMatcher(pattern, { end: true })).toThrow(/Missing text before/);
    }
  });

  it('documented Express 5 semantics', () => {
    const m = (p: string, u: string) => compilePathMatcher(p, { end: true }).match(u)?.params ?? null;
    // First param is greedy, later ones stop at the separator (path-to-regexp 8).
    expect({ ...m('/f/:a-:b-:c', '/f/a-b-c-d') }).toEqual({ a: 'a-b', b: 'c', c: 'd' });
    expect({ ...m('/:file{.:ext}', '/archive.tar.gz') }).toEqual({ file: 'archive.tar', ext: 'gz' });
    expect({ ...m('/:file{.:ext}', '/README') }).toEqual({ file: 'README' });
    expect(m('/files/*splat', '/files')).toBeNull();
    expect({ ...m('/files/*splat', '/files/a/b%2Fc') }).toEqual({ splat: ['a', 'b/c'] });
  });
});

describe('route matching: Express 4 sugar is preserved', () => {
  const m = (p: string, u: string) => {
    const r = compilePathMatcher(p, { end: true }).match(u);
    return r ? { ...r.params } : null;
  };

  it('optional `:param?`', () => {
    expect(m('/optional/:id?', '/optional')).toEqual({});
    expect(m('/optional/:id?', '/optional/')).toEqual({});
    expect(m('/optional/:id?', '/optional/7')).toEqual({ id: '7' });
    expect(m('/optional/:id?/x', '/optional/x')).toEqual({});
    expect(m('/optional/:id?/x', '/optional/7/x')).toEqual({ id: '7' });
  });

  it('custom capture body `:param(regex)`', () => {
    expect(m('/n/:id(\\d+)', '/n/42')).toEqual({ id: '42' });
    expect(m('/n/:id(\\d+)', '/n/abc')).toBeNull();
    // Inner capture groups do not shift later keys.
    expect(m('/n/:id((a)|b)/:x', '/n/a/z')).toEqual({ id: 'a', x: 'z' });
  });

  it('bare `*` wildcard (string value, numeric key)', () => {
    expect(m('/s/*', '/s')).toEqual({});
    expect(m('/s/*', '/s/a/b')).toEqual({ 0: 'a/b' });
    expect(m('/s/*/t/*', '/s/a/t/b/c')).toEqual({ 0: 'a', 1: 'b/c' });
  });

  it('prefix (`use`) matching keeps segment boundaries', () => {
    const pre = compilePathMatcher('/api/:v', { end: false });
    expect(pre.match('/api/v1/users')?.matchedPath).toBe('/api/v1');
    expect(pre.match('/api/v1')?.matchedPath).toBe('/api/v1');
    expect(pre.match('/apix/v1')).toBeNull();
  });
});
