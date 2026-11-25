/**
 * Native body-parser rules: `express.json()`/`urlencoded()`/`text()`/`raw()` layers found in the
 * router tree are registered with the engine so it can buffer and parse those bodies before the
 * request reaches JS.
 */
import type { NativeServerInstance } from '../native.js';
import { nativeMiddlewareMeta } from '../middleware.js';
import {
  BODY_MODE_JSON,
  BODY_MODE_RAW,
  BODY_MODE_TEXT,
  BODY_MODE_URLENCODED,
} from '../protocol.js';
import type { Layer, Router } from '../router.js';
import type { NativeMiddlewareMeta } from '../types.js';

export function hasDynamicSegments(prefix: string): boolean {
  return prefix.includes(':') || prefix.includes('*');
}

export function joinBodyRulePattern(
  base: string,
  mount: string | RegExp
): { prefix: string; isDynamic: boolean } {
  if (mount instanceof RegExp) {
    return { prefix: base, isDynamic: true };
  }
  if (mount === '/' || mount === '') {
    return { prefix: base, isDynamic: false };
  }
  const segs = mount.split('/').filter(Boolean);
  const cleanSegs = base === '/' ? [] : base.split('/').filter(Boolean);
  let isDynamic = false;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (
      s.includes('?') ||
      s.includes('(') ||
      s.includes('+') ||
      s.includes('[') ||
      s.includes('{') ||
      s.includes('}') ||
      ((s.includes(':') || s.includes('*')) && !s.startsWith(':') && !s.startsWith('*'))
    ) {
      isDynamic = true;
      break;
    }
    cleanSegs.push(s);
  }
  return {
    prefix: cleanSegs.length === 0 ? '/' : '/' + cleanSegs.join('/'),
    isDynamic,
  };
}

export function registerNativeBodyRule(
  native: NativeServerInstance,
  meta: NativeMiddlewareMeta,
  prefix: string
): void {
  const kind = meta.__rxNativeKind;
  if (kind === 'static') return;
  const mode =
    kind === 'json'
      ? BODY_MODE_JSON
      : kind === 'urlencoded'
        ? BODY_MODE_URLENCODED
        : kind === 'text'
          ? BODY_MODE_TEXT
          : BODY_MODE_RAW;
  native.addBodyRule({
    prefix,
    mode,
    limit: meta.limit ?? 102400,
    contentTypes: meta.contentTypes ?? [],
  });
}

/** Register the body parsers of a route's own stack (e.g. `app.post('/echo', express.json(), fn)`). */
function registerRouteStackBodyRules(
  native: NativeServerInstance,
  layer: Layer,
  prefix: string,
  isPatterned: boolean,
  defaultBodyLimit: number
): void {
  for (const sub of layer.route!.stack) {
    const meta = nativeMiddlewareMeta.get(sub.handle);
    if (meta && meta.__rxNativeKind !== 'static') {
      if (!isPatterned || (meta.limit ?? 102400) > defaultBodyLimit) {
        registerNativeBodyRule(native, meta, prefix);
      }
    }
  }
}

export function collectSubRouterBodyRules(
  native: NativeServerInstance,
  router: Router,
  basePrefix: string,
  hasDynamic: boolean,
  defaultBodyLimit: number,
  seenRouters: Set<Router>
): void {
  if (seenRouters.has(router)) return;
  const nextSeen = new Set(seenRouters);
  nextSeen.add(router);

  for (const layer of router.stack) {
    const joined = joinBodyRulePattern(basePrefix, layer.path);
    const nextPrefix = hasDynamic ? basePrefix : joined.prefix;
    const nextDynamic = hasDynamic || joined.isDynamic;
    const isPatterned = nextDynamic || hasDynamicSegments(nextPrefix);

    if (layer.isRouter && layer.handle) {
      collectSubRouterBodyRules(
        native,
        layer.handle as Router,
        nextPrefix,
        nextDynamic,
        defaultBodyLimit,
        nextSeen
      );
    } else if (layer.method === null && layer.nativeMeta && layer.nativeMeta.__rxNativeKind !== 'static') {
      if (!isPatterned || (layer.nativeMeta.limit ?? 102400) > defaultBodyLimit) {
        registerNativeBodyRule(native, layer.nativeMeta, nextPrefix);
      }
    } else if (layer.isRoute && layer.route) {
      registerRouteStackBodyRules(native, layer, nextPrefix, isPatterned, defaultBodyLimit);
    } else if (typeof layer.handle === 'function') {
      const meta = nativeMiddlewareMeta.get(layer.handle);
      if (meta && meta.__rxNativeKind !== 'static') {
        if (!isPatterned || (meta.limit ?? 102400) > defaultBodyLimit) {
          registerNativeBodyRule(native, meta, nextPrefix);
        }
      }
    }
  }
}

/** Global native body parser rules & recursive sub-router body rules of a top-level layer. */
export function registerTopLevelBodyRules(
  native: NativeServerInstance,
  layer: Layer,
  defaultBodyLimit: number,
  seenBodyRouters: Set<Router>
): void {
  if (layer.nativeMeta && layer.nativeMeta.__rxNativeKind !== 'static') {
    const joined = joinBodyRulePattern('/', layer.path);
    const isPatterned = joined.isDynamic || hasDynamicSegments(joined.prefix);
    if (!isPatterned || (layer.nativeMeta.limit ?? 102400) > defaultBodyLimit) {
      registerNativeBodyRule(native, layer.nativeMeta, joined.prefix);
    }
  }
  if (layer.isRouter && layer.handle) {
    const joined = joinBodyRulePattern('/', layer.path);
    collectSubRouterBodyRules(
      native,
      layer.handle as Router,
      joined.prefix,
      joined.isDynamic,
      defaultBodyLimit,
      seenBodyRouters
    );
  }
}

/** Route-level native body parser rules of a top-level route layer. */
export function registerRouteBodyRules(
  native: NativeServerInstance,
  layer: Layer,
  defaultBodyLimit: number
): void {
  if (layer.isRoute && layer.route && typeof layer.path === 'string') {
    const joined = joinBodyRulePattern('/', layer.path);
    const isPatterned = joined.isDynamic || hasDynamicSegments(joined.prefix);
    registerRouteStackBodyRules(native, layer, joined.prefix, isPatterned, defaultBodyLimit);
  }
}
