import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventEmitter } from 'node:events';
import type { RxRequest } from './request.js';
import type { RxResponse } from './response.js';
import type { Application } from './application.js';
import type { Router } from './router.js';

export type Request = RxRequest;
export type Response = RxResponse;

export type NextFunction = (err?: unknown) => void;

export type RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => unknown | Promise<unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ErrorRequestHandler<E = any> = (
  err: E,
  req: Request,
  res: Response,
  next: NextFunction
) => unknown | Promise<unknown>;

export type NodeMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  next: (err?: any) => void
) => unknown;

export type PathParams = string | RegExp | Array<string | RegExp>;

export type MiddlewareLike =
  | RequestHandler
  | ErrorRequestHandler
  | NodeMiddleware
  | Router
  | Application
  | MiddlewareLike[];

export type ParamHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
  value: string,
  name: string
) => unknown | Promise<unknown>;

export interface RouterOptions {
  caseSensitive?: boolean;
  mergeParams?: boolean;
  strict?: boolean;
}

export interface JsonOptions {
  /** Decode `Content-Encoding: deflate | gzip | br | zstd` bodies (default `true`). */
  inflate?: boolean;
  limit?: number | string;
  strict?: boolean;
  type?: string | string[] | ((req: Request) => boolean);
  reviver?: (key: string, value: unknown) => unknown;
  verify?: (req: Request, res: Response, buf: Buffer, encoding: string) => void;
}

export interface UrlencodedOptions {
  extended?: boolean;
  /** Decode `Content-Encoding: deflate | gzip | br | zstd` bodies (default `true`). */
  inflate?: boolean;
  limit?: number | string;
  parameterLimit?: number;
  type?: string | string[] | ((req: Request) => boolean);
  verify?: (req: Request, res: Response, buf: Buffer, encoding: string) => void;
}

export interface TextOptions {
  defaultCharset?: string;
  /** Decode `Content-Encoding: deflate | gzip | br | zstd` bodies (default `true`). */
  inflate?: boolean;
  limit?: number | string;
  type?: string | string[] | ((req: Request) => boolean);
  verify?: (req: Request, res: Response, buf: Buffer, encoding: string) => void;
}

export interface RawOptions {
  /** Decode `Content-Encoding: deflate | gzip | br | zstd` bodies (default `true`). */
  inflate?: boolean;
  limit?: number | string;
  type?: string | string[] | ((req: Request) => boolean);
  verify?: (req: Request, res: Response, buf: Buffer, encoding: string) => void;
}

export interface StaticOptions {
  acceptRanges?: boolean;
  cacheControl?: boolean;
  dotfiles?: 'allow' | 'deny' | 'ignore';
  etag?: boolean;
  extensions?: string | string[] | false;
  fallthrough?: boolean;
  immutable?: boolean;
  index?: boolean | string | string[];
  lastModified?: boolean;
  maxAge?: number | string;
  redirect?: boolean;
  setHeaders?: (res: Response, path: string, stat: import('node:fs').Stats) => void;
}

export interface CookieOptions {
  maxAge?: number;
  signed?: boolean;
  expires?: Date;
  httpOnly?: boolean;
  path?: string;
  domain?: string;
  secure?: boolean;
  encode?: (val: string) => string;
  sameSite?: boolean | 'lax' | 'strict' | 'none';
  priority?: 'low' | 'medium' | 'high';
  partitioned?: boolean;
}

export interface SendFileOptions {
  maxAge?: number | string;
  root?: string;
  lastModified?: boolean;
  headers?: Record<string, string | string[]>;
  dotfiles?: 'allow' | 'deny' | 'ignore';
  acceptRanges?: boolean;
  cacheControl?: boolean;
  immutable?: boolean;
  /** Byte offset to start at (`send`). */
  start?: number;
  /** Last byte offset to send, inclusive (`send`). */
  end?: number;
}

export interface TlsOptions {
  key: string | Buffer;
  cert: string | Buffer;
}

export interface AddressInfo {
  address: string;
  port: number;
  family: string;
}

export interface ServerHandle extends EventEmitter {
  address(): AddressInfo | null;
  close(callback?: (err?: Error) => void): Promise<void>;
  closeAllConnections(): void;
  closeIdleConnections(): void;
  ref(): this;
  unref(): this;
  setTimeout(msecs?: number, callback?: () => void): this;
  timeout: number;
  keepAliveTimeout: number;
  headersTimeout: number;
  requestTimeout: number;
  listening: boolean;
}

/** @internal */
export interface NativeMiddlewareMeta {
  __rxNativeKind: 'json' | 'urlencoded' | 'text' | 'raw' | 'static';
  limit?: number;
  contentTypes?: string[];
  staticConfig?: {
    root: string;
    index: string[];
    maxAgeSecs: number;
    etag: boolean;
    lastModified: boolean;
    dotfiles: string;
    fallthrough: boolean;
    extensions: string[];
    hasSetHeaders: boolean;
    /** Options only the JS path implements (`acceptRanges`/`cacheControl: false`). */
    jsOnly: boolean;
  };
}
