// Port of the `qs@6.17` parse algorithm (the one Express 5 and body-parser use for "extended"
// query strings / urlencoded bodies), restricted to the option set those callers pass:
//   allowDots=false, allowEmptyArrays=false, allowPrototypes=true, comma=false,
//   duplicates='combine', parseArrays=true, plainObjects=false, strictMerge=true,
//   strictNullHandling=false, throwOnLimitExceeded=false, utf-8 only.
// As in qs, containers are ordinary objects and a `__proto__` segment is never assigned (its
// parent container is still created), so the result cannot reach Object.prototype.
//
// Kept dependency-free so rxpress keeps zero runtime dependencies.

type Obj = Record<string, unknown>;

export interface QsOptions {
  /** Max bracket depth (qs `depth`). */
  depth: number;
  /** Max array index / array size before falling back to an object (qs `arrayLimit`). */
  arrayLimit: number;
  /** Max number of `&`-separated parts considered (qs `parameterLimit`). */
  parameterLimit: number;
  /** Throw a RangeError when a key nests deeper than `depth` (qs `strictDepth`). */
  strictDepth?: boolean;
}

const hasOwn = (o: object, k: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isArray = Array.isArray;

function newObj(): Obj {
  return {};
}

function decode(s: string): string {
  if (s.indexOf('%') === -1) return s.indexOf('+') === -1 ? s : s.replace(/\+/g, ' ');
  const plus = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;
  }
}

/** Per-parse bookkeeping (qs keeps these in module-wide side channels). */
class State {
  readonly overflow = new WeakMap<object, number>();
  readonly conflict = new WeakMap<object, number>();
  constructor(readonly limit: number) {}

  markOverflow<T extends object>(obj: T, max: number): T {
    this.overflow.set(obj, max);
    return obj;
  }

  markConflict<T extends object>(obj: T, max: number): T {
    this.conflict.set(obj, max);
    return obj;
  }

  arrayToObject(src: unknown[]): Obj {
    const o = newObj();
    for (let i = 0; i < src.length; ++i) {
      if (src[i] !== undefined) o[i] = src[i];
    }
    return o;
  }

  limitedPair(first: unknown, second: unknown): unknown {
    const pair = [first, second];
    if (pair.length > this.limit) return this.markOverflow(this.arrayToObject(pair), 1);
    return pair;
  }

  combine(a: unknown, b: unknown): unknown {
    if (a !== null && typeof a === 'object' && this.overflow.has(a)) {
      const ao = a as Obj;
      const values = isArray(b) ? b : [b];
      let idx = this.overflow.get(a)!;
      for (let i = 0; i < values.length; ++i) {
        idx += 1;
        ao[idx] = values[i];
      }
      this.overflow.set(a, idx);
      return a;
    }
    const result = ([] as unknown[]).concat(a, b);
    if (result.length > this.limit) {
      return this.markOverflow(this.arrayToObject(result), result.length - 1);
    }
    return result;
  }

  merge(target: unknown, source: unknown): unknown {
    if (!source) return target;

    if (typeof source !== 'object') {
      if (isArray(target)) {
        const nextIndex = target.length;
        if (countElements(target) >= this.limit) {
          return this.markOverflow(this.arrayToObject(target.concat(source)), nextIndex);
        }
        target[nextIndex] = source;
      } else if (target !== null && typeof target === 'object') {
        const t = target as Obj;
        if (this.overflow.has(t)) {
          const idx = this.overflow.get(t)! + 1;
          t[idx] = source;
          this.overflow.set(t, idx);
        } else if (this.conflict.has(t)) {
          const idx = this.conflict.get(t)! + 1;
          t[idx] = source;
          this.conflict.set(t, idx);
        } else {
          const pair = this.limitedPair(target, source);
          return isArray(pair) ? this.markConflict(pair, 1) : pair;
        }
      } else {
        return this.limitedPair(target, source);
      }
      return target;
    }

    const src = source as Obj;
    if (target === null || target === undefined || typeof target !== 'object') {
      if (this.overflow.has(src)) {
        const keys = Object.keys(src);
        const result = newObj();
        result[0] = target;
        for (let m = 0; m < keys.length; m++) {
          result[parseInt(keys[m], 10) + 1] = src[keys[m]];
        }
        return this.markOverflow(result, this.overflow.get(src)! + 1);
      }
      const combined = ([target] as unknown[]).concat(source);
      if (combined.length > this.limit) {
        return this.markOverflow(this.arrayToObject(combined), combined.length - 1);
      }
      return combined;
    }

    let mergeTarget = target as Obj;
    if (isArray(target) && !isArray(source)) {
      mergeTarget = this.arrayToObject(target);
      if (this.conflict.has(target)) this.markConflict(mergeTarget, target.length - 1);
    }

    if (isArray(target) && isArray(source)) {
      for (let i = 0; i < source.length; i++) {
        if (!hasOwn(source, i)) continue; // forEach skips holes
        const item = source[i];
        if (hasOwn(target, i)) {
          const targetItem = target[i];
          if (
            targetItem !== null &&
            typeof targetItem === 'object' &&
            item !== null &&
            typeof item === 'object'
          ) {
            target[i] = this.merge(targetItem, item);
          } else {
            target[target.length] = item;
          }
        } else {
          target[i] = item;
        }
      }
      if (countElements(target) > this.limit) {
        return this.markOverflow(this.arrayToObject(target), target.length - 1);
      }
      return target;
    }

    const acc = mergeTarget;
    const keys = Object.keys(src);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const value = src[key];
      acc[key] = hasOwn(acc, key) ? this.merge(acc[key], value) : value;

      if (this.overflow.has(src) && !this.overflow.has(acc)) {
        this.markOverflow(acc, maxNumericIndex(acc, this.overflow.get(src)!));
      }
      if (this.overflow.has(acc)) {
        const n = parseInt(key, 10);
        if (String(n) === key && n >= 0 && n > this.overflow.get(acc)!) this.overflow.set(acc, n);
      }
      if (this.conflict.has(acc)) {
        const n = parseInt(key, 10);
        if (String(n) === key && n > this.conflict.get(acc)!) this.conflict.set(acc, n);
      }
    }
    return acc;
  }
}

function countElements(arr: unknown[]): number {
  let count = 0;
  for (let i = 0; i < arr.length; ++i) if (hasOwn(arr, i)) count += 1;
  return count;
}

function maxNumericIndex(obj: Obj, min: number): number {
  let max = min;
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; ++i) {
    const n = parseInt(keys[i], 10);
    if (String(n) === keys[i] && n > max) max = n;
  }
  return max;
}

function stripWrappingBrackets(key: string): string {
  return key.charAt(0) === '[' && key.charAt(key.length - 1) === ']' ? key.slice(1, -1) : key;
}

/** qs `splitKeyIntoSegments` (allowPrototypes=true: no segment is rejected here). */
function splitKey(key: string, opts: QsOptions): string[] {
  if (opts.depth <= 0) return [key];

  const segments: string[] = [];
  const first = key.indexOf('[');
  const parent = first >= 0 ? key.slice(0, first) : key;
  if (parent) segments.push(parent);

  const n = key.length;
  let open = first;
  let collected = 0;
  while (open >= 0 && collected < opts.depth) {
    let level = 1;
    let i = open + 1;
    let close = -1;
    while (i < n && close < 0) {
      const cu = key.charCodeAt(i);
      if (cu === 0x5b) level += 1;
      else if (cu === 0x5d) {
        level -= 1;
        if (level === 0) close = i;
      }
      i += 1;
    }
    if (close < 0) {
      segments.push('[' + key.slice(open) + ']');
      return segments;
    }
    segments.push(key.slice(open, close + 1));
    collected += 1;
    open = key.indexOf('[', close + 1);
  }

  if (open >= 0) {
    if (opts.strictDepth === true) {
      throw new RangeError(
        `Input depth exceeded depth option of ${opts.depth} and strictDepth is true`
      );
    }
    segments.push('[' + key.slice(open) + ']');
  }
  return segments;
}

function parseObject(chain: string[], val: unknown, st: State): unknown {
  let leaf = val;
  for (let i = chain.length - 1; i >= 0; --i) {
    let obj: unknown;
    const root = chain[i];
    if (root === '[]') {
      obj = leaf !== null && typeof leaf === 'object' && st.overflow.has(leaf)
        ? leaf
        : st.combine([], leaf);
    } else {
      const o = newObj();
      obj = o;
      const cleanRoot = stripWrappingBrackets(root);
      const index = parseInt(cleanRoot, 10);
      const isValidArrayIndex =
        !Number.isNaN(index) && root !== cleanRoot && String(index) === cleanRoot && index >= 0;
      if (isValidArrayIndex && index < st.limit) {
        const arr: unknown[] = [];
        arr[index] = leaf;
        obj = arr;
      } else if (isValidArrayIndex) {
        o[index] = leaf;
        st.markOverflow(o, index);
      } else if (cleanRoot !== '__proto__') {
        o[cleanRoot] = leaf;
      }
    }
    leaf = obj;
  }
  return leaf;
}

function compact(value: Obj): Obj {
  const queue: { obj: Obj; prop: string }[] = [{ obj: { o: value }, prop: 'o' }];
  const refs = new Set<object>();
  for (let i = 0; i < queue.length; ++i) {
    const item = queue[i];
    const obj = item.obj[item.prop] as Obj;
    const keys = Object.keys(obj);
    for (let j = 0; j < keys.length; ++j) {
      const val = obj[keys[j]];
      if (typeof val === 'object' && val !== null && !refs.has(val)) {
        queue.push({ obj, prop: keys[j] });
        refs.add(val);
      }
    }
  }
  while (queue.length > 1) {
    const item = queue.pop()!;
    const obj = item.obj[item.prop];
    if (isArray(obj)) {
      const compacted: unknown[] = [];
      for (let j = 0; j < obj.length; ++j) {
        if (obj[j] !== undefined) compacted.push(obj[j]);
      }
      item.obj[item.prop] = compacted;
    }
  }
  return value;
}

/**
 * `qs.parse(str, { allowPrototypes: true, ...opts })` for the Express/body-parser option set.
 * Throws RangeError only when `strictDepth` is set and exceeded.
 */
export function qsParse(str: string, opts: QsOptions): Obj {
  if (str === '') return newObj();
  const st = new State(opts.arrayLimit);

  // parseValues (qs keeps this intermediate map prototype-free)
  const temp = Object.create(null) as Obj;
  const clean = str.replace(/%5B/gi, '[').replace(/%5D/gi, ']');
  const parts = clean.split('&', opts.parameterLimit === Infinity ? undefined : opts.parameterLimit);
  for (let i = 0; i < parts.length; ++i) {
    const part = parts[i];
    const bracketEq = part.indexOf(']=');
    const pos = bracketEq === -1 ? part.indexOf('=') : bracketEq + 1;
    let key: string;
    let val: string;
    if (pos === -1) {
      key = decode(part);
      val = '';
    } else {
      key = decode(part.slice(0, pos));
      val = decode(part.slice(pos + 1));
    }
    if (hasOwn(temp, key)) {
      temp[key] = st.combine(temp[key], val);
    } else {
      temp[key] = val;
    }
  }

  let obj: unknown = newObj();
  const keys = Object.keys(temp);
  for (let i = 0; i < keys.length; ++i) {
    const key = keys[i];
    if (!key) continue;
    const chain = splitKey(key, opts);
    obj = st.merge(obj, parseObject(chain, temp[key], st));
  }
  return compact(obj as Obj);
}
