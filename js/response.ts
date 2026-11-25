import { STATUS_CODES } from 'node:http';
import type { Application } from './application.js';
import type { NativeServerInstance } from './native.js';
import type { RxRequest, RxSocket } from './request.js';
import { CT_CUSTOM, type ResponseBatchWriter } from './protocol.js';
import {
  download,
  sendBody,
  sendFile,
  sendJson,
  sendJsonp,
  sendStatusCode,
  throwHeadersSent,
} from './response-send.js';
import {
  destroyResponse,
  endResponse,
  onNativeClose,
  onNativeDrain,
  startStreaming,
  streamWrite,
} from './response-stream.js';
import {
  addVary,
  appendField,
  applyWriteHeadHeaders,
  dropHeader,
  getField,
  hasHeaderOf,
  putHeader,
  readHeader,
  readHeaders,
  redirect,
  setAttachment,
  setCookie,
  setFields,
  setLinks,
  setLocation,
  setType,
} from './response-headers.js';
import { formatResponse, renderView } from './response-render.js';
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
import type { CookieOptions, SendFileOptions } from './types.js';

export class RxResponse {
  /** @internal */
  private readonly _rootApp: Application;
  public app: Application;
  public req: RxRequest;
  /** @internal */
  public _reqId: number;
  /** @internal */
  public readonly _writer: ResponseBatchWriter;
  /** @internal */
  public readonly _native: NativeServerInstance;
  /** @internal */
  public readonly _activeStreams: Map<number, RxRequest>;

  public statusCode = 200;
  /** @internal Explicit reason phrase; `undefined` means the standard one for `statusCode`. */
  public _statusMessage: string | undefined = undefined;
  public headersSent = false;
  public writableEnded = false;
  public writableFinished = false;
  public writable = true;
  public writableNeedDrain = false;
  public writableHighWaterMark = 16384;
  public destroyed = false;
  public finished = false;
  /** @internal */
  public _header: string | null = null;

  /** @internal */
  private _locals: Record<string, unknown> | null = null;
  /** @internal */
  public _headers: Map<string, string | string[]> | null = null;
  /** @internal */
  public _fastCtCode = CT_CUSTOM;
  /** @internal */
  public _contentLength = -1;
  /** @internal */
  public _lastBodyStr: string | null = null;
  /** @internal */
  public _suppressXpb = false;
  /** @internal */
  public _suppressEtag = false;
  /** @internal */
  public _streaming = false;
  /** @internal */
  public _streamClosed = false;
  /** @internal */
  public _closeEmitted = false;
  /** @internal Registered in activeStreams while an async handler is still pending. */
  public _pendingTracked = false;
  /** @internal */
  public _endPending = false;
  /** @internal */
  public _endCb: (() => void) | undefined = undefined;
  /** @internal */
  public _pendingChunks: Buffer[] | null = null;
  /** @internal */
  public _pendingCbs: Array<(() => void) | undefined> | null = null;
  /** @internal */
  public _listeners: Map<string, EventListenerFn[]> | null = null;
  /** @internal */
  private _maxListeners = 10;

  [key: string]: unknown;

  /** @internal */
  constructor(
    app: Application,
    req: RxRequest,
    writer: ResponseBatchWriter,
    native: NativeServerInstance,
    activeStreams: Map<number, RxRequest>
  ) {
    this._rootApp = app;
    this.app = app;
    this.req = req;
    this._reqId = req._reqId;
    this._writer = writer;
    this._native = native;
    this._activeStreams = activeStreams;
  }

  /** @internal */
  public _reset(req: RxRequest): void {
    this.app = this._rootApp;
    this.req = req;
    this._reqId = req._reqId;
    this.statusCode = 200;
    this._statusMessage = undefined;
    this.headersSent = false;
    this.writableEnded = false;
    this.writableFinished = false;
    this.writable = true;
    this.writableNeedDrain = false;
    this.writableHighWaterMark = 16384;
    this.destroyed = false;
    this.finished = false;
    this._header = null;
    this._locals = null;
    if (this._headers !== null) {
      this._headers.clear();
      this._headers = null;
    }
    this._fastCtCode = CT_CUSTOM;
    this._contentLength = -1;
    this._lastBodyStr = null;
    this._suppressXpb = false;
    this._suppressEtag = false;
    this._streaming = false;
    this._streamClosed = false;
    this._closeEmitted = false;
    this._pendingTracked = false;
    this._endPending = false;
    this._endCb = undefined;
    if (this._pendingChunks !== null) {
      this._pendingChunks.length = 0;
      this._pendingChunks = null;
    }
    if (this._pendingCbs !== null) {
      this._pendingCbs.length = 0;
      this._pendingCbs = null;
    }
    this._listeners = null;
    this._maxListeners = 10;
  }

  get locals(): Record<string, unknown> {
    if (this._locals === null) {
      this._locals = Object.create(null);
    }
    return this._locals!;
  }

  set locals(val: Record<string, unknown>) {
    this._locals = val;
  }

  // ---- Express Header & Status API ----

  public status(code: number): this {
    if (!Number.isInteger(code)) {
      throw new TypeError(`Invalid status code: ${String(code)}`);
    }
    if (code < 100 || code > 999) {
      throw new RangeError(`Invalid status code: ${code}`);
    }
    this.statusCode = code;
    this._statusMessage = undefined;
    return this;
  }

  public set(
    field: string | Record<string, string | number | string[]>,
    val?: string | number | string[]
  ): this {
    setFields(this, field, val);
    return this;
  }

  public header(
    field: string | Record<string, string | number | string[]>,
    val?: string | number | string[]
  ): this {
    return this.set(field, val);
  }

  public get(field: string): string | undefined {
    return getField(this, field);
  }

  public append(field: string, val: string | string[]): this {
    return appendField(this, field, val) as this;
  }

  public type(type: string): this {
    setType(this, type);
    return this;
  }

  public contentType(type: string): this {
    return this.type(type);
  }

  public vary(field: string): this {
    addVary(this, field);
    return this;
  }

  public links(links: Record<string, string>): this {
    setLinks(this, links);
    return this;
  }

  public location(url: string): this {
    setLocation(this, url);
    return this;
  }

  public redirect(statusOrUrl: number | string, maybeUrl?: string): void {
    redirect(this, statusOrUrl, maybeUrl);
  }

  public cookie(name: string, value: unknown, options: CookieOptions = {}): this {
    return setCookie(this, name, value, options) as this;
  }

  public clearCookie(name: string, options: CookieOptions = {}): this {
    return this.cookie(name, '', {
      ...options,
      expires: new Date(1),
      maxAge: undefined,
      path: options.path ?? '/',
    });
  }

  public attachment(filename?: string): this {
    setAttachment(this, filename);
    return this;
  }

  public format(obj: Record<string, () => unknown>): this {
    formatResponse(this, obj);
    return this;
  }

  // ---- Express Body Response API (Ultra-Fast Path) ----

  public json(body?: unknown): this {
    return sendJson(this, body) as this;
  }

  public jsonp(body?: unknown): this {
    return sendJsonp(this, body) as this;
  }

  public send(body?: unknown): this {
    return sendBody(this, body) as this;
  }

  /**
   * Render a view with `res.locals` and send it (or hand it to `callback`), like Express:
   * rendering errors go to `next(err)`.
   */
  public render(
    view: string,
    options?: Record<string, unknown> | ((err: Error | null, html?: string) => void),
    callback?: (err: Error | null, html?: string) => void
  ): void {
    renderView(this, view, options, callback);
  }

  public sendStatus(code: number): this {
    return sendStatusCode(this, code) as this;
  }

  public sendFile(
    filePath: string,
    optionsOrCb?: SendFileOptions | ((err?: Error) => void),
    maybeCb?: (err?: Error) => void
  ): void {
    sendFile(this, filePath, optionsOrCb, maybeCb);
  }

  public download(
    filePath: string,
    filenameOrOpts?: string | SendFileOptions | ((err?: Error) => void),
    optsOrCb?: SendFileOptions | ((err?: Error) => void),
    maybeCb?: (err?: Error) => void
  ): void {
    download(this, filePath, filenameOrOpts, optsOrCb, maybeCb);
  }

  // ---- Node.js http.ServerResponse Compatibility (cors, helmet, morgan, compression, SSE) ----

  public setHeader(name: string, value: string | number | readonly string[]): this {
    putHeader(this, name, value);
    return this;
  }

  public getHeader(name: string): string | string[] | undefined {
    return readHeader(this, name);
  }

  public getHeaders(): Record<string, string | string[]> {
    return readHeaders(this);
  }

  public getHeaderNames(): string[] {
    return Object.keys(this.getHeaders());
  }

  public hasHeader(name: string): boolean {
    return hasHeaderOf(this, name);
  }

  public removeHeader(name: string): void {
    dropHeader(this, name);
  }

  public writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | Record<string, string | number | string[]> | unknown[],
    maybeHeaders?: Record<string, string | number | string[]> | unknown[]
  ): this {
    if (this.headersSent) {
      throwHeadersSent('write');
    }
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 999) {
      throw new RangeError(`Invalid status code: ${statusCode}`);
    }
    this.statusCode = statusCode;
    if (typeof statusMessageOrHeaders === 'string') {
      this.statusMessage = statusMessageOrHeaders;
      if (maybeHeaders) applyWriteHeadHeaders(this, maybeHeaders);
    } else if (statusMessageOrHeaders && typeof statusMessageOrHeaders === 'object') {
      applyWriteHeadHeaders(this, statusMessageOrHeaders);
    }
    this._header = `HTTP/1.1 ${this.statusCode} ${this.statusMessage}\r\n`;
    return this;
  }

  /** @internal */
  public _implicitHeader(): void {
    if (!this._header) {
      this._triggerWriteHeadHook();
    }
  }

  public cork(): void {}

  public uncork(): void {}

  public setTimeout(msecs?: number, cb?: () => void): this {
    void msecs;
    void cb;
    return this;
  }

  public flushHeaders(): void {
    if (this.headersSent || this.writableEnded) return;
    startStreaming(this);
  }

  public write(
    chunk: string | Buffer | Uint8Array,
    encodingOrCb?: BufferEncoding | (() => void),
    maybeCb?: () => void
  ): boolean {
    return streamWrite(this, chunk, encodingOrCb, maybeCb);
  }

  public end(
    dataOrCb?: string | Buffer | Uint8Array | (() => void),
    encodingOrCb?: BufferEncoding | (() => void),
    maybeCb?: () => void
  ): this {
    endResponse(this, dataOrCb, encodingOrCb, maybeCb);
    return this;
  }

  public destroy(err?: Error): this {
    destroyResponse(this, err);
    return this;
  }

  /** @internal */
  public _onNativeDrain(): void {
    onNativeDrain(this);
  }

  /** @internal */
  public _onNativeClose(): void {
    onNativeClose(this);
  }

  /** The connection's `net.Socket`-shaped object (shared with `req.socket`). */
  get socket(): RxSocket {
    return this.req.socket;
  }

  get connection(): RxSocket {
    return this.req.socket;
  }

  // ---- Lightweight EventEmitter (for morgan / on-finished / SSE) ----

  public on(event: string, listener: EventListenerFn): this {
    addEventListener(this, event, listener, false);
    return this;
  }

  public addListener(event: string, listener: EventListenerFn): this {
    return this.on(event, listener);
  }

  public prependListener(event: string, listener: EventListenerFn): this {
    addEventListener(this, event, listener, true);
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

  public listeners(event: string): EventListenerFn[] {
    return getListeners(this, event, false);
  }

  public rawListeners(event: string): EventListenerFn[] {
    return getListeners(this, event, true);
  }

  public listenerCount(event: string): number {
    return countListeners(this, event);
  }

  public eventNames(): string[] {
    return getEventNames(this);
  }

  public setMaxListeners(n: number): this {
    this._maxListeners = n;
    return this;
  }

  public getMaxListeners(): number {
    return this._maxListeners;
  }

  public emit(event: string, ...args: unknown[]): boolean {
    return emitEvent(this, event, args);
  }

  // ---- Internal Helpers ----

  get statusMessage(): string {
    return this._statusMessage ?? (STATUS_CODES[this.statusCode] || 'unknown');
  }

  set statusMessage(value: string) {
    this._statusMessage = value;
  }

  /**
   * @internal
   * The reason phrase to put on the wire when it differs from the standard one (Node sends
   * `res.statusMessage` verbatim). Validated like Node's `checkInvalidHeaderChar`.
   */
  public _customReason(): string | undefined {
    const r = this._statusMessage;
    if (r === undefined || r === STATUS_CODES[this.statusCode]) return undefined;
    const str = String(r);
    if (/[^\t\x20-\x7e\x80-\xff]/.test(str)) {
      throw Object.assign(new TypeError('Invalid character in statusMessage'), {
        code: 'ERR_INVALID_CHAR',
      });
    }
    return str;
  }

  /** @internal Header map for the wire, with the `:reason` pseudo-header when needed. */
  public _wireHeaders(): Map<string, string | string[]> | null {
    const reason = this._customReason();
    if (reason === undefined) return this._headers;
    const m = new Map(this._headers ?? []);
    m.set(':reason', reason);
    return m;
  }

  /** @internal */
  public _triggerWriteHeadHook(): void {
    if (this._header !== null) return;
    if (this.writeHead !== RxResponse.prototype.writeHead) {
      this.writeHead(this.statusCode);
    } else {
      this._header = `HTTP/1.1 ${this.statusCode} ${this.statusMessage}\r\n`;
    }
  }

  /** @internal */
  public _markFinished(): void {
    if (this.req._bodySrc !== null) this.req._detachBody();
    if (this._pendingTracked) {
      this._pendingTracked = false;
      if (this._activeStreams.get(this._reqId) === this.req) this._activeStreams.delete(this._reqId);
    }
    this.headersSent = true;
    this.writableEnded = true;
    this.writableFinished = true;
    this.writable = false;
    this.finished = true;
    if (this._header === null) {
      this._header = `HTTP/1.1 ${this.statusCode} ${this.statusMessage}\r\n`;
    }
    if (this._listeners !== null) {
      this.emit('finish');
      if (!this._closeEmitted) {
        this._closeEmitted = true;
        this.emit('close');
      }
    } else {
      this._closeEmitted = true;
    }
  }
}

