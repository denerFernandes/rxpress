// Grammar-generated route patterns vs Express 5.
//
// The reference is the real `router/lib/layer.js` Layer (Express 5's router@2), which wraps
// path-to-regexp 8 `match()` with `loosen()` and the `'/'` prefix fast path. Patterns come from a
// grammar of literals, separators, `:params`, `*splats` and nested `{optional}` groups; inputs are
// instantiations of the pattern plus small mutations, so a large share actually match.
//
// Regressions pinned below: patterns / paths with an empty segment (`//`) and strict prefix
// layers whose pattern ends in `/`.
import fc from 'fast-check';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { compilePathMatcher } from '../js/router.js';
import { fcParams } from './helpers/property.js';
import { instantiate, patternNodes, patternWithInputs, render } from './helpers/route-grammar.js';

const require = createRequire(import.meta.url);
type LayerMatch = false | { params: Record<string, unknown>; path: string };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Layer = require('router/lib/layer.js') as new (
  path: string,
  opts: Opts,
  fn: () => void
) => { match(path: string): LayerMatch };

type Opts = { end: boolean; sensitive: boolean; strict: boolean };

function outcome(fn: () => unknown): unknown {
  try {
    return { ok: JSON.parse(JSON.stringify(fn())) as unknown };
  } catch (err) {
    return { threw: (err as Error).name };
  }
}

/** A prefix match may or may not include one trailing `/`; the router strips it anyway. */
const consumed = (p: string, o: Opts) => (!o.end && p.endsWith('/') ? p.slice(0, -1) : p);

function compare(pattern: string, inputs: string[], o: Opts): string[] {
  const mismatches: string[] = [];
  const a0 = outcome(() => (compilePathMatcher(pattern, o), true));
  const b0 = outcome(() => (new Layer(pattern, o, () => {}), true));
  if (JSON.stringify(a0) !== JSON.stringify(b0)) {
    return [`compile ${pattern} ${JSON.stringify(o)} rxpress=${JSON.stringify(a0)} express=${JSON.stringify(b0)}`];
  }
  if ('threw' in (a0 as object)) return mismatches;
  const ours = compilePathMatcher(pattern, o);
  const theirs = new Layer(pattern, o, () => {});
  for (const input of inputs) {
    const a = outcome(() => {
      const r = ours.match(input);
      return r ? { params: { ...r.params }, path: consumed(r.matchedPath, o) } : false;
    });
    const b = outcome(() => {
      const r = theirs.match(input);
      return r ? { params: { ...r.params }, path: consumed(r.path, o) } : false;
    });
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      mismatches.push(`${pattern} ${JSON.stringify(o)} ${JSON.stringify(input)}: rxpress=${JSON.stringify(a)} express=${JSON.stringify(b)}`);
    }
  }
  return mismatches;
}

const optsArb = fc.record({ end: fc.boolean(), sensitive: fc.boolean(), strict: fc.boolean() });

describe('route matching: grammar patterns vs Express 5 Layer (path-to-regexp 8)', () => {
  it('agrees on compile errors, match / miss, params and consumed path', () => {
    let compared = 0;
    let matched = 0;
    fc.assert(
      fc.property(patternWithInputs, optsArb, ({ pattern, inputs }, o) => {
        const usable = inputs;
        compared += usable.length;
        try {
          const r = compilePathMatcher(pattern, o);
          for (const i of usable) if (r.match(i)) matched++;
        } catch {
          /* compile error: compared below */
        }
        expect(compare(pattern, usable, o)).toEqual([]);
      }),
      fcParams(8000)
    );
    expect(compared).toBeGreaterThan(20_000);
    expect(matched).toBeGreaterThan(5_000);
  });

  it('timing bound: every generated pattern matches / misses a ~6 KB adversarial path in < 250 ms', () => {
    const filler = fc.constantFrom('-', '.', '~', '/', '-a', 'a.', '/-', '%2F', 'a');
    fc.assert(
      fc.property(patternNodes, filler, fc.integer({ min: 1000, max: 3000 }), fc.constantFrom('', '/', '!', '/x'), (nodes, fill, n, tail) => {
        const pattern = '/' + render(nodes);
        let matcher: ReturnType<typeof compilePathMatcher>;
        try {
          matcher = compilePathMatcher(pattern, { end: true });
        } catch {
          return; // invalid pattern (Express rejects it too; covered above)
        }
        let i = 0;
        const base = '/' + instantiate(nodes, () => ((i = (i * 7 + 3) % 11) / 11));
        const input = base + fill.repeat(n) + tail;
        for (const m of [matcher, compilePathMatcher(pattern, { end: false })]) {
          const t0 = performance.now();
          try {
            m.match(input);
          } catch {
            /* URIError from decoding is fine */
          }
          expect(performance.now() - t0, `${pattern} len=${input.length}`).toBeLessThan(250); // backtracking blow-up takes seconds; this only absorbs a busy machine
        }
      }),
      fcParams(600)
    );
  });

  // Regression: Express's `loosen()` strips ALL trailing slashes of a non-strict pattern.
  //   app.get('//')  GET //            expected: no match (404)
  //   app.use('/v2///') GET /v2///x    expected: consumed '/v2'
  it('patterns with empty segments (`//`) match like Express', () => {
    const base = { sensitive: false, strict: false };
    expect([
      ...compare('//', ['//'], { ...base, end: true }),
      ...compare('/v2///', ['/v2///x'], { ...base, end: false }),
    ]).toEqual([]);
  });

  // Regression: with `strict routing`, a prefix layer (`app.use` / `router.use`) whose path ends
  // in `/` requires a delimiter after it in Express (path-to-regexp `end: false, trailing: false`).
  //   router({ strict: true }).use('/a/', h)  GET /a/b   expected: h skipped
  it('strict prefix pattern ending in "/" does not match "/a/b" (like Express)', () => {
    expect(compare('/a/', ['/a/b', '/a/', '/a//b'], { end: false, sensitive: false, strict: true })).toEqual([]);
  });
});
