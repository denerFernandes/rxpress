import type { IncomingHttpHeaders } from 'node:http';
import type { Application } from './application.js';
import type { RxResponse } from './response.js';
import {
  BODY_MODE_JSON,
  BODY_MODE_RAW,
  BODY_MODE_STREAMED,
  BODY_MODE_TEXT,
  BODY_MODE_URLENCODED,
  METHODS,
} from './protocol.js';
import { parseQueryString, parseRangeHeader, type RangesResult } from './security.js';
import {
  addEventListener,
  countListeners,
  emitEvent,
  type EventListenerFn,
  getEventNames,
  getListeners,
  onceWrapper,
  removeAllEventListeners,
  removeEventListener,
} from './emitter.js';
import {
  type BodySource,
  collectBody,
  detachBody,
  emitReadable,
  finishRead,
  flow,
  iterateBody,
  markBodyConsumed,
  onBodyReady,
  onReadListener,
  type PipeDest,
  type PipeLink,
  pipeBody,
  readableLengthOf,
  readableStateOf,
  readBody,
  resumeBody,
  unpipeBody,
  wakeWaiter,
} from './request-body.js';
import {
  decodeHeaders,
  decodeParams,
  decodeRawHeaders,
  normalizeMimeShorthand,
  parseCookieHeader,
  parseRequestQuery,
  resolveSignedCookies,
} from './request-parse.js';
import {
  acceptsCharsetList,
  acceptsEncodingList,
  acceptsLanguageList,
  acceptsTypes,
  clientIpOf,
  hostnameOf,
  hostOf,
  ipsOf,
  isFresh,
  isType,
  isXhr,
  protocolOf,
  subdomainsOf,
} from './request-props.js';
import { RxSocket } from './socket.js';
import type { NextFunction } from './types.js';

export type { EventListenerFn };
/** @internal */
export type { BodySource } from './request-body.js';

const EMPTY_OBJ: Record<string, string> = Object.freeze({});

export { normalizeMimeShorthand, parseQueryString, RxSocket };

/**
 * Ultra-fast Express 4 & 5 + Node IncomingMessage-compatible Request object.
 * Decodes headers, query, params, url, and body lazily from the shared batch Buffer
 * so routes that don't inspect them pay ZERO allocation cost.
 */
export class RxRequest {
  // Binary batch slice references (monomorphic hidden class!)
  /** @internal */ public _reqId: number;
  /** @internal */ public _routeId: number;
  /** @internal */ public _buf: Buffer;
  /** @internal */ public _urlStart: number;
  /** @internal */ public _urlEnd: number;
  /** @internal */ public _pathLen: number;
  /** @internal */ public _remoteStart: number;
  /** @internal */ public _remoteEnd: number;
  /** @internal */ public _paramsStart: number;
  /** @internal */ public _paramsLen: number;
  /** @internal */ public _headersStart: number;
  /** @internal */ public _headersLen: number;
  /** @internal */ public _bodyStart: number;
  /** @internal */ public _bodyLen: number;
  /** @internal */ public _bodyMode: number;
  /** @internal */ public _isTls: boolean;
  /** @internal */ private _sliceStart = 0;
  /** @internal */ private _sliceEnd = 0;
  /** @internal */ private readonly _rootApp: Application;

  // Express & Node standard properties (all declared upfront for monomorphic hidden class)
  public app: Application;
  public res!: RxResponse;
  public method: string;
  public baseUrl = '';
  public route: unknown = undefined;
  public next: NextFunction | undefined = undefined;
  public httpVersion = '1.1';
  public httpVersionMajor = 1;
  public httpVersionMinor = 1;
  public readable = true;
  public readableEnded = false;
  public complete = true;
  public aborted = false;
  public destroyed = false;
  public secret: string | string[] | undefined = undefined;

  // Lazily populated fields
  /** @internal */ private _url: string | null = null;
  /** @internal */ private _originalUrl: string | null = null;
  /** @internal */ private _path: string | null = null;
  /** @internal */ private _remoteAddr: string | null = null;
  /** @internal */ private _params: Record<string, string> | null = null;
  /** @internal */ private _headers: IncomingHttpHeaders | null = null;
  /** @internal */ private _rawHeaders: string[] | null = null;
  /** @internal */ private _query: Record<string, unknown> | null = null;
  /** @internal */ private _body: unknown = undefined;
  /** @internal */ private _bodyInitialized = false;
  /** @internal */ private _cookies: Record<string, string> | null = null;
  /** @internal */ private _signedCookies: Record<string, unknown> | null = null;
  /** @internal */ public _socket: RxSocket | null = null;
  /** @internal */ public _optionsMethods: string[] | null = null;
  /** @internal */ public _listeners: Map<string, EventListenerFn[]> | null = null;
  /** @internal */ private _maxListeners = 10;
  // Readable state over the buffered body (see "Node Readable compatibility" below)
  /** @internal Bridged from a Node server whose caller passed `next` (see bridge.ts). */
  public _bridgeNext = false;
  /** @internal */ public _flowing: boolean | null = null;
  /** @internal */ public _chunkTaken = false;
  /** @internal */ public _flowScheduled = false;
  /** @internal */ public _endScheduled = false;
  /** @internal */ public _encoding: BufferEncoding | null = null;
  /** @internal */ public _pipes: PipeLink[] | null = null;
  // Streamed body (bodyMode 6): chunks pulled from the engine on demand, so a paused
  // consumer stops the engine reading the socket (TCP backpressure).
  /** @internal */ public _bodySrc: BodySource | null = null;
  /** @internal */ public _bodyQueue: Buffer[] | null = null;
  /** @internal */ public _bodyQueued = 0;
  /** @internal The engine has delivered the last byte (or the body was abandoned). */
  public _srcEnded = false;
  /** @internal Resolves a pending `for await` / collector step when more body arrives. */
  public _bodyWaiter: (() => void) | null = null;

  // Allow arbitrary user properties (e.g. `req.user`, `req.requestId`)
  [key: string]: unknown;

  /** @internal */
  constructor(
    app: Application,
    reqId: number, routeId: number, methodCode: number, methodStr: string | null,
    isTls: boolean, bodyMode: number, buf: Buffer,
    urlStart: number, urlEnd: number, pathLen: number, remoteStart: number, remoteEnd: number,
    paramsStart: number, paramsLen: number, headersStart: number, headersLen: number,
    bodyStart: number, bodyLen: number,
    sliceStart = 0, sliceEnd = 0
  ) {
    this._rootApp = app;
    this.app = app;
    this._reqId = reqId;
    this._routeId = routeId;
    this.method = methodCode < 7 ? METHODS[methodCode] : (methodStr ?? 'GET');
    this._isTls = isTls;
    this._bodyMode = bodyMode;
    this._buf = buf;
    this._urlStart = urlStart; this._urlEnd = urlEnd; this._pathLen = pathLen;
    this._remoteStart = remoteStart; this._remoteEnd = remoteEnd;
    this._paramsStart = paramsStart; this._paramsLen = paramsLen;
    this._headersStart = headersStart; this._headersLen = headersLen;
    this._bodyStart = bodyStart; this._bodyLen = bodyLen;
    this._sliceStart = sliceStart; this._sliceEnd = sliceEnd;
  }

  /**
   * Reset this pooled request instance for the next synchronous request in a batch (zero alloc!).
   * @internal
   */
  public _reset(
    reqId: number, routeId: number, methodCode: number, methodStr: string | null,
    isTls: boolean, bodyMode: number, buf: Buffer,
    urlStart: number, urlEnd: number, pathLen: number, remoteStart: number, remoteEnd: number,
    paramsStart: number, paramsLen: number, headersStart: number, headersLen: number,
    bodyStart: number, bodyLen: number,
    sliceStart: number, sliceEnd: number, res: RxResponse
  ): void {
    this.app = this._rootApp;
    this.res = res;
    this._reqId = reqId;
    this._routeId = routeId;
    this.method = methodCode < 7 ? METHODS[methodCode] : (methodStr ?? 'GET');
    this._isTls = isTls;
    this._bodyMode = bodyMode;
    this._buf = buf;
    this._urlStart = urlStart; this._urlEnd = urlEnd; this._pathLen = pathLen;
    this._remoteStart = remoteStart; this._remoteEnd = remoteEnd;
    this._paramsStart = paramsStart; this._paramsLen = paramsLen;
    this._headersStart = headersStart; this._headersLen = headersLen;
    this._bodyStart = bodyStart; this._bodyLen = bodyLen;
    this._sliceStart = sliceStart; this._sliceEnd = sliceEnd;
    this.baseUrl = '';
    this.route = undefined;
    this.next = undefined;
    this.httpVersion = '1.1';
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    // A body the engine already parsed for an rxpress body parser counts as consumed, exactly
    // as it is after body-parser read the stream in Express.
    const streamed = bodyMode === BODY_MODE_STREAMED;
    const consumed = bodyMode !== 0 && !streamed;
    this.readable = !consumed;
    this.readableEnded = consumed;
    this._chunkTaken = consumed;
    this.complete = !streamed;
    this.aborted = false;
    this.destroyed = false;
    this.secret = undefined;
    this._url = null;
    this._originalUrl = null;
    this._path = null;
    this._remoteAddr = null;
    this._params = null;
    this._headers = null;
    this._rawHeaders = null;
    this._query = null;
    this._body = undefined;
    this._bodyInitialized = false;
    this._cookies = null;
    this._signedCookies = null;
    this._socket = null;
    this._optionsMethods = null;
    this._listeners = null;
    this._maxListeners = 10;
    this._bridgeNext = false;
    this._flowing = null;
    this._flowScheduled = false;
    this._endScheduled = false;
    this._encoding = null;
    this._pipes = null;
    this._bodySrc = null;
    this._bodyQueue = streamed ? [] : null;
    this._bodyQueued = 0;
    this._srcEnded = !streamed;
    this._bodyWaiter = null;
  }

  /**
   * @internal Restore what the Node-side caller saw: peer address, TLS, and (when mounted in a
   * real Express app) the original URL and base URL. `url` stays the path the bridge forwarded.
   */
  public _applyBridge(
    peer: string,
    tls: boolean,
    originalUrl: string,
    baseUrl: string,
    hasNext: boolean
  ): void {
    this._url = this._buf.toString('utf8', this._urlStart, this._urlEnd);
    if (originalUrl) this._originalUrl = originalUrl;
    this.baseUrl = baseUrl;
    this._remoteAddr = peer;
    this._isTls = tls;
    this._bridgeNext = hasNext;
  }

  get originalUrl(): string {
    if (this._originalUrl === null) {
      this._originalUrl = this._buf.toString('utf8', this._urlStart, this._urlEnd);
    }
    return this._originalUrl;
  }

  set originalUrl(val: string) { this._originalUrl = val; }

  get url(): string {
    if (this._url === null) {
      this._url = this.originalUrl;
    }
    return this._url;
  }

  set url(val: string) {
    this._url = val;
    const qIdx = val.indexOf('?');
    this._path = qIdx === -1 ? val : val.slice(0, qIdx);
  }

  get path(): string {
    if (this._path === null) {
      this._path = this._buf.toString(
        'utf8',
        this._urlStart,
        this._urlStart + this._pathLen
      );
    }
    return this._path;
  }

  get params(): Record<string, string> {
    if (this._params !== null) return this._params;
    const out = decodeParams(this._buf, this._paramsStart, this._paramsLen);
    this._params = out;
    return out;
  }

  set params(val: Record<string, string>) { this._params = val; }

  get headers(): IncomingHttpHeaders {
    if (this._headers !== null) return this._headers;
    const out = decodeHeaders(this._buf, this._headersStart, this._headersLen);
    this._headers = out;
    return out;
  }

  get rawHeaders(): string[] {
    if (this._rawHeaders !== null) return this._rawHeaders;
    const arr = decodeRawHeaders(this._buf, this._headersStart, this._headersLen);
    this._rawHeaders = arr;
    return arr;
  }

  get query(): Record<string, unknown> {
    if (this._query !== null) return this._query;
    const parsed = parseRequestQuery(this);
    this._query = parsed;
    return parsed;
  }

  set query(val: Record<string, unknown>) { this._query = val; }

  /**
   * Raw body Buffer slice (zero-copy subarray of the batch Buffer).
   * @internal
   */
  public _getRawBody(): Buffer {
    if (this._bodyLen === 0) return Buffer.alloc(0);
    return this._buf.subarray(this._bodyStart, this._bodyStart + this._bodyLen);
  }

  /**
   * Like Express 5: `undefined` until a body-parser middleware (or the user) sets it. The engine
   * may have pre-read the bytes for a parser rule, but only the parser middleware actually in
   * this request's chain parses them (honouring its verify/limit/strict/charset options).
   */
  get body(): unknown { return this._body; }

  set body(val: unknown) {
    this._bodyInitialized = true;
    this._body = val;
  }

  get cookies(): Record<string, string> {
    if (this._cookies !== null) return this._cookies;
    const out = parseCookieHeader(this.get('cookie'));
    this._cookies = out;
    return out;
  }

  set cookies(val: Record<string, string>) { this._cookies = val; }

  get signedCookies(): Record<string, unknown> {
    if (this._signedCookies !== null) return this._signedCookies;
    const out = resolveSignedCookies(this);
    this._signedCookies = out;
    return out;
  }

  set signedCookies(val: Record<string, unknown>) { this._signedCookies = val; }

  public get(name: string): string | undefined {
    const lc = name.toLowerCase();
    const h = this.headers;
    if (lc === 'referer' || lc === 'referrer') {
      const v = h['referrer'] ?? h['referer'];
      return Array.isArray(v) ? v.join(', ') : v;
    }
    const v = h[lc];
    return Array.isArray(v) ? v.join(', ') : v;
  }

  public header(name: string): string | undefined { return this.get(name); }

  /** @internal */
  public _getRemoteAddr(): string {
    if (this._remoteAddr === null) {
      this._remoteAddr = this._buf.toString(
        'utf8',
        this._remoteStart,
        this._remoteEnd
      );
    }
    return this._remoteAddr;
  }


  get protocol(): string { return protocolOf(this); }

  get secure(): boolean { return this.protocol === 'https'; }

  get ip(): string { return clientIpOf(this); }

  get ips(): string[] { return ipsOf(this); }

  get host(): string | undefined { return hostOf(this); }

  get hostname(): string | undefined { return hostnameOf(this); }

  get subdomains(): string[] { return subdomainsOf(this); }

  get xhr(): boolean { return isXhr(this); }

  get fresh(): boolean { return isFresh(this); }

  get stale(): boolean { return !this.fresh; }

  get socket(): RxSocket {
    if (this._socket === null) {
      this._socket = new RxSocket(this, this._getRemoteAddr(), this._isTls);
    }
    return this._socket;
  }

  get connection(): RxSocket { return this.socket; }

  /** @internal The socket if anyone asked for it (no allocation otherwise). */
  public _peekSocket(): RxSocket | null { return this._socket; }

  public range(size: number, options?: { combine?: boolean }): RangesResult {
    return parseRangeHeader(size, this.get('range'), options);
  }

  /**
   * Express `req.is()` with `type-is` semantics: `null` when the request has no body,
   * `false` when it has no/invalid `Content-Type` or nothing matches, the bare mime type
   * when called without arguments.
   */
  public is(...types: Array<string | string[]>): string | false | null {
    return isType(this, types);
  }

  public accepts(...types: Array<string | string[]>): string | string[] | false {
    return acceptsTypes(this, types);
  }

  public acceptsEncodings(...encodings: string[]): string | string[] | false {
    return acceptsEncodingList(this, encodings);
  }

  public acceptsCharsets(...charsets: string[]): string | string[] | false {
    return acceptsCharsetList(this, charsets);
  }

  public acceptsLanguages(...langs: string[]): string | string[] | false {
    return acceptsLanguageList(this, langs);
  }

  // ---- Node Readable compatibility ----
  // The engine has the whole body before dispatch, so the stream is (at most) one chunk followed
  // by 'end'. Nothing runs until a consumer reads: on('data'), on('readable'), resume(), read(),
  // pipe() or `for await`. Chunks are copies, never views of the reused batch buffer.

  get readableFlowing(): boolean | null { return this._flowing; }

  get readableLength(): number { return readableLengthOf(this); }

  get readableEncoding(): BufferEncoding | null { return this._encoding; }

  get readableHighWaterMark(): number { return 16384; }

  get readableObjectMode(): boolean { return false; }

  /**
   * Subset of Node's internal state that stream utilities (raw-body, unpipe...) peek at.
   * @internal
   */
  get _readableState(): Record<string, unknown> { return readableStateOf(this); }

  public setEncoding(encoding?: BufferEncoding): this {
    this._encoding = encoding ?? 'utf8';
    return this;
  }

  public isPaused(): boolean { return this._flowing === false; }

  public pause(): this {
    this._flowing = false;
    return this;
  }

  public resume(): this {
    resumeBody(this);
    return this;
  }

  /** @internal */
  public _flow(): void { flow(this); }

  // ---- Streamed body (bodyMode 6): see request-body.ts ----

  /** @internal True while the body still comes from the engine (no native parser read it). */
  public _isStreamedBody(): boolean { return this._bodyQueue !== null; }

  /** @internal The engine queued more body bytes for this request. */
  public _onBodyReady(): void { onBodyReady(this); }

  /** @internal */
  public _emitReadable(): void { emitReadable(this); }

  /**
   * The response finished: stop reading from the engine (it closes the connection if the body
   * was not fully received, and the request id may be reused).
   * @internal
   */
  public _detachBody(): void { detachBody(this); }

  /**
   * Collect the remaining streamed body (rxpress body parsers), failing with 413 as soon as it
   * exceeds `limit`, like raw-body.
   * @internal
   */
  public _collectBody(limit: number, cb: (err: Error | null, body?: Buffer) => void): void {
    collectBody(this, limit, cb);
  }

  /** @internal Emit 'end' once the body has been handed out. */
  public _finishRead(): void { finishRead(this); }

  /** @internal Mark the body as consumed by a body parser (Express: the stream was read). */
  public _markBodyConsumed(): void { markBodyConsumed(this); }

  public read(size?: number): Buffer | string | null {
    void size;
    return readBody(this);
  }

  public pipe<T>(dest: T, options?: { end?: boolean }): T {
    pipeBody(this, dest as unknown as PipeDest, options);
    return dest;
  }

  public unpipe(dest?: unknown): this {
    unpipeBody(this, dest);
    return this;
  }

  public [Symbol.asyncIterator](): AsyncGenerator<Buffer | string, void, undefined> {
    return iterateBody(this);
  }

  public destroy(err?: Error): this {
    if (!this.destroyed) {
      detachBody(this);
      wakeWaiter(this);
      this.destroyed = true;
      this.readable = false;
      if (err && this.listenerCount('error') > 0) {
        process.nextTick(() => this.emit('error', err));
      }
      this.emit('close');
    }
    return this;
  }

  // ---- Lightweight EventEmitter interface (zero overhead unless `.on()` is called) ----

  public on(event: string, listener: EventListenerFn): this {
    addEventListener(this, event, listener, false);
    if (event === 'data' || event === 'readable') onReadListener(this, event);
    return this;
  }

  public addListener(event: string, listener: EventListenerFn): this {
    return this.on(event, listener);
  }

  public prependListener(event: string, listener: EventListenerFn): this {
    addEventListener(this, event, listener, true);
    if (event === 'data' || event === 'readable') onReadListener(this, event);
    return this;
  }

  public once(event: string, listener: EventListenerFn): this {
    return this.on(event, onceWrapper(this, event, listener));
  }

  public prependOnceListener(event: string, listener: EventListenerFn): this {
    return this.prependListener(event, onceWrapper(this, event, listener));
  }

  public off(event: string, listener: EventListenerFn): this {
    removeEventListener(this, event, listener);
    return this;
  }

  public removeListener(event: string, listener: EventListenerFn): this {
    return this.off(event, listener);
  }

  public removeAllListeners(event?: string): this {
    removeAllEventListeners(this, event);
    return this;
  }

  public listeners(event: string): EventListenerFn[] { return getListeners(this, event, false); }

  public rawListeners(event: string): EventListenerFn[] { return getListeners(this, event, true); }

  public listenerCount(event: string): number { return countListeners(this, event); }

  public eventNames(): string[] { return getEventNames(this); }

  public setMaxListeners(n: number): this {
    this._maxListeners = n;
    return this;
  }

  public getMaxListeners(): number { return this._maxListeners; }

  public emit(event: string, ...args: unknown[]): boolean { return emitEvent(this, event, args); }
}

export { EMPTY_OBJ };
