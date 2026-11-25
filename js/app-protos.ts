/*
 * Per-app `app.request` / `app.response` prototypes, as in Express (where every app has its own
 * pair inheriting from its parent's and the request is re-prototyped as it enters each app).
 *
 * Re-prototyping an object per request costs V8 its fast paths, so it only happens once some
 * app has touched `app.request`/`app.response`: until then `appProtos.active` is 0 and entering
 * an app is a plain `req.app = app`. A prototype nothing was defined on (Express reads the
 * parent's on 'mount', for example) is skipped: the request keeps the one it inherits from.
 */

/** @internal The app fields this module reads. */
export interface ProtoApp {
  _ownRequest: object | null;
  _ownResponse: object | null;
  parent?: unknown;
}

/** @internal */
export const appProtos = {
  /** Number of apps with their own request/response prototype. */
  active: 0,
  baseRequest: null as object | null,
  baseResponse: null as object | null,
};

function effective(app: ProtoApp, key: '_ownRequest' | '_ownResponse'): object | null {
  for (let a: ProtoApp | undefined = app; a; a = a.parent as ProtoApp | undefined) {
    const own = a[key];
    if (own !== null && own !== undefined && Reflect.ownKeys(own).length !== 0) return own;
  }
  return null;
}

/** @internal Gives `req`/`res` the prototypes of `app` (its own, an ancestor's or the base). */
export function applyAppProtos(req: object, res: object, app: ProtoApp): void {
  const rq = effective(app, '_ownRequest') ?? appProtos.baseRequest;
  const rs = effective(app, '_ownResponse') ?? appProtos.baseResponse;
  if (rq !== null && Object.getPrototypeOf(req) !== rq) Object.setPrototypeOf(req, rq);
  if (rs !== null && Object.getPrototypeOf(res) !== rs) Object.setPrototypeOf(res, rs);
}

/** @internal `req.app = res.app = app`, re-prototyping only when per-app prototypes exist. */
export function enterApp(
  req: { app: unknown },
  res: { app: unknown },
  app: ProtoApp
): void {
  req.app = app;
  res.app = app;
  if (appProtos.active !== 0) applyAppProtos(req, res, app);
}
