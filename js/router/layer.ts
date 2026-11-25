import type { Application } from '../application.js';
import type { Route, Router } from '../router.js';
import type { ErrorRequestHandler, NativeMiddlewareMeta, RequestHandler } from '../types.js';
import type { CompiledPathMatcher } from './path-compile.js';

/** @internal */
export type AnyHandler = RequestHandler | ErrorRequestHandler;

/** @internal */
export interface Layer {
  path: string | RegExp;
  matcher: CompiledPathMatcher;
  method: string | null; // null = middleware (`use`), 'ALL' = `all`, or uppercase HTTP verb
  handle: AnyHandler | Router;
  isErrorHandler: boolean;
  isRouter: boolean;
  isRoute: boolean;
  route?: Route;
  subApp?: Application;
  nativeMeta?: NativeMiddlewareMeta;
}
