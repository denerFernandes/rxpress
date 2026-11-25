// Grammar-based generators for Express 5 route patterns (path-to-regexp 8 syntax) and for
// request paths that are likely to (almost) match them.
import fc from 'fast-check';

export type Node =
  | { t: 'lit'; v: string }
  | { t: 'sep'; v: '/' }
  | { t: 'param'; name: string }
  | { t: 'splat'; name: string }
  | { t: 'opt'; body: Node[] };

const LIT = fc.constantFrom('a', 'b', 'users', 'x1', 'v2', '-', '.', '~', '_', 'é', '%20');
const NAME = fc.constantFrom('a', 'b', 'c', 'id', 'x', 'rest', 'file', 'ext');

const nodeArb: fc.Memo<Node> = fc.memo((depth) =>
  depth <= 1
    ? fc.oneof(
        { weight: 4, arbitrary: LIT.map((v): Node => ({ t: 'lit', v })) },
        { weight: 3, arbitrary: fc.constant<Node>({ t: 'sep', v: '/' }) },
        { weight: 3, arbitrary: NAME.map((name): Node => ({ t: 'param', name })) },
        { weight: 1, arbitrary: NAME.map((name): Node => ({ t: 'splat', name })) }
      )
    : fc.oneof(
        { weight: 4, arbitrary: LIT.map((v): Node => ({ t: 'lit', v })) },
        { weight: 3, arbitrary: fc.constant<Node>({ t: 'sep', v: '/' }) },
        { weight: 3, arbitrary: NAME.map((name): Node => ({ t: 'param', name })) },
        { weight: 1, arbitrary: NAME.map((name): Node => ({ t: 'splat', name })) },
        {
          weight: 2,
          arbitrary: fc
            .array(nodeArb(depth - 1), { minLength: 1, maxLength: 4 })
            .map((body): Node => ({ t: 'opt', body })),
        }
      )
);

export const patternNodes = fc.array(nodeArb(3), { minLength: 0, maxLength: 7 });

export function render(nodes: Node[]): string {
  let s = '';
  for (const n of nodes) {
    if (n.t === 'lit' || n.t === 'sep') s += n.v;
    else if (n.t === 'param') s += ':' + n.name;
    else if (n.t === 'splat') s += '*' + n.name;
    else s += '{' + render(n.body) + '}';
  }
  return s;
}

/** Turns a pattern into a concrete path, choosing values / optional groups from `pick`. */
export function instantiate(nodes: Node[], pick: () => number): string {
  const VALUES = ['1', 'abc', 'a-b', 'a.b', 'x~y', '-', '.', '%2F', '%C3%A9', 'Z', '_'];
  let s = '';
  for (const n of nodes) {
    if (n.t === 'lit' || n.t === 'sep') s += n.v;
    else if (n.t === 'param') s += VALUES[Math.floor(pick() * VALUES.length)];
    else if (n.t === 'splat') {
      const k = 1 + Math.floor(pick() * 3);
      const parts: string[] = [];
      for (let i = 0; i < k; i++) parts.push(VALUES[Math.floor(pick() * VALUES.length)]);
      s += parts.join('/');
    } else if (pick() < 0.5) s += instantiate(n.body, pick);
  }
  return s;
}

const MUTATIONS = ['/', '//', '-', '.', 'A', 'X', '%', '%zz', '/x', '', '~'];

/** A pattern plus a handful of candidate paths: instantiations and mutations of them. */
export const patternWithInputs = fc
  .tuple(patternNodes, fc.array(fc.double({ min: 0, max: 0.999999, noNaN: true }), { minLength: 40, maxLength: 40 }))
  .map(([nodes, rnd]) => {
    let i = 0;
    const pick = () => rnd[i++ % rnd.length];
    const pattern = '/' + render(nodes);
    const inputs = new Set<string>();
    for (let k = 0; k < 6; k++) {
      const base = '/' + instantiate(nodes, pick);
      inputs.add(base);
      const m = MUTATIONS[Math.floor(pick() * MUTATIONS.length)];
      const at = Math.floor(pick() * (base.length + 1));
      inputs.add(base.slice(0, at) + m + base.slice(at));
      inputs.add(base + '/');
      inputs.add(base.toUpperCase());
    }
    return { pattern, inputs: [...inputs] };
  });
