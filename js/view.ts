// Express's view lookup (lib/view.js): `app.set('view', View)` can replace it, exactly as in Express.
import { statSync, type Stats } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { resolveCurrentDir } from './native.js';

export type ViewEngine = (
  path: string,
  options: Record<string, unknown>,
  callback: (err: Error | null, rendered?: string) => void
) => void;

export interface ViewOptions {
  defaultEngine?: string;
  root: string | string[];
  engines: Record<string, ViewEngine>;
}

/** Load `<ext>`'s `__express` like Express (from rxpress's install, then the app's cwd). */
function loadEngine(mod: string): unknown {
  const bases = [join(resolveCurrentDir(), 'package.json'), join(process.cwd(), 'package.json')];
  let lastErr: unknown;
  for (const base of bases) {
    try {
      return createRequire(base)(mod);
    } catch (err) {
      lastErr = err;
      if ((err as { code?: string }).code !== 'MODULE_NOT_FOUND') throw err;
    }
  }
  throw lastErr;
}

function tryStat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

export class View {
  public defaultEngine: string | undefined;
  public ext: string;
  public name: string;
  public root: string | string[];
  public engine: ViewEngine;
  public path: string | undefined;

  constructor(name: string, options: ViewOptions) {
    const opts = options || ({} as ViewOptions);
    this.defaultEngine = opts.defaultEngine;
    this.ext = extname(name);
    this.name = name;
    this.root = opts.root;

    if (!this.ext && !this.defaultEngine) {
      throw new Error('No default engine was specified and no extension was provided.');
    }

    let fileName = name;
    if (!this.ext) {
      const def = this.defaultEngine as string;
      this.ext = def[0] !== '.' ? '.' + def : def;
      fileName += this.ext;
    }

    if (!opts.engines[this.ext]) {
      const mod = this.ext.slice(1);
      const fn = (loadEngine(mod) as { __express?: unknown }).__express;
      if (typeof fn !== 'function') {
        throw new Error('Module "' + mod + '" does not provide a view engine.');
      }
      opts.engines[this.ext] = fn as ViewEngine;
    }

    this.engine = opts.engines[this.ext];
    this.path = this.lookup(fileName);
  }

  /** First `root` holding `name` (or `name/index.<ext>`). */
  public lookup(name: string): string | undefined {
    let path: string | undefined;
    const roots = ([] as string[]).concat(this.root);
    for (let i = 0; i < roots.length && !path; i++) {
      const loc = resolve(roots[i], name);
      path = this.resolve(dirname(loc), basename(loc));
    }
    return path;
  }

  /** Render with the engine; the callback always runs asynchronously (Express semantics). */
  public render(options: Record<string, unknown>, callback: (err: Error | null, html?: string) => void): void {
    let sync = true;
    this.engine(this.path as string, options, function onRender(this: unknown, ...args: unknown[]) {
      if (!sync) {
        (callback as (...a: unknown[]) => void).apply(this, args);
        return;
      }
      process.nextTick(() => (callback as (...a: unknown[]) => void).apply(this, args));
    });
    sync = false;
  }

  public resolve(dir: string, file: string): string | undefined {
    const ext = this.ext;
    let path = join(dir, file);
    let stat = tryStat(path);
    if (stat && stat.isFile()) return path;
    path = join(dir, basename(file, ext), 'index' + ext);
    stat = tryStat(path);
    if (stat && stat.isFile()) return path;
    return undefined;
  }
}
