// Mounting an app built with another copy of Express (`require('express')()` from a package that
// bundles its own Express, a codebase without the npm alias...). Express sub-app semantics:
//
// - `'mount'` is emitted with the rxpress app as parent. Express then re-parents the sub-app's
//   `request`/`response`/`settings` prototypes onto the parent's, so when its `handle()` swaps
//   `req`/`res` onto them the rxpress request/response API stays in the chain, and unset settings
//   fall back to the rxpress app's (exactly what Express does for its own sub-apps).
// - Every call restores the original `req`/`res` prototypes before handing control back with
//   `next()`, like Express's `mounted_app`.
// - While the sub-app runs, `req.app`/`res.app` are the sub-app (Express semantics). The rxpress
//   request/response read a few cached settings off `app`; the sub-app gets those as accessors
//   over its own `get()`, so its settings (and, through Express's inheritance, the parent's)
//   apply: `json spaces`, `trust proxy`, `query parser`...

const MOUNTED = Symbol.for('rxpress.foreignApp');

type NextFn = (err?: unknown) => void;

interface ForeignApp {
  (req: unknown, res: unknown, next?: NextFn): void;
  handle(req: unknown, res: unknown, next: NextFn): void;
  set(...args: unknown[]): unknown;
  get(setting: string): unknown;
  emit?(event: string, ...args: unknown[]): unknown;
  mountpath?: unknown;
  parent?: unknown;
}

/** The cached settings rxpress reads off `req.app`/`res.app` (see Application). */
const SETTING_ACCESSORS: Record<string, (app: ForeignApp) => unknown> = {
  _trustProxyFn: (app) => {
    const fn = app.get('trust proxy fn');
    return typeof fn === 'function' ? fn : null;
  },
  _trustProxy: (app) => Boolean(app.get('trust proxy')),
  _queryParserFn: (app) => {
    const fn = app.get('query parser fn');
    return typeof fn === 'function' ? fn : undefined;
  },
  _queryParserMode: (app) => {
    const mode = app.get('query parser');
    return mode === false ? false : mode === 'simple' ? 'simple' : 'extended';
  },
  _jsonSpaces: (app) => app.get('json spaces'),
  _jsonReplacer: (app) => app.get('json replacer'),
  _xPoweredBy: (app) => Boolean(app.get('x-powered-by')),
};

function installSettingAccessors(app: ForeignApp): void {
  for (const key of Object.keys(SETTING_ACCESSORS)) {
    if (Object.prototype.hasOwnProperty.call(app, key)) continue;
    const read = SETTING_ACCESSORS[key];
    Object.defineProperty(app, key, {
      configurable: true,
      enumerable: false,
      get(this: ForeignApp) {
        return read(this);
      },
    });
  }
}

type Mounted = ((req: object, res: object, next: NextFn) => void) & { [MOUNTED]?: true };

/** An Express application that is not an rxpress app (same test Express itself uses). */
export function isForeignExpressApp(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  const f = fn as unknown as Record<string | symbol, unknown>;
  return (
    f.__isRxApp !== true &&
    f[MOUNTED] !== true &&
    typeof f.handle === 'function' &&
    typeof f.set === 'function'
  );
}

/**
 * Wrap a foreign Express app for `use()`. With `parent`, it is mounted now (Express timing: at
 * `use()`); without one (mounted on a bare Router) it is mounted under `req.app` on first use.
 */
export function mountForeignApp(fn: unknown, path: unknown, parent: object | null): Mounted {
  const app = fn as ForeignApp;
  let mounted = false;
  const mount = (p: object): void => {
    mounted = true;
    app.mountpath = path;
    app.parent = p;
    if (typeof app.emit === 'function') app.emit('mount', p);
  };
  installSettingAccessors(app);
  if (parent !== null) mount(parent);
  const wrapper: Mounted = function mounted_app(req, res, next) {
    const rq = req as { app: unknown };
    const rs = res as { app: unknown };
    if (!mounted) mount(rq.app as object);
    const reqProto = Object.getPrototypeOf(req) as object | null;
    const resProto = Object.getPrototypeOf(res) as object | null;
    const reqApp = rq.app;
    const resApp = rs.app;
    rq.app = app;
    rs.app = app;
    app.handle(req, res, (err?: unknown) => {
      Object.setPrototypeOf(req, reqProto);
      Object.setPrototypeOf(res, resProto);
      rq.app = reqApp;
      rs.app = resApp;
      next(err);
    });
  };
  wrapper[MOUNTED] = true;
  return wrapper;
}
