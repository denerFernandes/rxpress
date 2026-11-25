/**
 * Per-server request runtime: drains request batches from the engine, decodes them into
 * `RxRequest`/`RxResponse` pairs and dispatches them (fast routes or the router), and relays
 * engine stream events (body ready, close, drain).
 *
 * This is the per-request hot loop. State the dispatch helpers share lives in fields initialised
 * once in the constructor (stable hidden class); callbacks handed out repeatedly
 * (`sharedDirectNext`, `drainLoop`) are arrow-function fields created once per server, so the
 * loop allocates nothing beyond what each request needs.
 */
import type { Application } from '../application.js';
import { appProtos, applyAppProtos, type ProtoApp } from '../app-protos.js';
import { BRIDGE_HEADER, parseBridgeHeader } from '../bridge.js';
import type { NativeServerInstance } from '../native.js';
import { BODY_MODE_STREAMED, ResponseBatchWriter } from '../protocol.js';
import { type BodySource, RxRequest } from '../request.js';
import { RxResponse } from '../response.js';
import { invokeHandler, rejectionError, type Router } from '../router.js';
import type { NextFunction } from '../types.js';
import { createBodySource, deliverClosedStreams, deliverStreamEvents } from './body-streams.js';
import type { CompiledFastRoute } from './fast-routes.js';
import { emergencyAnswer, makeFinalHandler } from './final-handler.js';
import { UpgradeTargets } from './upgrade.js';

const EMPTY_BUF = Buffer.alloc(0);
const INITIAL_REQ_BUF_SIZE = 512 * 1024;
const MAX_IDLE_REQ_BUF_SIZE = 4 * 1024 * 1024;

export class ServerRuntime {
  public readonly app: Application;
  public readonly router: Router;
  public readonly native: NativeServerInstance;
  public readonly writer: ResponseBatchWriter;
  public readonly fastRoutes: CompiledFastRoute[];
  public readonly bridgeMode: boolean;
  /** Responses still in flight after their sync pass (close/drain notifications), by request id. */
  public readonly activeStreams: Map<number, RxRequest>;
  public readonly bodySource: BodySource;
  /** Requests whose body the engine streams (no native parser buffered it), by request id. */
  public readonly bodyStreams: Map<number, RxRequest>;
  public readonly upgrades: UpgradeTargets;
  public closing: boolean;
  public closed: boolean;

  private reqBuf: Buffer;
  private reqBufSmallStreak: number;
  private readonly batchReqs: RxRequest[];

  // Shared sync fastNext state (zero closure allocation on 0-2 arg sync direct routes!)
  private currentDirectReq: RxRequest | null;
  private currentDirectRes: RxResponse | null;
  private currentDirectNextIdx: number;
  private pendingAsyncNext: NextFunction | null;
  private fastEnteredRouter: boolean;

  public readonly sharedDirectNext: NextFunction;
  /** Engine wake-up callback: drain stream events, then request batches. */
  public readonly drainLoop: () => void;

  constructor(
    app: Application,
    native: NativeServerInstance,
    fastRoutes: CompiledFastRoute[],
    bridgeMode: boolean
  ) {
    this.app = app;
    this.router = app._router;
    this.native = native;
    this.writer = new ResponseBatchWriter(native, 1024 * 1024);
    this.fastRoutes = fastRoutes;
    this.bridgeMode = bridgeMode;
    this.activeStreams = new Map<number, RxRequest>();
    this.bodySource = createBodySource(native);
    this.bodyStreams = this.bodySource.bodies;
    this.upgrades = new UpgradeTargets(native, this);
    this.closing = false;
    this.closed = false;
    this.reqBuf = Buffer.allocUnsafe(INITIAL_REQ_BUF_SIZE);
    this.reqBufSmallStreak = 0;
    this.batchReqs = [];
    this.currentDirectReq = null;
    this.currentDirectRes = null;
    this.currentDirectNextIdx = 0;
    this.pendingAsyncNext = null;
    this.fastEnteredRouter = false;

    this.sharedDirectNext = (err?: unknown) => {
      const r = this.currentDirectReq;
      const s = this.currentDirectRes;
      if (!r || !s) return;
      this.currentDirectReq = null;
      this.currentDirectRes = null;
      this.fastEnteredRouter = true;
      const norm = err === 'route' || err === 'router' || err === null ? undefined : err;
      this.router.handle(r, s, this.finalHandler(r, s), this.currentDirectNextIdx, norm);
    };
    this.drainLoop = () => this.drain();
  }

  private finalHandler(req: RxRequest, res: RxResponse): (err?: unknown) => void {
    return makeFinalHandler(this.app, this.writer, req, res);
  }

  /** A fresh req/res pair, linked both ways (`req.res`). */
  private newRequest(): RxRequest {
    const app = this.app;
    const req = new RxRequest(
      app,
      0,
      -1,
      0,
      null,
      false,
      0,
      EMPTY_BUF,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0
    );
    const res = new RxResponse(app, req, this.writer, this.native, this.activeStreams);
    req.res = res;
    if (appProtos.active !== 0) applyAppProtos(req, res, app as unknown as ProtoApp);
    return req;
  }

  /** Bridge instance: authenticate the forwarded request and restore the caller's view. */
  private applyBridge(req: RxRequest, res: RxResponse): boolean {
    const meta = parseBridgeHeader(req.get(BRIDGE_HEADER));
    if (meta === null) {
      try {
        res.sendStatus(403);
      } catch {
        emergencyAnswer(this.writer, req, res);
      }
      return false;
    }
    req._applyBridge(meta.peer, meta.tls, meta.originalUrl, meta.baseUrl, meta.hasNext);
    return true;
  }

  // ---- Batch decoding ----

  public processBatch(buf: Buffer): number {
    const writer = this.writer;
    const batchReqs = this.batchReqs;
    const bridgeMode = this.bridgeMode;
    const header = buf.readUInt32LE(0);
    const count = header & 0x7fffffff;
    let pos = 4;

    writer.inBatch = true;
    try {
      for (let i = 0; i < count; i++) {
        const reqId = buf.readUInt32LE(pos);
        pos += 4;
        const routeId = buf.readInt32LE(pos);
        pos += 4;
        const methodCode = buf[pos++];
        const flags = buf[pos++];
        const bodyMode = buf[pos++];
        pos++; // reserved

        let methodStr: string | null = null;
        if (methodCode === 7) {
          const mLen = buf.readUInt16LE(pos);
          pos += 2;
          methodStr = buf.toString('ascii', pos, pos + mLen);
          pos += mLen;
        }

        const sliceStart = pos;
        const rawUrlLen = buf.readUInt32LE(pos);
        pos += 4;
        const urlStart = pos;
        const urlEnd = pos + rawUrlLen;
        pos = urlEnd;

        const pathLen = buf.readUInt32LE(pos);
        pos += 4;

        const remoteLen = buf.readUInt16LE(pos);
        pos += 2;
        const remoteStart = pos;
        const remoteEnd = pos + remoteLen;
        pos = remoteEnd;

        const paramsLen = buf.readUInt32LE(pos);
        pos += 4;
        const paramsStart = pos;
        pos += paramsLen;

        const headersLen = buf.readUInt32LE(pos);
        pos += 4;
        const headersStart = pos;
        pos += headersLen;

        const bodyLen = buf.readUInt32LE(pos);
        pos += 4;
        const bodyStart = pos;
        pos += bodyLen;
        const sliceEnd = pos;

        const isTls = (flags & 0x01) !== 0;

        // A fresh req/res per request: user closures, timers and promise continuations may keep
        // references after the response, so objects are never recycled across requests.
        const req = this.newRequest();
        const res = req.res;
        req._reset(
          reqId,
          routeId,
          methodCode,
          methodStr,
          isTls,
          bodyMode,
          buf,
          urlStart,
          urlEnd,
          pathLen,
          remoteStart,
          remoteEnd,
          paramsStart,
          paramsLen,
          headersStart,
          headersLen,
          bodyStart,
          bodyLen,
          sliceStart,
          sliceEnd,
          res
        );
        res._reset(req);
        req._conditional = (flags & 0x08) !== 0;
        batchReqs.push(req);
        if ((flags & 0x04) !== 0) {
          this.upgrades.dispatch(req);
          continue;
        }
        if (bodyMode === BODY_MODE_STREAMED) {
          req._bodySrc = this.bodySource;
          this.bodyStreams.set(reqId, req);
        }
        if (bridgeMode && !this.applyBridge(req, res)) continue;

        this.dispatchRequest(req, res, routeId);
      }
    } finally {
      writer.inBatch = false;
      writer.flush();
      this.detachBatch(buf, pos);
    }
    return header;
  }

  /**
   * Requests read headers/query/body lazily from the batch buffer, which the next
   * drainBatchInto() overwrites. Give every request of this batch one shared owned copy
   * (same offsets) so late reads from user closures can never observe another client's bytes.
   */
  private detachBatch(buf: Buffer, end: number): void {
    const batchReqs = this.batchReqs;
    const n = batchReqs.length;
    if (n === 0) return;
    const owned = Buffer.allocUnsafe(end);
    buf.copy(owned, 0, 0, end);
    for (let i = 0; i < n; i++) {
      const r = batchReqs[i];
      try {
        if (r._buf === buf) r._buf = owned;
      } catch {
        // frozen `req`: keeps its already-cached fields
      }
    }
    batchReqs.length = 0;
  }

  // ---- Dispatch ----

  private dispatchRequest(req: RxRequest, res: RxResponse, routeId: number): void {
    this.pendingAsyncNext = null;
    this.fastEnteredRouter = false;
    this.writer.lastReqId = -1;
    try {
      try {
        if (routeId >= 0) {
          const fast = this.fastRoutes[routeId];
          if (fast) {
            this.dispatchFast(fast, req, res);
          } else {
            this.router.handle(req, res, this.finalHandler(req, res), 0, undefined);
          }
        } else {
          this.router.handle(req, res, this.finalHandler(req, res), 0, undefined);
        }
      } catch (err) {
        try {
          this.finalHandler(req, res)(err);
        } catch {
          emergencyAnswer(this.writer, req, res);
        }
      }
    } finally {
      const writer = this.writer;
      let ended = true;
      try {
        ended = res.writableEnded || writer.lastReqId === req._reqId;
      } catch {
        ended = writer.lastReqId === req._reqId;
      }
      if (!ended) {
        this.trackPending(req, res, routeId);
      } else if (req.next === this.sharedDirectNext) {
        try {
          req.next = undefined;
        } catch {
          // ignore frozen `req`
        }
      }
      this.pendingAsyncNext = null;
      this.fastEnteredRouter = false;
    }
  }

  /** Still unanswered after the sync pass: track it and leave `req.next` usable for later. */
  private trackPending(req: RxRequest, res: RxResponse, routeId: number): void {
    // Track it so a client disconnect detected by the engine reaches the app as
    // req 'aborted'/'close' and res 'close' (Node parity).
    if (!this.activeStreams.has(req._reqId)) {
      this.activeStreams.set(req._reqId, req);
      res._pendingTracked = true;
    }
    try {
      if (this.pendingAsyncNext !== null && !this.fastEnteredRouter) {
        req.next = this.pendingAsyncNext;
      } else if (
        !this.fastEnteredRouter &&
        routeId >= 0 &&
        (req.next === undefined || req.next === this.sharedDirectNext)
      ) {
        const fast = this.fastRoutes[routeId];
        if (fast && fast.directFn !== null) {
          const nextIdx = fast.nextLayerIdx;
          let fired = false;
          req.next = (err?: unknown) => {
            if (fired) return;
            fired = true;
            const norm =
              err === 'route' || err === 'router' || err === null ? undefined : err;
            this.router.handle(req, res, this.finalHandler(req, res), nextIdx, norm);
          };
        }
      }
    } catch {
      // frozen/sealed `req`: the handler still holds its own `next`
    }
  }

  private dispatchFast(route: CompiledFastRoute, req: RxRequest, res: RxResponse): void {
    if (route.routeObj !== undefined) {
      req.route = route.routeObj;
    }

    const directFn = route.directFn;
    if (directFn === null) {
      this.dispatchChain(route, req, res);
      return;
    }
    if (route.isAsyncDirect) {
      this.dispatchAsyncDirect(route, directFn, req, res);
      return;
    }

    // Sync 0-2 arg direct handler: shares `sharedDirectNext` (no per-request closure).
    const sharedDirectNext = this.sharedDirectNext;
    this.currentDirectReq = req;
    this.currentDirectRes = res;
    this.currentDirectNextIdx = route.nextLayerIdx;
    req.next = sharedDirectNext;
    try {
      const ret = directFn(req, res, sharedDirectNext);
      this.currentDirectReq = null;
      this.currentDirectRes = null;
      if (ret && typeof (ret as PromiseLike<unknown>).then === 'function') {
        this.catchSyncDirectRejection(ret as PromiseLike<unknown>, route, req, res);
      }
    } catch (thrown) {
      this.currentDirectReq = null;
      this.currentDirectRes = null;
      if (!res.writableEnded && !this.fastEnteredRouter) {
        this.fastEnteredRouter = true;
        this.router.handle(
          req,
          res,
          this.finalHandler(req, res),
          route.nextLayerIdx,
          thrown
        );
      }
    }
  }

  /** A sync-shaped direct handler returned a promise: route its rejection to the router. */
  private catchSyncDirectRejection(
    ret: PromiseLike<unknown>,
    route: CompiledFastRoute,
    req: RxRequest,
    res: RxResponse
  ): void {
    const enteredSync = this.fastEnteredRouter;
    const capturedNextIdx = route.nextLayerIdx;
    ret.then(undefined, (rej: unknown) => {
      if (!res.writableEnded && !enteredSync) {
        this.router.handle(
          req,
          res,
          this.finalHandler(req, res),
          capturedNextIdx,
          rejectionError(rej)
        );
      }
    });
  }

  /** Direct handler that may call `next` later: it gets its own one-shot `next`. */
  private dispatchAsyncDirect(
    route: CompiledFastRoute,
    directFn: NonNullable<CompiledFastRoute['directFn']>,
    req: RxRequest,
    res: RxResponse
  ): void {
    let enteredRouter = false;
    const nextIdx = route.nextLayerIdx;
    const directNext: NextFunction = (err?: unknown) => {
      if (enteredRouter) return;
      enteredRouter = true;
      this.fastEnteredRouter = true;
      this.pendingAsyncNext = null;
      const norm = err === 'route' || err === 'router' || err === null ? undefined : err;
      this.router.handle(req, res, this.finalHandler(req, res), nextIdx, norm);
    };
    this.pendingAsyncNext = directNext;
    // Express sets req.next for every handler (res.render reports errors through it).
    req.next = directNext;
    try {
      const ret = directFn(req, res, directNext);
      if (ret && typeof (ret as PromiseLike<unknown>).then === 'function') {
        (ret as PromiseLike<unknown>).then(undefined, (rej: unknown) => {
          if (!res.writableEnded && !enteredRouter) {
            directNext(rejectionError(rej));
          }
        });
      }
    } catch (thrown) {
      if (!res.writableEnded && !enteredRouter) {
        directNext(thrown);
      }
    }
  }

  /** Pre-flattened chain: [mw1, mw2, ..., handler] */
  private dispatchChain(route: CompiledFastRoute, req: RxRequest, res: RxResponse): void {
    const chain = route.chain;
    const chainLen = chain.length;
    let idx = 0;

    const step: NextFunction = (err?: unknown) => {
      if (err !== undefined && err !== null) {
        this.fastEnteredRouter = true;
        // Resume right after the layer that called next(err) / next('route').
        return this.router.handle(
          req,
          res,
          this.finalHandler(req, res),
          route.errorNextIdx[idx - 1] ?? route.nextLayerIdx,
          err === 'route' ? undefined : err
        );
      }
      if (idx < chainLen) {
        const fn = chain[idx++];
        invokeHandler(fn, undefined, req, res, step);
      } else {
        this.fastEnteredRouter = true;
        this.router.handle(
          req,
          res,
          this.finalHandler(req, res),
          route.nextLayerIdx,
          undefined
        );
      }
    };

    step();
    if (!this.fastEnteredRouter && !res.writableEnded && req.next === undefined) {
      this.pendingAsyncNext = step;
    }
  }

  // ---- Drain loop ----

  private drainStreamNotifications(): void {
    const native = this.native;
    if (native.drainStreamEvents) {
      // [closedCount, drainedCount, ...closed, ...drained, ...bodyReady]
      const events = native.drainStreamEvents();
      if (events && events.length > 0) {
        deliverStreamEvents(events, this.bodyStreams, this.activeStreams);
      }
    } else {
      const closedIds = native.drainClosedStreams();
      if (closedIds) {
        deliverClosedStreams(closedIds, this.activeStreams);
      }
    }
  }

  private drain(): void {
    if (this.closed) return;

    try {
      this.drainStreamNotifications();

      const native = this.native;
      for (let iter = 0; iter < 8; iter++) {
        let reqBuf = this.reqBuf;
        let written = native.drainBatchInto(reqBuf, 512);
        if (written === 0) return;

        if ((written & 0x80000000) !== 0) {
          const needed = written & 0x7fffffff;
          const newCap = Math.min(0x7fffffff, Math.max(needed, reqBuf.length * 2));
          reqBuf = this.reqBuf = Buffer.allocUnsafe(newCap);
          written = native.drainBatchInto(reqBuf, 512);
          if (written === 0) return;
          if ((written & 0x80000000) !== 0) {
            setImmediate(this.drainLoop);
            return;
          }
        }

        const header = this.processBatch(reqBuf);
        const hasMore = (header & 0x80000000) !== 0;

        if (reqBuf.length > MAX_IDLE_REQ_BUF_SIZE) {
          if (written <= INITIAL_REQ_BUF_SIZE) {
            this.reqBufSmallStreak++;
            if (this.reqBufSmallStreak >= 16) {
              this.reqBuf = Buffer.allocUnsafe(INITIAL_REQ_BUF_SIZE);
              this.reqBufSmallStreak = 0;
            }
          } else {
            this.reqBufSmallStreak = 0;
          }
        }

        if (!hasMore) return;
      }

      setImmediate(this.drainLoop);
    } catch {
      if (!this.closed) {
        setImmediate(this.drainLoop);
      }
    }
  }
}
