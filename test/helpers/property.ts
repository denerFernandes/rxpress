// Shared helpers for the fast-check property suites.
import fc from 'fast-check';

/** One seed for every property so a failure is reproducible with `FC_SEED=<n>`. */
export const FC_SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : 0x5eed_2026;

export function fcParams(numRuns: number): fc.Parameters<unknown> {
  return { seed: FC_SEED, numRuns, endOnFailure: true };
}

/** Recursively converts null-prototype / plain containers into plain JSON values. */
export function plain(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v ?? null)) as unknown;
}

export const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

/**
 * A string built from tokens that stress a query / form parser: brackets (raw and
 * percent-encoded), separators, broken and valid escapes, multi-byte UTF-8, dots and indices.
 */
export function tokenString(tokens: readonly string[], maxTokens = 24): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...tokens), { maxLength: maxTokens })
    .map((parts) => parts.join(''));
}

export const QS_TOKENS = [
  'a', 'b', 'c', 'x', 'Z', '0', '1', '2', '21', '99', '100',
  '[', ']', '[]', '[0]', '[1]', '[a]', '[b]', '[21]', '[]=',
  '%5B', '%5D', '%5b', '%5d',
  '=', '==', '&', '&&', '+', '%20', '%41', '%2B', '%26', '%3D', '%25',
  '%', '%E0', '%E0%A4', '%E2%82%AC', '%zz', '%4', '%C3%A9',
  '.', '-', '_', '~', ';', ',', '"', ' ',
  'é', '€', '😀',
] as const;

/** Every token above plus the prototype-pollution keys (for the invariant properties). */
export const QS_TOKENS_HOSTILE = [
  ...QS_TOKENS,
  '__proto__', '[__proto__]', 'constructor', '[constructor]', 'prototype', '[prototype]',
  'hasOwnProperty', '[toString]', 'valueOf', '[length]',
] as const;

/** Returns a deep snapshot of everything reachable on Object.prototype we care about. */
export function prototypeSnapshot(): string[] {
  return [
    ...Object.getOwnPropertyNames(Object.prototype),
    ...Object.getOwnPropertyNames(Array.prototype),
  ].sort();
}

/**
 * True if some ordinary object (one that inherits from Object.prototype) in the tree carries an
 * own `__proto__` key: the shape that lets a later naive merge reach Object.prototype. qs output
 * never has it; querystring may, but only on prototype-free objects, where it is plain data.
 */
export function hasProtoKeyOnOrdinaryObject(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false;
  if (Object.getPrototypeOf(v) !== null && Object.prototype.hasOwnProperty.call(v, '__proto__')) {
    return true;
  }
  for (const k of Object.keys(v)) {
    if (hasProtoKeyOnOrdinaryObject((v as Record<string, unknown>)[k])) return true;
  }
  return false;
}

/** The value tree with every container replaced by its kind: 'array', 'object' or 'null-proto'. */
export function protoShape(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return typeof v;
  const kind = Array.isArray(v) ? 'array' : Object.getPrototypeOf(v) === null ? 'null-proto' : 'object';
  const children: Record<string, unknown> = {};
  for (const k of Object.keys(v)) children[k] = protoShape((v as Record<string, unknown>)[k]);
  return { kind, children };
}
