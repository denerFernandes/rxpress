import { isUnsafeKey } from '../security.js';

/** @internal */
export interface PathMatchResult {
  matched: boolean;
  matchedPath: string;
  params: Record<string, string>;
}

/** @internal */
export interface CompiledPathMatcher {
  raw: string | RegExp;
  isPrefix: boolean;
  match(path: string): PathMatchResult | null;
}

// ---------------------------------------------------------------------------
// Path pattern compiler.
//
// Mirrors path-to-regexp 8 (the matcher behind Express 5's `router`): the
// pattern is tokenized, `{...}` groups are expanded into alternatives, and every
// capture is emitted with a character class that cannot overlap the text that
// follows/precedes it in the same segment. This is what keeps patterns such as
// `/:a-:b-:c` linear-time (the old lazy `([^/]+?)-([^/]+?)-([^/]+)` shape is the
// CVE-2024-45296 ReDoS). Express 4 extensions (`:id?`, `:id(\d+)`, bare `*`)
// are layered on top as sugar for groups / custom capture bodies.
// ---------------------------------------------------------------------------

type PathToken =
  | { type: 'text'; value: string }
  | { type: 'param'; name: string; re: string | null }
  | { type: 'wildcard'; name: string; array: boolean; allowEmpty: boolean }
  | { type: 'group'; tokens: PathToken[] };

interface CompiledKey {
  name: string;
  array: boolean;
  /** Capture-group index of this key in the final RegExp. */
  group: number;
}

const PARAM_NAME_RE = /[$_0-9\p{ID_Start}][$‌‍\p{ID_Continue}]*/uy;
const MAX_PATH_COMBINATIONS = 256;

function findMatchingParen(str: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
      continue;
    }
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function hasMatchingBrace(str: string, openIdx: number): boolean {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
      continue;
    }
    if (str[i] === '{') depth++;
    else if (str[i] === '}' && --depth === 0) return true;
  }
  return false;
}

/** Remove a trailing `/` from the token list (for Express 4 `/:opt?` and `/*` sugar). */
function popTrailingSlash(tokens: PathToken[]): boolean {
  const last = tokens[tokens.length - 1];
  if (last && last.type === 'text' && last.value.endsWith('/')) {
    if (last.value.length === 1) tokens.pop();
    else last.value = last.value.slice(0, -1);
    return true;
  }
  return false;
}

function tokenizePath(src: string, wildCounter: { n: number }): PathToken[] {
  let i = 0;

  function consume(inGroup: boolean): PathToken[] {
    const out: PathToken[] = [];
    let text = '';
    const flush = (): void => {
      if (text) {
        const last = out[out.length - 1];
        if (last && last.type === 'text') last.value += text;
        else out.push({ type: 'text', value: text });
        text = '';
      }
    };

    while (i < src.length) {
      const ch = src[i];
      if (ch === '}' && inGroup) {
        i++;
        break;
      }
      if (ch === '\\' && i + 1 < src.length) {
        text += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '{' && hasMatchingBrace(src, i)) {
        flush();
        i++;
        out.push({ type: 'group', tokens: consume(true) });
        continue;
      }
      if (ch === ':' || ch === '*') {
        let name = '';
        let j = i + 1;
        PARAM_NAME_RE.lastIndex = j;
        const m = PARAM_NAME_RE.exec(src);
        if (m) {
          name = m[0];
          j += name.length;
        } else if (src[j] === '"') {
          // Express 5 quoted names: `:"param name"`.
          let k = j + 1;
          let quoted = '';
          while (k < src.length && src[k] !== '"') {
            if (src[k] === '\\' && k + 1 < src.length) k++;
            quoted += src[k++];
          }
          if (k < src.length && quoted) {
            name = quoted;
            j = k + 1;
          }
        }

        if (ch === ':') {
          if (!name) {
            text += ch;
            i++;
            continue;
          }
          let re: string | null = null;
          if (src[j] === '(') {
            const close = findMatchingParen(src, j);
            if (close !== -1) {
              re = src.slice(j + 1, close);
              j = close + 1;
            }
          }
          const param: PathToken = { type: 'param', name, re };
          if (src[j] === '?') {
            // Express 4 optional param: `/:id?` == `{/:id}`.
            j++;
            flush();
            const lead = popTrailingSlash(out);
            out.push({
              type: 'group',
              tokens: lead ? [{ type: 'text', value: '/' }, param] : [param],
            });
          } else {
            flush();
            out.push(param);
          }
          i = j;
          continue;
        }

        flush();
        if (name) {
          // Express 5 `*name`: one or more chars, captured as an array of segments.
          out.push({ type: 'wildcard', name, array: true, allowEmpty: false });
        } else {
          // Express 4 bare `*`: zero or more chars, string value, numeric key;
          // `/*` also matches the bare prefix (as rxpress always did).
          const wild: PathToken = {
            type: 'wildcard',
            name: String(wildCounter.n++),
            array: false,
            allowEmpty: true,
          };
          if (popTrailingSlash(out)) {
            out.push({ type: 'group', tokens: [{ type: 'text', value: '/' }, wild] });
          } else {
            out.push(wild);
          }
        }
        i = j;
        continue;
      }
      text += ch;
      i++;
    }
    flush();
    return out;
  }

  return consume(false);
}

/** Expand `{...}` groups into every with/without combination (group-included first). */
function flattenTokens(
  tokens: PathToken[],
  index: number,
  result: PathToken[],
  callback: (seq: PathToken[]) => void
): void {
  while (index < tokens.length) {
    const token = tokens[index++];
    if (token.type === 'group') {
      const len = result.length;
      const rest = index;
      flattenTokens(token.tokens, 0, result, (seq) => flattenTokens(tokens, rest, seq, callback));
      result.length = len;
      continue;
    }
    result.push(token);
  }
  callback(result);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+*?^${}()[\]|/\\-]/g, '\\$&');
}

/** A single-char regex matching anything that does not start `a` or `b` (path-to-regexp `negate`). */
function negate(a: string, b: string): string {
  if (b.length > a.length) return negate(b, a);
  if (a === b) b = '';
  if (b.length > 1) return `(?:(?!${escapeRegex(a)}|${escapeRegex(b)})[^])`;
  if (a.length > 1) return `(?:(?!${escapeRegex(a)})[^${escapeRegex(b)}])`;
  return `[^${escapeRegex(a + b)}]`;
}

function countCaptureGroups(re: string): number {
  try {
    return new RegExp(`${re}|`).exec('')!.length - 1;
  } catch {
    return 0;
  }
}

/** One flattened alternative → regex source (path-to-regexp `toRegExpSource`). */
function alternativeSource(
  tokens: PathToken[],
  keys: CompiledKey[],
  groupCounter: { n: number },
  originalPath: string
): string {
  const DELIM = '/';
  let result = '';
  let backtrack = '';
  let wildcardBacktrack = '';
  let prevCaptureType = 0; // 1 = param, 2 = wildcard
  let prevCustom = false;
  let hasSegmentCapture = 0;
  let index = 0;

  const hasWildcardLaterInSegment = (from: number): boolean => {
    while (from < tokens.length) {
      const t = tokens[from++];
      if (t.type === 'wildcard') return true;
      if (t.type === 'text' && t.value.includes(DELIM)) break;
    }
    return false;
  };
  const peekText = (from: number): string => {
    let s = '';
    while (from < tokens.length) {
      const t = tokens[from++];
      if (t.type !== 'text') break;
      s += t.value;
    }
    return s;
  };

  while (index < tokens.length) {
    const token = tokens[index++];
    if (token.type === 'text') {
      result += escapeRegex(token.value);
      backtrack += token.value;
      if (prevCaptureType === 2) wildcardBacktrack += token.value;
      if (token.value.includes(DELIM)) hasSegmentCapture = 0;
      continue;
    }
    if (token.type === 'group') continue; // unreachable after flattening

    const custom = token.type === 'param' && token.re !== null;
    // Express 4 forms (custom regex bodies, bare `*`) were always accepted back to back.
    const legacy = custom || (token.type === 'wildcard' && token.allowEmpty);
    if (prevCaptureType && !backtrack && !legacy && !prevCustom) {
      // Two adjacent captures are ambiguous; Express 5 rejects them too.
      throw new TypeError(
        `Missing text before "${token.name}" ${token.type} in path "${originalPath}"`
      );
    }

    let body: string;
    if (token.type === 'param') {
      if (token.re !== null) {
        body = token.re; // Express 4 `:id(regex)`: user-supplied body.
      } else if (hasSegmentCapture & 2) {
        body = `${negate(DELIM, backtrack)}+`;
      } else if (hasWildcardLaterInSegment(index)) {
        body = `${negate(DELIM, peekText(index))}+`;
      } else if (hasSegmentCapture & 1) {
        body = `${negate(DELIM, backtrack)}+|${escapeRegex(backtrack)}`;
      } else {
        body = `${negate(DELIM, '')}+`;
      }
      hasSegmentCapture |= prevCaptureType = 1;
    } else {
      const q = token.allowEmpty ? '*' : '+';
      body =
        hasSegmentCapture & 2
          ? `${negate(backtrack, '')}${q}`
          : wildcardBacktrack
            ? `${negate(wildcardBacktrack, '')}${q}|${negate(DELIM, '')}${q}`
            : `[^]${q}`;
      wildcardBacktrack = '';
      hasSegmentCapture |= prevCaptureType = 2;
    }
    result += `(${body})`;
    keys.push({
      name: token.name,
      array: token.type === 'wildcard' && token.array,
      group: ++groupCounter.n,
    });
    if (custom) groupCounter.n += countCaptureGroups(token.re!);
    prevCustom = legacy;
    backtrack = '';
  }
  return result;
}

function compilePathSource(path: string, keys: CompiledKey[]): string {
  const tokens = tokenizePath(path, { n: 0 });
  const groupCounter = { n: 0 };
  const alternatives: string[] = [];
  flattenTokens(tokens, 0, [], (seq) => {
    if (alternatives.length >= MAX_PATH_COMBINATIONS) {
      throw new TypeError(`Too many path combinations in path "${path}"`);
    }
    alternatives.push(alternativeSource(seq, keys, groupCounter, path));
  });
  return alternatives.length === 1 ? alternatives[0] : `(?:${alternatives.join('|')})`;
}

/**
 * Compile Express 4 & 5 path patterns into a fast matcher supporting:
 * - Static paths (`/users`)
 * - Parameters (`/users/:id/posts/:postId`) and multi-param segments (`/flights/:from-:to`)
 * - Optional parameters (`/users/:id?`) and Express 5 optional braces (`/opt{/:opt}`)
 * - Express 4 (`*`) and Express 5 (`*splat`) wildcards
 * - RegExp paths (`/^\/commits\/(\w+)$/`)
 * @internal
 */
export function compilePathMatcher(
  path: string | RegExp,
  options: { end: boolean; sensitive?: boolean; strict?: boolean }
): CompiledPathMatcher {
  const sensitive = Boolean(options.sensitive);
  const strict = Boolean(options.strict);
  const end = options.end;

  if (path instanceof RegExp) {
    // router@2: a named group takes its name, unnamed groups are numbered 0, 1, ... among
    // themselves.
    const names: string[] = [];
    const groupRe = /\((?:\?<(.*?)>)?(?!\?)/g;
    let unnamed = 0;
    for (let g = groupRe.exec(path.source); g !== null; g = groupRe.exec(path.source)) {
      names.push(g[1] || String(unnamed++));
    }
    return {
      raw: path,
      isPrefix: !end,
      match(input: string): PathMatchResult | null {
        const m = path.exec(input);
        if (!m) return null;
        if (!end) {
          // A mount path must match a prefix of the path, ending at a segment boundary.
          if (m.index !== 0) return null;
          const c = input.charCodeAt(m[0].length);
          if (m[0].length !== 0 && c === c && c !== 0x2f) return null;
        }
        const params: Record<string, string> = Object.create(null);
        for (let i = 1; i < m.length; i++) {
          const name = names[i - 1] ?? String(i - 1);
          if (m[i] !== undefined && !isUnsafeKey(name)) {
            params[name] = safeDecode(m[i]);
          }
        }
        return { matched: true, matchedPath: m[0], params };
      },
    };
  }

  // Fast exact/prefix match for "/"
  if (path === '/' && !end) {
    return {
      raw: path,
      isPrefix: true,
      match(): PathMatchResult {
        return { matched: true, matchedPath: '', params: Object.create(null) };
      },
    };
  }

  // Fast static path without params/wildcards/regex/brace syntax
  if (
    !path.includes(':') &&
    !path.includes('*') &&
    !path.includes('?') &&
    !path.includes('(') &&
    !path.includes('+') &&
    !path.includes('[') &&
    !path.includes('{') &&
    !path.includes('}') &&
    !path.includes('\\')
  ) {
    // Express `loosen()`: non-strict layers drop ALL trailing slashes (`'//'` -> `''`), then
    // path-to-regexp 8 allows one optional trailing `/` (`trailing: !strict`).
    const cleanTarget = !strict && path.length > 1 ? path.replace(/\/+$/, '') : path;
    const cmpTarget = sensitive ? cleanTarget : cleanTarget.toLowerCase();
    const targetLen = cmpTarget.length;

    return {
      raw: path,
      isPrefix: !end,
      match(input: string): PathMatchResult | null {
        const cmpInput = sensitive ? input : input.toLowerCase();
        if (cmpInput === cmpTarget) {
          return { matched: true, matchedPath: input, params: Object.create(null) };
        }
        if (!cmpInput.startsWith(cmpTarget) || cmpInput.charCodeAt(targetLen) !== 0x2f) {
          return null;
        }
        // Input is `target/...`.
        if (end) {
          return !strict && cmpInput.length === targetLen + 1
            ? { matched: true, matchedPath: input, params: Object.create(null) }
            : null;
        }
        return {
          matched: true,
          matchedPath: input.slice(0, targetLen),
          params: Object.create(null),
        };
      },
    };
  }

  // General Express 4 & 5 path-to-regex compiler (backtracking-safe, see compilePathSource)
  const keys: CompiledKey[] = [];
  // Express `loosen()`: non-strict routers ignore trailing slashes on the route path.
  const normalized = !strict && path.length > 1 ? path.replace(/\/+$/, '') : path;

  let pattern = '^' + compilePathSource(normalized, keys);
  if (pattern === '^') {
    pattern = '^/';
  }

  if (end) {
    if (pattern === '^/') {
      pattern += '$';
    } else {
      pattern += strict ? '$' : '/?$';
    }
  } else {
    // path-to-regexp 8 `trailing: !strict`: a prefix may swallow one final `/` (`/x//` -> `/x/`).
    pattern += strict ? '(?=/|$)' : '(?:/$)?(?=/|$)';
  }

  const regex = new RegExp(pattern, sensitive ? '' : 'i');
  const keyCount = keys.length;

  return {
    raw: path,
    isPrefix: !end,
    match(input: string): PathMatchResult | null {
      const m = regex.exec(input);
      if (!m) return null;
      const params: Record<string, string> = Object.create(null);
      for (let i = 0; i < keyCount; i++) {
        const key = keys[i];
        const val = m[key.group];
        if (val !== undefined && !isUnsafeKey(key.name)) {
          params[key.name] = key.array
            ? (val.split('/').map(safeDecode) as unknown as string)
            : safeDecode(val);
        }
      }
      return { matched: true, matchedPath: m[0], params };
    },
  };
}

/** Express `decodeParam`: a malformed escape is a client error (400), never passed through raw. */
function safeDecode(s: string): string {
  if (s.indexOf('%') === -1) return s;
  try {
    return decodeURIComponent(s);
  } catch (err) {
    if (err instanceof URIError) {
      err.message = `Failed to decode param '${s}'`;
      (err as URIError & { status: number; statusCode: number }).status = 400;
      (err as URIError & { status: number; statusCode: number }).statusCode = 400;
    }
    throw err;
  }
}
