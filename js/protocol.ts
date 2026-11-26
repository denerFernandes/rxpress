import type { NativeServerInstance } from './native.js';
import { hasInvalidHeaderValue, isValidHeaderName } from './security.js';

export { hasInvalidHeaderValue, isValidHeaderName };

export const METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'OPTIONS',
  'HEAD',
] as const;

export const BODY_MODE_NONE = 0;
export const BODY_MODE_JSON = 1;
export const BODY_MODE_URLENCODED = 2;
export const BODY_MODE_TEXT = 3;
export const BODY_MODE_RAW = 4;
export const BODY_MODE_TOO_LARGE = 5;
export const BODY_MODE_STREAMED = 6;

export const CT_CUSTOM = 0;
export const CT_TEXT_PLAIN = 1;
export const CT_JSON = 2;
export const CT_HTML = 3;
export const CT_OCTET_STREAM = 4;

export const RESP_FLAG_HAS_HEADERS = 0x01;
export const RESP_FLAG_IS_FILE = 0x02;
export const RESP_FLAG_SUPPRESS_POWERED_BY = 0x04;
export const RESP_FLAG_SUPPRESS_ETAG = 0x08;
export const RESP_FLAG_FILE_META = 0x10;
/** `res.send` semantics in the engine: ETag for any status, 304 when fresh, 204/205/304 stripping. */
export const RESP_FLAG_SEND = 0x20;
/** The file request ends with a u32 token; the engine reports how the response ended. */
export const RESP_FLAG_FILE_NOTIFY = 0x40;

const MAX_BATCH_BUFFER_BEFORE_FLUSH = 16 * 1024 * 1024;
const SHRINK_STREAK_THRESHOLD = 16;

/**
 * Reusable binary response batch writer.
 * Packs synchronous responses inside a batch (or same-tick async responses via microtask)
 * into a single Buffer flushed to Rust in one N-API call.
 */
export class ResponseBatchWriter {
  private buf: Buffer;
  private readonly initialCapacity: number;
  private readonly maxIdleCapacity: number;
  private smallFlushStreak = 0;
  private _lastHdrBytes = 0;
  public offset = 0;
  public inBatch = false;
  /** reqId of the most recent buffered response (used to avoid double-answering after user errors). */
  public lastReqId = -1;
  private microtaskScheduled = false;
  private readonly native: NativeServerInstance;

  constructor(native: NativeServerInstance, initialCapacity = 256 * 1024) {
    this.native = native;
    this.initialCapacity = initialCapacity;
    this.maxIdleCapacity = Math.max(initialCapacity * 4, 4 * 1024 * 1024);
    this.buf = Buffer.allocUnsafe(initialCapacity);
  }

  private ensure(needed: number): void {
    const required = this.offset + needed;
    if (required <= this.buf.length) return;
    let newSize = this.buf.length * 2;
    while (newSize < required) {
      newSize *= 2;
    }
    const next = Buffer.allocUnsafe(newSize);
    this.buf.copy(next, 0, 0, this.offset);
    this.buf = next;
  }

  private measureHeaders(headers: Map<string, string | string[]>): number {
    let count = 0;
    let bytes = 2;
    for (const [k, v] of headers) {
      // `:reason` is the engine's status-message pseudo-header (validated by RxResponse).
      if (k !== ':reason' && !isValidHeaderName(k)) {
        throw new TypeError(`Header name must be a valid HTTP token ["${k}"]`);
      }
      const kLen = Buffer.byteLength(k, 'utf8');
      if (kLen > 0xffff) {
        throw new RangeError('Header name exceeds 65535 bytes');
      }
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const sv = typeof v[i] === 'string' ? v[i] : String(v[i]);
          if (hasInvalidHeaderValue(sv)) {
            throw new TypeError(`Invalid character in header content ["${k}"]`);
          }
          const vLen = Buffer.byteLength(sv, 'utf8');
          if (vLen > 0xffff) {
            throw new RangeError('Header value exceeds 65535 bytes');
          }
          count++;
          bytes += 4 + kLen + vLen;
        }
      } else {
        const sv = typeof v === 'string' ? v : String(v);
        if (hasInvalidHeaderValue(sv)) {
          throw new TypeError(`Invalid character in header content ["${k}"]`);
        }
        const vLen = Buffer.byteLength(sv, 'utf8');
        if (vLen > 0xffff) {
          throw new RangeError('Header value exceeds 65535 bytes');
        }
        count++;
        bytes += 4 + kLen + vLen;
      }
    }
    if (count > 0xffff) {
      throw new RangeError('Header count exceeds 65535');
    }
    this._lastHdrBytes = count > 0 ? bytes : 0;
    return count;
  }

  private writeHeaders(
    b: Buffer,
    pos: number,
    headers: Map<string, string | string[]>,
    count: number
  ): number {
    b.writeUInt16LE(count, pos);
    pos += 2;
    for (const [k, v] of headers) {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const kLen = b.write(k, pos + 2, 'utf8');
          b.writeUInt16LE(kLen, pos);
          pos += 2 + kLen;
          const sv = typeof v[i] === 'string' ? v[i] : String(v[i]);
          const vLen = b.write(sv, pos + 2, 'utf8');
          b.writeUInt16LE(vLen, pos);
          pos += 2 + vLen;
        }
      } else {
        const kLen = b.write(k, pos + 2, 'utf8');
        b.writeUInt16LE(kLen, pos);
        pos += 2 + kLen;
        const sv = typeof v === 'string' ? v : String(v);
        const vLen = b.write(sv, pos + 2, 'utf8');
        b.writeUInt16LE(vLen, pos);
        pos += 2 + vLen;
      }
    }
    return pos;
  }

  public writeFastString(
    reqId: number,
    status: number,
    ctCode: number,
    flags: number,
    headers: Map<string, string | string[]> | null,
    bodyStr: string
  ): void {
    if (!Number.isInteger(status) || status < 100 || status > 999) {
      throw new RangeError(`Invalid status code: ${status}`);
    }

    let hdrCount = 0;
    let hdrBytes = 0;
    if (headers !== null && headers.size > 0) {
      hdrCount = this.measureHeaders(headers);
      hdrBytes = this._lastHdrBytes;
      if (hdrCount > 0) {
        flags |= RESP_FLAG_HAS_HEADERS;
      }
    }

    if (bodyStr.length <= 21845) {
      const maxBodyBytes = bodyStr.length * 3;
      const maxFrameLen = 12 + hdrBytes + maxBodyBytes;
      if (this.offset > 0 && this.offset + maxFrameLen > MAX_BATCH_BUFFER_BEFORE_FLUSH) {
        this.flush();
      }
      this.ensure(maxFrameLen);

      let pos = this.offset;
      const b = this.buf;

      b.writeUInt32LE(reqId, pos);
      pos += 4;
      b.writeUInt16LE(status, pos);
      pos += 2;
      b[pos++] = ctCode;
      b[pos++] = flags;

      if (hdrCount > 0 && headers !== null) {
        pos = this.writeHeaders(b, pos, headers, hdrCount);
      }

      if (bodyStr.length === 0) {
        b.writeUInt32LE(0, pos);
        pos += 4;
      } else {
        const bodyLen = b.write(bodyStr, pos + 4, 'utf8');
        b.writeUInt32LE(bodyLen, pos);
        pos += 4 + bodyLen;
      }

      this.offset = pos;
      this.lastReqId = reqId;
      this.scheduleFlushIfAsync();
      return;
    }

    const bodyLen = Buffer.byteLength(bodyStr, 'utf8');
    if (bodyLen > 0xffffffff) {
      throw new RangeError('Response body exceeds 4GiB IPC limit');
    }

    const frameLen = 12 + hdrBytes + bodyLen;
    if (this.offset > 0 && this.offset + frameLen > MAX_BATCH_BUFFER_BEFORE_FLUSH) {
      this.flush();
    }
    this.ensure(frameLen);

    let pos = this.offset;
    const b = this.buf;

    b.writeUInt32LE(reqId, pos);
    pos += 4;
    b.writeUInt16LE(status, pos);
    pos += 2;
    b[pos++] = ctCode;
    b[pos++] = flags;

    if (hdrCount > 0 && headers !== null) {
      pos = this.writeHeaders(b, pos, headers, hdrCount);
    }

    b.writeUInt32LE(bodyLen, pos);
    pos += 4;
    b.write(bodyStr, pos, bodyLen, 'utf8');
    pos += bodyLen;

    this.offset = pos;
      this.lastReqId = reqId;
    this.scheduleFlushIfAsync();
  }

  public writeFastBuffer(
    reqId: number,
    status: number,
    ctCode: number,
    flags: number,
    headers: Map<string, string | string[]> | null,
    bodyBuf: Uint8Array | null
  ): void {
    if (!Number.isInteger(status) || status < 100 || status > 999) {
      throw new RangeError(`Invalid status code: ${status}`);
    }
    const bodyLen = bodyBuf ? bodyBuf.byteLength : 0;
    if (bodyLen > 0xffffffff) {
      throw new RangeError('Response body exceeds 4GiB IPC limit');
    }

    let hdrCount = 0;
    let hdrBytes = 0;
    if (headers !== null && headers.size > 0) {
      hdrCount = this.measureHeaders(headers);
      hdrBytes = this._lastHdrBytes;
      if (hdrCount > 0) {
        flags |= RESP_FLAG_HAS_HEADERS;
      }
    }

    const frameLen = 12 + hdrBytes + bodyLen;
    if (this.offset > 0 && this.offset + frameLen > MAX_BATCH_BUFFER_BEFORE_FLUSH) {
      this.flush();
    }
    this.ensure(frameLen);

    let pos = this.offset;
    const b = this.buf;

    b.writeUInt32LE(reqId, pos);
    pos += 4;
    b.writeUInt16LE(status, pos);
    pos += 2;
    b[pos++] = ctCode;
    b[pos++] = flags;

    if (hdrCount > 0 && headers !== null) {
      pos = this.writeHeaders(b, pos, headers, hdrCount);
    }

    b.writeUInt32LE(bodyLen, pos);
    pos += 4;
    if (bodyLen > 0 && bodyBuf) {
      b.set(bodyBuf, pos);
      pos += bodyLen;
    }

    this.offset = pos;
      this.lastReqId = reqId;
    this.scheduleFlushIfAsync();
  }

  private scheduleFlushIfAsync(): void {
    if (!this.inBatch && !this.microtaskScheduled) {
      this.microtaskScheduled = true;
      queueMicrotask(() => {
        this.microtaskScheduled = false;
        this.flush();
      });
    }
  }

  public flush(): void {
    if (this.offset === 0) return;
    const bytes = this.offset;
    this.offset = 0;
    this.native.flushResponses(this.buf, bytes);

    if (this.buf.length > this.maxIdleCapacity) {
      if (bytes <= this.initialCapacity) {
        this.smallFlushStreak++;
        if (this.smallFlushStreak >= SHRINK_STREAK_THRESHOLD) {
          this.buf = Buffer.allocUnsafe(this.initialCapacity);
          this.smallFlushStreak = 0;
        }
      } else {
        this.smallFlushStreak = 0;
      }
    }
  }
}
