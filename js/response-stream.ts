/*
 * Streaming side of `RxResponse` (Node ServerResponse compatibility for cors, helmet, morgan,
 * compression, SSE...): write/end with backpressure, native drain/close notifications,
 * destroy, and the head of a streamed response. Plain functions over the response;
 * `RxResponse` keeps thin methods that delegate here.
 */
import { CT_CUSTOM } from './protocol.js';
import type { RxResponse } from './response.js';
import { fastCtToString, writeBufferedSyncBuffer, writeBufferedSyncString } from './response-send.js';

/** @internal `res.write()`. */
export function streamWrite(
  res: RxResponse,
  chunk: string | Buffer | Uint8Array,
  encodingOrCb?: BufferEncoding | (() => void),
  maybeCb?: () => void
): boolean {
  const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8';
  const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
  if (res.writableEnded || res._streamClosed || res.destroyed) return false;
  if (!res._streaming) {
    startStreaming(res);
    if (res._streamClosed) {
      if (cb) cb();
      return false;
    }
  }
  const buf =
    typeof chunk === 'string'
      ? Buffer.from(chunk, encoding)
      : Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);

  if (buf.length === 0) {
    if (cb) cb();
    return !res.writableNeedDrain;
  }

  if (res.writableNeedDrain || (res._pendingChunks !== null && res._pendingChunks.length > 0)) {
    if (res._pendingChunks === null) {
      res._pendingChunks = [];
      res._pendingCbs = [];
    }
    res._pendingChunks.push(buf);
    res._pendingCbs!.push(cb);
    res.writableNeedDrain = true;
    return false;
  }

  const st = res._native.streamWrite(res._reqId, buf);
  if (st === 1 || st === true) {
    if (cb) cb();
    return true;
  }
  if (st === 2) {
    res.writableNeedDrain = true;
    if (cb) cb();
    return false;
  }
  if (st === 3) {
    if (res._pendingChunks === null) {
      res._pendingChunks = [];
      res._pendingCbs = [];
    }
    res._pendingChunks.push(buf);
    res._pendingCbs!.push(cb);
    res.writableNeedDrain = true;
    return false;
  }
  res._streamClosed = true;
  res.writable = false;
  if (cb) cb();
  return false;
}

/** @internal `res.end()`: finishes a stream, or sends the buffered response in one batch. */
export function endResponse(
  res: RxResponse,
  dataOrCb?: string | Buffer | Uint8Array | (() => void),
  encodingOrCb?: BufferEncoding | (() => void),
  maybeCb?: () => void
): void {
  if (res.writableEnded) return;

  let data: string | Buffer | Uint8Array | undefined;
  let encoding: BufferEncoding = 'utf8';
  let cb: (() => void) | undefined;

  if (typeof dataOrCb === 'function') {
    cb = dataOrCb;
  } else {
    data = dataOrCb;
    if (typeof encodingOrCb === 'function') {
      cb = encodingOrCb;
    } else {
      if (encodingOrCb) encoding = encodingOrCb;
      cb = maybeCb;
    }
  }

  if (res._streaming) {
    if (res._streamClosed || res.destroyed) {
      res._markFinished();
      if (cb) cb();
      return;
    }
    let finalBuf: Buffer | null = null;
    if (data !== undefined) {
      finalBuf =
        typeof data === 'string'
          ? Buffer.from(data, encoding)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
    }
    if (
      (res._pendingChunks !== null && res._pendingChunks.length > 0) ||
      (res.writableNeedDrain && finalBuf !== null && finalBuf.length > 0)
    ) {
      if (finalBuf !== null && finalBuf.length > 0) {
        if (res._pendingChunks === null) {
          res._pendingChunks = [];
          res._pendingCbs = [];
        }
        res._pendingChunks.push(finalBuf);
        res._pendingCbs!.push(undefined);
      }
      res.writableEnded = true;
      res.writable = false;
      res._endPending = true;
      res._endCb = cb;
      return;
    }
    res._native.streamEnd(res._reqId, finalBuf);
    res._activeStreams.delete(res._reqId);
    res._markFinished();
    if (cb) cb();
    return;
  }

  const ctCode =
    res.statusCode === 204 || res.statusCode === 304 ? CT_CUSTOM : res._fastCtCode;

  if (data === undefined) {
    writeBufferedSyncString(res, '', ctCode);
  } else if (typeof data === 'string') {
    if (encoding === 'utf8') {
      writeBufferedSyncString(res, data, ctCode);
    } else {
      writeBufferedSyncBuffer(res, Buffer.from(data, encoding), ctCode);
    }
  } else {
    writeBufferedSyncBuffer(res, data, ctCode);
  }

  if (cb) cb();
}

/** @internal `res.destroy()`. */
export function destroyResponse(res: RxResponse, err?: Error): void {
  void err;
  if (res.destroyed) return;
  res.destroyed = true;
  res._streamClosed = true;
  res.writable = false;
  res.writableNeedDrain = false;
  if (res._pendingChunks !== null) {
    res._pendingChunks.length = 0;
    res._pendingCbs!.length = 0;
  }
  res._endPending = false;
  res._endCb = undefined;
  if (res._streaming) {
    // Like Node's socket.destroy(): the client must see a truncated body, not a clean end.
    if (res._native.streamAbort) {
      res._native.streamAbort(res._reqId);
    } else {
      res._native.streamEnd(res._reqId, null);
    }
    res._activeStreams.delete(res._reqId);
  }
  if (!res._closeEmitted) {
    res._closeEmitted = true;
    res.emit('close');
  }
}

/** @internal */
export function onNativeDrain(res: RxResponse): void {
  if (res._streamClosed || res.destroyed) return;
  if (res._pendingChunks !== null && res._pendingChunks.length > 0) {
    let i = 0;
    const chunks = res._pendingChunks;
    const cbs = res._pendingCbs!;
    while (i < chunks.length) {
      const st = res._native.streamWrite(res._reqId, chunks[i]);
      if (st === 1 || st === true) {
        const cb = cbs[i];
        i++;
        if (cb) cb();
        continue;
      }
      if (st === 2) {
        const cb = cbs[i];
        i++;
        if (cb) cb();
        chunks.splice(0, i);
        cbs.splice(0, i);
        res.writableNeedDrain = true;
        return;
      }
      if (st === 3) {
        chunks.splice(0, i);
        cbs.splice(0, i);
        res.writableNeedDrain = true;
        return;
      }
      chunks.length = 0;
      cbs.length = 0;
      res._streamClosed = true;
      res.writable = false;
      res.writableNeedDrain = false;
      if (res._endPending) {
        res._endPending = false;
        const endCb = res._endCb;
        res._endCb = undefined;
        res._activeStreams.delete(res._reqId);
        res._markFinished();
        if (endCb) endCb();
      }
      return;
    }
    chunks.length = 0;
    cbs.length = 0;
  }

  res.writableNeedDrain = false;

  if (res._endPending) {
    res._endPending = false;
    const endCb = res._endCb;
    res._endCb = undefined;
    res._native.streamEnd(res._reqId, null);
    res._activeStreams.delete(res._reqId);
    res._markFinished();
    if (endCb) endCb();
    return;
  }

  res.emit('drain');
}

/** @internal */
export function onNativeClose(res: RxResponse): void {
  res._pendingTracked = false;
  if (!res.writableEnded) {
    // The client went away before the response completed.
    const req = res.req;
    if (!req.aborted) {
      req.aborted = true;
      req.emit('aborted');
    }
    res.destroyed = true;
    req._peekSocket()?._markClosed(false);
  }
  res._streamClosed = true;
  res.writable = false;
  res.writableNeedDrain = false;
  if (res._pendingChunks !== null) {
    res._pendingChunks.length = 0;
    res._pendingCbs!.length = 0;
  }
  if (res._endPending) {
    res._endPending = false;
    const endCb = res._endCb;
    res._endCb = undefined;
    if (!res._closeEmitted) {
      res.req.emit('close');
    }
    res._markFinished();
    if (endCb) endCb();
    return;
  }
  res.req.emit('close');
  if (!res._closeEmitted) {
    res._closeEmitted = true;
    res.emit('close');
  }
}

/** @internal */
export function startStreaming(res: RxResponse): void {
  res._triggerWriteHeadHook();
  res._streaming = true;
  res.headersSent = true;
  const flat: string[] = [];
  let hasCtInMap = false;
  if (res._headers !== null) {
    for (const [k, v] of res._headers) {
      if (k === 'content-type') hasCtInMap = true;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          flat.push(k, v[i]);
        }
      } else {
        flat.push(k, v);
      }
    }
  }
  const reason = res._customReason();
  if (reason !== undefined) flat.push(':reason', reason);
  if (!hasCtInMap && res._fastCtCode !== CT_CUSTOM) {
    const ct = fastCtToString(res._fastCtCode);
    if (ct) flat.push('content-type', ct);
  }
  let ok = false;
  try {
    ok = res._native.streamStart(res._reqId, res.statusCode, flat, res._suppressXpb);
  } catch (err) {
    res._streamClosed = true;
    res.destroyed = true;
    res.writable = false;
    throw err;
  }
  if (ok) {
    res._activeStreams.set(res._reqId, res.req);
  } else {
    res._streamClosed = true;
    res.destroyed = true;
    res.writable = false;
  }
}
