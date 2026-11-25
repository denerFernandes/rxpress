/**
 * Fast-route compilation: eligible top-level routes are registered in the engine's matchit radix
 * tree (so the engine resolves the route id) and pre-flattened into a JS handler chain, as long as
 * matchit's priority order can never differ from Express's registration order.
 */
import { types as utilTypes } from 'node:util';
import type { NativeServerConfig, NativeServerInstance } from '../native.js';
import { staticExtraMeta } from '../middleware.js';
import type { AnyHandler, Layer, Route, Router } from '../router.js';
import type { RequestHandler } from '../types.js';
import { registerRouteBodyRules, registerTopLevelBodyRules } from './body-rules.js';

export interface CompiledFastRoute {
  chain: AnyHandler[];
  directFn: RequestHandler | null;
  isAsyncDirect: boolean;
  routeObj: Route | undefined;
  nextLayerIdx: number;
  /**
   * Router stack index to resume from when `chain[k]` fails: an app-level middleware's error
   * must reach the error handlers registered between it and the route, as in Express.
   */
  errorNextIdx: number[];
}

type Seg = { kind: 'lit'; val: string } | { kind: 'param' } | { kind: 'wild' };

function parseMatchitSegments(path: string): Seg[] | null {
  if (
    !path.startsWith('/') ||
    path.includes('{') ||
    path.includes('}') ||
    path.includes('?') ||
    path.includes('(') ||
    path.includes('+') ||
    path.includes('[')
  ) {
    return null;
  }
  const clean = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (clean === '/') return [];
  const rawSegs = clean.split('/').slice(1);
  const segs: Seg[] = [];
  for (let i = 0; i < rawSegs.length; i++) {
    const s = rawSegs[i];
    if (s.startsWith('*')) {
      segs.push({ kind: 'wild' });
    } else if (s.startsWith(':')) {
      segs.push({ kind: 'param' });
    } else if (s.includes(':') || s.includes('*')) {
      return null;
    } else {
      segs.push({ kind: 'lit', val: s });
    }
  }
  return segs;
}

function methodsConflict(m1: string, m2: string): boolean {
  if (m1 === 'ALL' || m2 === 'ALL') return true;
  if (m1 === m2) return true;
  if ((m1 === 'GET' && m2 === 'HEAD') || (m1 === 'HEAD' && m2 === 'GET')) return true;
  return false;
}

function canOverlap(s1: Seg[] | null, s2: Seg[] | null, caseSensitive: boolean): boolean {
  if (s1 === null || s2 === null) return true;
  const maxLen = Math.max(s1.length, s2.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < s1.length && s1[i].kind === 'wild') return true;
    if (i < s2.length && s2[i].kind === 'wild') return true;
    if (i >= s1.length || i >= s2.length) return false;
    const a = s1[i];
    const b = s2[i];
    if (a.kind === 'lit' && b.kind === 'lit') {
      const eq = caseSensitive ? a.val === b.val : a.val.toLowerCase() === b.val.toLowerCase();
      if (!eq) return false;
    }
  }
  return true;
}

function segRank(kind: Seg['kind']): number {
  return kind === 'lit' ? 2 : kind === 'param' ? 1 : 0;
}

function matchitWouldReorder(m1: string, s1: Seg[], m2: string, s2: Seg[]): boolean {
  if (m1 === 'ALL' && m2 !== 'ALL') return true;
  if (m1 === 'GET' && m2 === 'HEAD') return true;
  const minLen = Math.min(s1.length, s2.length);
  for (let i = 0; i < minLen; i++) {
    const r1 = segRank(s1[i].kind);
    const r2 = segRank(s2[i].kind);
    if (r2 > r1) return true;
    if (r2 < r1) return false;
  }
  if (s1.length > s2.length && s1[s1.length - 1]?.kind === 'wild') return true;
  return false;
}

interface EarlierRoute {
  method: string;
  segments: Seg[] | null;
  compiled: boolean;
}

/** Walk state of one `compileIntoNative()` pass over the top-level stack. */
interface CompileState {
  native: NativeServerInstance;
  caseSensitive: boolean;
  defaultBodyLimit: number;
  routeCounts: Map<string, number>;
  seenBodyRouters: Set<Router>;
  earlierRoutes: EarlierRoute[];
  globalPreMiddlewares: AnyHandler[];
  /** Stack index right after each entry of `globalPreMiddlewares`. */
  globalPreNextIdx: number[];
  seenJsMiddleware: boolean;
  seenRoute: boolean;
  blockedFastRouting: boolean;
  fastRoutes: CompiledFastRoute[];
}

/**
 * Register native body rules, static mounts and fast routes for `router` with the engine.
 * Returns the compiled fast routes, indexed by the route id the engine reports per request.
 */
export function compileIntoNative(
  router: Router,
  native: NativeServerInstance,
  nativeCfg: NativeServerConfig
): CompiledFastRoute[] {
  const stack = router.stack;

  const routeCounts = new Map<string, number>();
  for (const layer of stack) {
    if (layer.method !== null && typeof layer.path === 'string') {
      const key = `${layer.method}:${layer.path}`;
      routeCounts.set(key, (routeCounts.get(key) || 0) + 1);
    }
  }

  const st: CompileState = {
    native,
    caseSensitive: Boolean(nativeCfg.caseSensitive),
    defaultBodyLimit: nativeCfg.defaultBodyLimitBytes ?? 1024 * 1024,
    routeCounts,
    seenBodyRouters: new Set<Router>([router]),
    earlierRoutes: [],
    globalPreMiddlewares: [],
    globalPreNextIdx: [],
    seenJsMiddleware: false,
    seenRoute: false,
    blockedFastRouting: router.params.size > 0,
    fastRoutes: [],
  };

  for (let i = 0; i < stack.length; i++) {
    compileLayer(st, stack[i], i);
  }

  return st.fastRoutes;
}

function compileLayer(st: CompileState, layer: Layer, i: number): void {
  // 1. Global native body parser rules & recursive sub-router body rules
  registerTopLevelBodyRules(st.native, layer, st.defaultBodyLimit, st.seenBodyRouters);

  // 2. Native Rust static file mounts (when before JS middlewares/routes & no custom setHeaders)
  if (tryAddNativeStatic(st, layer)) return;

  // 3. Track middleware & sub-router layers
  if (layer.method === null) {
    trackMiddlewareLayer(st, layer, i);
    return;
  }

  st.seenRoute = true;

  // 4. Register route-level native body parser rules (e.g. `app.post('/echo', express.json(), fn)`)
  registerRouteBodyRules(st.native, layer, st.defaultBodyLimit);

  // 5. Compile eligible top-level routes into Rust's matchit radix tree preserving registration order
  const curSegments = typeof layer.path === 'string' ? parseMatchitSegments(layer.path) : null;
  let compiled = false;
  if (canCompileRoute(st, layer, curSegments) && typeof layer.path === 'string') {
    compiled = addFastRoute(st, layer, i);
  }

  st.earlierRoutes.push({
    method: layer.method!,
    segments: curSegments,
    compiled,
  });
}

function tryAddNativeStatic(st: CompileState, layer: Layer): boolean {
  if (layer.nativeMeta?.__rxNativeKind === 'static' && layer.nativeMeta.staticConfig) {
    const sc = layer.nativeMeta.staticConfig;
    if (!st.seenJsMiddleware && !st.seenRoute && !sc.hasSetHeaders && typeof layer.path === 'string') {
      const extra =
        typeof layer.handle === 'function'
          ? staticExtraMeta.get(layer.handle as RequestHandler)
          : undefined;
      st.native.addStatic({
        prefix: layer.path,
        root: sc.root,
        index: sc.index,
        maxAgeSecs: sc.maxAgeSecs,
        etag: sc.etag,
        lastModified: sc.lastModified,
        dotfiles: sc.dotfiles,
        fallthrough: sc.fallthrough,
        extensions: sc.extensions,
        immutable: extra?.immutable,
        redirect: extra?.redirect,
      });
      return true;
    }
  }
  return false;
}

function trackMiddlewareLayer(st: CompileState, layer: Layer, i: number): void {
  if (layer.isErrorHandler) {
    return;
  }
  st.seenJsMiddleware = true;
  if (!layer.isRouter && layer.path === '/') {
    st.globalPreMiddlewares.push(layer.handle as AnyHandler);
    st.globalPreNextIdx.push(i + 1);
  } else if (layer.isRouter) {
    st.blockedFastRouting = true;
  } else {
    // Path-scoped middleware: mark overlapping prefix as uncompiled
    let mwSegs: Seg[] | null = null;
    if (typeof layer.path === 'string') {
      const parsed = parseMatchitSegments(layer.path);
      if (parsed !== null) {
        mwSegs = [...parsed, { kind: 'wild' }];
      }
    }
    st.earlierRoutes.push({
      method: 'ALL',
      segments: mwSegs,
      compiled: false,
    });
  }
}

function canCompileRoute(st: CompileState, layer: Layer, curSegments: Seg[] | null): boolean {
  let canCompile =
    !st.blockedFastRouting &&
    typeof layer.path === 'string' &&
    !layer.isErrorHandler &&
    layer.method !== 'ALL' &&
    curSegments !== null;

  if (canCompile) {
    const key = `${layer.method}:${layer.path as string}`;
    if ((st.routeCounts.get(key) || 0) > 1) {
      canCompile = false;
    }
  }

  if (canCompile && curSegments !== null) {
    const earlierRoutes = st.earlierRoutes;
    for (let p = 0; p < earlierRoutes.length; p++) {
      const prev = earlierRoutes[p];
      if (!methodsConflict(prev.method, layer.method!)) continue;
      if (!canOverlap(prev.segments, curSegments, st.caseSensitive)) continue;
      if (!prev.compiled) {
        canCompile = false;
        break;
      }
      if (
        prev.segments !== null &&
        matchitWouldReorder(prev.method, prev.segments, layer.method!, curSegments)
      ) {
        canCompile = false;
        break;
      }
    }
  }
  return canCompile;
}

function addFastRoute(st: CompileState, layer: Layer, i: number): boolean {
  const fastRoutes = st.fastRoutes;
  const globalPreMiddlewares = st.globalPreMiddlewares;
  const routeId = fastRoutes.length;
  const accepted = st.native.addRoute(layer.method!, layer.path as string, routeId);
  if (!accepted) return false;

  const chain: AnyHandler[] = globalPreMiddlewares.slice();
  const preNext = st.globalPreNextIdx;
  let hasRouteErrorHandler = false;
  if (layer.isRoute && layer.route) {
    for (const sub of layer.route.stack) {
      if (sub.handle.length === 4) {
        hasRouteErrorHandler = true;
        break;
      }
      chain.push(sub.handle);
    }
  } else {
    chain.push(layer.handle as AnyHandler);
  }

  if (hasRouteErrorHandler) {
    fastRoutes.push({
      chain: [...globalPreMiddlewares, layer.handle as AnyHandler],
      directFn: null,
      isAsyncDirect: false,
      routeObj: layer.route,
      nextLayerIdx: i + 1,
      errorNextIdx: [...preNext, i + 1],
    });
  } else {
    const directFn = chain.length === 1 ? (chain[0] as RequestHandler) : null;
    const isAsyncDirect =
      directFn !== null &&
      (utilTypes.isAsyncFunction(directFn) || directFn.length >= 3);
    fastRoutes.push({
      chain,
      directFn,
      isAsyncDirect,
      routeObj: layer.route,
      nextLayerIdx: i + 1,
      errorNextIdx: chain.map((_, k) => (k < preNext.length ? preNext[k] : i + 1)),
    });
  }
  return true;
}
