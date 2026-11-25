import { Application, createApplication, createHttpsServer, type HttpsServer } from './application.js';
import { json, raw, serveStatic, text, urlencoded } from './middleware.js';
import { createRouter, Route, Router } from './router.js';
import { RxRequest } from './request.js';
import { RxResponse } from './response.js';
import type { RouterOptions } from './types.js';
import { installNodeServerInterception, RxServer } from './node-server.js';

// `http.createServer(app)` / `https.createServer(opts, app)` run rxpress apps on the native engine.
installNodeServerInterception();

export interface RxpressFactory {
  (): Application;
  /** Express parity: the prototypes apps/requests/responses inherit from (extend them freely). */
  application: Application;
  request: RxRequest;
  response: RxResponse;
  Router: (options?: RouterOptions) => Router;
  Route: typeof Route;
  json: typeof json;
  urlencoded: typeof urlencoded;
  text: typeof text;
  raw: typeof raw;
  static: typeof serveStatic;
  createHttpsServer: typeof createHttpsServer;
}

const rxpress: RxpressFactory = Object.assign(createApplication, {
  application: Application.prototype,
  request: RxRequest.prototype,
  response: RxResponse.prototype,
  Router: createRouter,
  Route,
  json,
  urlencoded,
  text,
  raw,
  static: serveStatic,
  createHttpsServer,
});

export default rxpress;
export {
  rxpress,
  createApplication,
  createHttpsServer,
  Application,
  Router,
  Route,
  createRouter,
  RxRequest,
  RxResponse,
  RxServer,
  json,
  urlencoded,
  text,
  raw,
  serveStatic,
};

export type { HttpsServer };

export type {
  Request,
  Response,
  NextFunction,
  RequestHandler,
  ErrorRequestHandler,
  NodeMiddleware,
  MiddlewareLike,
  PathParams,
  ParamHandler,
  RouterOptions,
  JsonOptions,
  UrlencodedOptions,
  TextOptions,
  RawOptions,
  StaticOptions,
  CookieOptions,
  SendFileOptions,
  TlsOptions,
  AddressInfo,
  ServerHandle,
} from './types.js';
