/*
 * Request body as a Node Readable: the buffered body (one chunk followed by 'end') and the
 * streamed body (bodyMode 6, pulled from the engine on demand so a paused consumer stops the
 * engine reading the socket). Plain functions over the request; `RxRequest` keeps thin methods
 * that delegate here.
 */
import type { EventListenerFn } from './emitter.js';
import type { RxRequest } from './request.js';
import { createHttpError } from './security.js';

/** Minimal writable shape `req.pipe()` needs (Node streams, Express responses, busboy...). */
export interface PipeDest {
  write(chunk: Buffer | string): boolean | void;
  end?(): unknown;
  on?(event: string, fn: (...args: unknown[]) => void): unknown;
  once?(event: string, fn: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, fn: (...args: unknown[]) => void): unknown;
  emit?(event: string, ...args: unknown[]): unknown;
}

/**
 * Where a streamed request body comes from: the engine keeps up to a bounded window of the
 * body per request and hands it over on `takeRequestBody`; `bodies` routes body-ready
 * notifications to the request.
 * @internal
 */
export interface BodySource {
  takeRequestBody(reqId: number): Array<number | Buffer> | null;
  releaseRequestBody(reqId: number): void;
  bodies: Map<number, RxRequest>;
}

const TAKE_ABORTED = 2;
const TAKE_OPEN = 0;

function abortedError(): Error {
  return Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
}

/** @internal */
export interface PipeLink {
  dest: PipeDest;
  onData: EventListenerFn;
  onEnd: EventListenerFn;
}

/** @internal `process.nextTick` callback for `resume()`. */
export function flowTick(req: RxRequest): void {
  req._flow();
}

function endTick(req: RxRequest): void {
  req._finishRead();
}

function readableTick(req: RxRequest): void {
  req._emitReadable();
}

// ---- Node Readable compatibility ----
// The engine has the whole body before dispatch, so the stream is (at most) one chunk followed
// by 'end'. Nothing runs until a consumer reads: on('data'), on('readable'), resume(), read(),
// pipe() or `for await`. Chunks are copies, never views of the reused batch buffer.

/** @internal */
export function flow(req: RxRequest): void {
  req._flowScheduled = false;
  if (req._flowing !== true || req.destroyed || req.readableEnded) return;
  if (req._bodyQueue !== null) {
    flowStreamed(req);
    return;
  }
  if (!req._chunkTaken) {
    req._chunkTaken = true;
    if (req._bodyLen > 0) {
      req.emit('data', takeChunk(req));
      // a 'data' handler paused us (pipe backpressure): 'end' waits for resume()
      if (req._flowing !== true) return;
    }
  }
  finishRead(req);
}

/** @internal Adding 'data' starts the flow (unless paused); 'readable' switches to paused mode. */
export function onReadListener(req: RxRequest, event: string): void {
  if (event === 'data') {
    if (req._flowing !== false) req.resume();
  } else {
    req._flowing = false;
    if (!req.readableEnded) process.nextTick(readableTick, req);
  }
}

// ---- Streamed body (bodyMode 6) ----

/** @internal Pull whatever the engine holds for this request into the local queue. */
function pull(req: RxRequest): void {
  const src = req._bodySrc;
  if (src === null || req._srcEnded) return;
  const taken = src.takeRequestBody(req._reqId);
  if (taken === null) {
    // No entry: never expected (the engine keeps it until the final take), treat as cut off.
    endSource(req, false);
    onBodyAborted(req);
    return;
  }
  const q = req._bodyQueue!;
  for (let i = 1; i < taken.length; i++) {
    const chunk = taken[i] as Buffer;
    q.push(chunk);
    req._bodyQueued += chunk.length;
  }
  const state = taken[0] as number;
  if (state === TAKE_OPEN) return;
  // A final take removed the engine's entry.
  endSource(req, false);
  if (state === TAKE_ABORTED) onBodyAborted(req);
}

/** @internal */
function endSource(req: RxRequest, release: boolean): void {
  req._srcEnded = true;
  const src = req._bodySrc;
  if (src !== null) {
    req._bodySrc = null;
    if (src.bodies.get(req._reqId) === req) src.bodies.delete(req._reqId);
    if (release) src.releaseRequestBody(req._reqId);
  }
}

/** @internal The client went away (or sent a malformed body) mid-upload. */
function onBodyAborted(req: RxRequest): void {
  req.complete = false;
  req.readable = false;
  if (!req.aborted) {
    req.aborted = true;
    req.emit('aborted');
  }
  if (req.listenerCount('error') > 0) req.emit('error', abortedError());
  wakeWaiter(req);
}

/** @internal */
export function wakeWaiter(req: RxRequest): void {
  const w = req._bodyWaiter;
  if (w !== null) {
    req._bodyWaiter = null;
    w();
  }
}

/** @internal */
function shiftChunk(req: RxRequest): Buffer | string | null {
  const q = req._bodyQueue!;
  if (q.length === 0) return null;
  const chunk = q.shift()!;
  req._bodyQueued -= chunk.length;
  return req._encoding !== null ? chunk.toString(req._encoding) : chunk;
}

/** @internal */
function flowStreamed(req: RxRequest): void {
  while (req._flowing === true && !req.destroyed && !req.readableEnded) {
    if (req._bodyQueue!.length === 0) pull(req);
    const chunk = shiftChunk(req);
    if (chunk === null) {
      if (req._srcEnded && !req.aborted) finishRead(req);
      return;
    }
    req.emit('data', chunk);
  }
}

/** @internal The engine queued more body bytes for this request. */
export function onBodyReady(req: RxRequest): void {
  if (req.destroyed || req.readableEnded) return;
  if (req._bodyWaiter !== null) {
    wakeWaiter(req);
  } else if (req._flowing === true) {
    flowStreamed(req);
  } else if (req.listenerCount('readable') > 0) {
    emitReadable(req);
  }
}

/** @internal */
export function emitReadable(req: RxRequest): void {
  if (req.readableEnded || req.destroyed) return;
  if (req._bodyQueue !== null) {
    if (req._bodyQueue.length === 0) pull(req);
    if (req._bodyQueue.length === 0 && !req._srcEnded) return;
  }
  req.emit('readable');
}

/**
 * The response finished: stop reading from the engine (it closes the connection if the body
 * was not fully received, and the request id may be reused).
 * @internal
 */
export function detachBody(req: RxRequest): void {
  if (req._bodySrc !== null) endSource(req, true);
}

/**
 * Collect the remaining streamed body (rxpress body parsers), failing with 413 as soon as it
 * exceeds `limit`, like raw-body.
 * @internal
 */
export function collectBody(
  req: RxRequest,
  limit: number,
  cb: (err: Error | null, body?: Buffer) => void
): void {
  const declared = req.get('content-length');
  if (declared !== undefined && Number(declared) > limit) {
    detachBody(req);
    cb(createHttpError(413, 'request entity too large', 'entity.too.large'));
    return;
  }
  const parts: Buffer[] = [];
  let total = 0;
  req._flowing = true;
  const step = (): void => {
    for (;;) {
      if (req.aborted) {
        cb(createHttpError(400, 'request aborted', 'request.aborted'));
        return;
      }
      if (req._bodyQueue!.length === 0) pull(req);
      const q = req._bodyQueue!;
      if (q.length === 0) break;
      for (let i = 0; i < q.length; i++) {
        parts.push(q[i]);
        total += q[i].length;
      }
      q.length = 0;
      req._bodyQueued = 0;
      if (total > limit) {
        detachBody(req);
        cb(createHttpError(413, 'request entity too large', 'entity.too.large'));
        return;
      }
    }
    if (req.aborted) {
      cb(createHttpError(400, 'request aborted', 'request.aborted'));
      return;
    }
    if (req._srcEnded) {
      markBodyConsumed(req);
      req.complete = true;
      cb(null, parts.length === 1 ? parts[0] : Buffer.concat(parts, total));
      return;
    }
    req._bodyWaiter = step;
  };
  step();
}

/** @internal Emit 'end' once the body has been handed out. */
export function finishRead(req: RxRequest): void {
  req._endScheduled = false;
  if (req.readableEnded || req.destroyed) return;
  if (req._bodyQueue !== null) {
    if (!req._srcEnded || req._bodyQueue.length > 0 || req.aborted) return;
    req.complete = true;
  }
  if (req.listenerCount('readable') > 0) req.emit('readable');
  if (req.readableEnded) return;
  req.readable = false;
  req.readableEnded = true;
  req.emit('end');
}

/** @internal Mark the body as consumed by a body parser (Express: the stream was read). */
export function markBodyConsumed(req: RxRequest): void {
  req._chunkTaken = true;
  req.readable = false;
  req.readableEnded = true;
}

/** @internal */
function takeChunk(req: RxRequest): Buffer | string {
  const src = req._getRawBody();
  return req._encoding !== null ? src.toString(req._encoding) : Buffer.from(src);
}

/** @internal */
function scheduleEnd(req: RxRequest): void {
  if (!req._endScheduled && !req.readableEnded) {
    req._endScheduled = true;
    process.nextTick(endTick, req);
  }
}

/** @internal `req.read()`. */
export function readBody(req: RxRequest): Buffer | string | null {
  if (req._flowing === null) req._flowing = false;
  if (req.destroyed || req.readableEnded) return null;
  if (req._bodyQueue !== null) {
    if (req._bodyQueue.length === 0) pull(req);
    const q = req._bodyQueue;
    if (q.length === 0) {
      if (req._srcEnded) scheduleEnd(req);
      return null;
    }
    const buf = q.length === 1 ? q[0] : Buffer.concat(q, req._bodyQueued);
    q.length = 0;
    req._bodyQueued = 0;
    const chunk = req._encoding !== null ? buf.toString(req._encoding) : buf;
    req.emit('data', chunk);
    if (req._srcEnded) scheduleEnd(req);
    return chunk;
  }
  if (!req._chunkTaken) {
    req._chunkTaken = true;
    scheduleEnd(req);
    if (req._bodyLen > 0) {
      const chunk = takeChunk(req);
      req.emit('data', chunk);
      return chunk;
    }
    return null;
  }
  scheduleEnd(req);
  return null;
}

/** @internal `req.pipe()`. */
export function pipeBody(req: RxRequest, d: PipeDest, options?: { end?: boolean }): void {
  const endDest = options?.end !== false;
  const link: PipeLink = {
    dest: d,
    onData: (chunk: unknown) => {
      const ok = d.write(chunk as Buffer | string);
      if (ok === false && typeof d.once === 'function') {
        req.pause();
        d.once('drain', () => req.resume());
      }
    },
    onEnd: () => {
      removePipe(req, link);
      if (endDest && typeof d.end === 'function') d.end();
    },
  };
  if (req._pipes === null) req._pipes = [];
  req._pipes.push(link);
  req.on('data', link.onData);
  req.on('end', link.onEnd);
  if (typeof d.emit === 'function') d.emit('pipe', req);
  if (req.readableEnded) {
    // Already consumed: Node ends the destination right away.
    process.nextTick(link.onEnd);
  } else {
    req.resume();
  }
}

/** @internal `req.unpipe()`. */
export function unpipeBody(req: RxRequest, dest?: unknown): void {
  if (req._pipes === null) return;
  const links = req._pipes.slice();
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (dest !== undefined && link.dest !== dest) continue;
    removePipe(req, link);
    if (typeof link.dest.emit === 'function') link.dest.emit('unpipe', req);
  }
}

/** @internal */
function removePipe(req: RxRequest, link: PipeLink): void {
  if (req._pipes === null) return;
  const idx = req._pipes.indexOf(link);
  if (idx === -1) return;
  req._pipes.splice(idx, 1);
  req.off('data', link.onData);
  req.off('end', link.onEnd);
}

/** @internal `for await (const chunk of req)`. */
export async function* iterateBody(
  req: RxRequest
): AsyncGenerator<Buffer | string, void, undefined> {
  if (req._bodyQueue !== null) {
    yield* iterateStreamed(req);
    return;
  }
  if (req._chunkTaken || req.destroyed) {
    finishRead(req);
    return;
  }
  req._chunkTaken = true;
  req._flowing = true;
  if (req._bodyLen > 0) {
    const chunk = takeChunk(req);
    req.emit('data', chunk);
    yield chunk;
  }
  finishRead(req);
}

/** @internal */
async function* iterateStreamed(req: RxRequest): AsyncGenerator<Buffer | string, void, undefined> {
  // Paused mode, as Node's iterator (it reads on 'readable'): a body-ready event that lands
  // between two steps must queue the bytes, not emit them as 'data' to nobody.
  req._flowing = false;
  for (;;) {
    if (req.aborted) throw abortedError();
    if (req.destroyed) return;
    if (req._bodyQueue!.length === 0) pull(req);
    const chunk = shiftChunk(req);
    if (chunk !== null) {
      req.emit('data', chunk);
      yield chunk;
      continue;
    }
    if (req.aborted) throw abortedError();
    if (req._srcEnded) {
      finishRead(req);
      return;
    }
    await new Promise<void>((resolve) => {
      req._bodyWaiter = resolve;
    });
  }
}

/** @internal `req.readableLength`: bytes still queued (streamed) or not yet handed out. */
export function readableLengthOf(req: RxRequest): number {
  if (req._bodyQueue !== null) return req._bodyQueued;
  return req._chunkTaken ? 0 : req._bodyLen;
}

/**
 * Subset of Node's internal state that stream utilities (raw-body, unpipe...) peek at.
 * @internal
 */
export function readableStateOf(req: RxRequest): Record<string, unknown> {
  return {
    objectMode: false,
    highWaterMark: 16384,
    length: req.readableLength,
    flowing: req._flowing,
    ended: req._bodyQueue !== null ? req._srcEnded : req._chunkTaken,
    endEmitted: req.readableEnded,
    encoding: req._encoding,
    decoder: null,
    pipes: req._pipes ? req._pipes.map((l) => l.dest) : [],
  };
}

/** @internal `req.resume()`: start flowing on the next tick unless already scheduled/ended. */
export function resumeBody(req: RxRequest): void {
  req._flowing = true;
  if (!req._flowScheduled && !req.readableEnded) {
    req._flowScheduled = true;
    process.nextTick(flowTick, req);
  }
}
