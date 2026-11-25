import net from 'node:net';
import tls from 'node:tls';

export interface RawHttpResponse {
  statusCode: number;
  statusLine: string;
  headersRaw: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
  raw: Buffer;
  closed: boolean;
}

export interface SendRawHttpOptions {
  tls?: boolean;
  tlsOptions?: tls.ConnectionOptions;
  timeoutMs?: number;
}

export interface OpenRawSocketOptions {
  tls?: boolean;
  tlsOptions?: tls.ConnectionOptions;
  connectTimeoutMs?: number;
}

export interface RawSocketClient {
  socket: net.Socket | tls.TLSSocket;
  write(data: string | Buffer): Promise<void>;
  writeChunksSlowly(chunks: Array<string | Buffer>, delayMs: number): Promise<void>;
  pause(): void;
  resume(): void;
  getBufferedData(): Buffer;
  readAvailable(waitMs?: number): Promise<Buffer>;
  readUntil(
    matcher: string | RegExp | ((buf: Buffer) => boolean),
    timeoutMs?: number
  ): Promise<Buffer>;
  waitForClose(timeoutMs?: number): Promise<boolean>;
  end(): Promise<void>;
  destroy(): void;
}

const HEADER_END_CRLF = Buffer.from('\r\n\r\n', 'latin1');
const CRLF = Buffer.from('\r\n', 'latin1');

function tryDecodeChunked(buf: Buffer): { decoded: Buffer; consumed: number } | null {
  const chunks: Buffer[] = [];
  let offset = 0;

  while (true) {
    const lineEnd = buf.indexOf(CRLF, offset);
    if (lineEnd === -1) return null;

    const line = buf.subarray(offset, lineEnd).toString('latin1');
    const semiIdx = line.indexOf(';');
    const sizeToken = (semiIdx >= 0 ? line.slice(0, semiIdx) : line).trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeToken)) {
      throw new Error(`Invalid chunk size line: ${JSON.stringify(line)}`);
    }

    const size = Number.parseInt(sizeToken, 16);
    offset = lineEnd + 2;

    if (size === 0) {
      if (offset + 2 <= buf.length && buf.subarray(offset, offset + 2).equals(CRLF)) {
        return { decoded: Buffer.concat(chunks), consumed: offset + 2 };
      }
      const trailersEnd = buf.indexOf(HEADER_END_CRLF, offset);
      if (trailersEnd === -1) return null;
      return { decoded: Buffer.concat(chunks), consumed: trailersEnd + 4 };
    }

    if (offset + size + 2 > buf.length) {
      return null;
    }

    chunks.push(buf.subarray(offset, offset + size));
    offset += size + 2;
  }
}

export function decodeChunkedBody(rawBody: Buffer): Buffer {
  const result = tryDecodeChunked(rawBody);
  if (!result) {
    throw new Error('Incomplete chunked HTTP body');
  }
  return result.decoded;
}

function parseHeaders(headersRaw: string): {
  statusLine: string;
  statusCode: number;
  headers: Record<string, string | string[]>;
} {
  const lines = headersRaw.split('\r\n');
  const statusLine = lines[0] ?? '';
  const statusMatch = /^HTTP\/\d+\.\d+\s+(\d{3})/.exec(statusLine);
  const statusCode = statusMatch ? Number.parseInt(statusMatch[1], 10) : 0;
  const headers: Record<string, string | string[]> = Object.create(null) as Record<
    string,
    string | string[]
  >;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    const existing = headers[name];
    if (existing === undefined) {
      headers[name] = val;
    } else if (Array.isArray(existing)) {
      existing.push(val);
    } else {
      headers[name] = [existing, val];
    }
  }

  return { statusLine, statusCode, headers };
}

function getHeaderSingle(
  headers: Record<string, string | string[]>,
  name: string
): string | undefined {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[v.length - 1];
  return v;
}

function isHeadPayload(rawPayload: string | Buffer): boolean {
  const prefix = (typeof rawPayload === 'string'
    ? rawPayload.slice(0, 16)
    : rawPayload.subarray(0, 16).toString('latin1')
  ).toUpperCase();
  return prefix.startsWith('HEAD ');
}

function tryParseCompleteResponse(
  raw: Buffer,
  headRequest: boolean
): {
  statusCode: number;
  statusLine: string;
  headersRaw: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
  totalBytes: number;
  expectsClose: boolean;
} | null {
  const headerEnd = raw.indexOf(HEADER_END_CRLF);
  if (headerEnd === -1) return null;

  const headersRaw = raw.subarray(0, headerEnd).toString('latin1');
  const { statusLine, statusCode, headers } = parseHeaders(headersRaw);
  const bodyStart = headerEnd + 4;
  const bodySlice = raw.subarray(bodyStart);

  const connHeader = (getHeaderSingle(headers, 'connection') ?? '').toLowerCase();
  const isHttp10 = statusLine.toUpperCase().startsWith('HTTP/1.0');
  const expectsClose =
    connHeader.split(',').some((t) => t.trim() === 'close') ||
    (isHttp10 && !connHeader.split(',').some((t) => t.trim() === 'keep-alive'));

  if (headRequest || statusCode === 204 || statusCode === 304 || (statusCode >= 100 && statusCode < 200)) {
    return {
      statusCode,
      statusLine,
      headersRaw,
      headers,
      body: Buffer.alloc(0),
      totalBytes: bodyStart,
      expectsClose,
    };
  }

  const teHeader = (getHeaderSingle(headers, 'transfer-encoding') ?? '').toLowerCase();
  if (teHeader.includes('chunked')) {
    const decoded = tryDecodeChunked(bodySlice);
    if (!decoded) return null;
    return {
      statusCode,
      statusLine,
      headersRaw,
      headers,
      body: decoded.decoded,
      totalBytes: bodyStart + decoded.consumed,
      expectsClose,
    };
  }

  const clHeader = getHeaderSingle(headers, 'content-length');
  if (clHeader !== undefined) {
    const contentLength = Number.parseInt(clHeader, 10);
    if (Number.isFinite(contentLength) && contentLength >= 0) {
      if (bodySlice.length < contentLength) return null;
      return {
        statusCode,
        statusLine,
        headersRaw,
        headers,
        body: Buffer.from(bodySlice.subarray(0, contentLength)),
        totalBytes: bodyStart + contentLength,
        expectsClose,
      };
    }
  }

  return null;
}

function stripLeadingInterimResponses(raw: Buffer, headRequest: boolean): Buffer {
  let current = raw;
  while (current.length > 0) {
    let parsed: ReturnType<typeof tryParseCompleteResponse> = null;
    try {
      parsed = tryParseCompleteResponse(current, headRequest);
    } catch {
      break;
    }
    if (!parsed) break;
    if (parsed.statusCode >= 100 && parsed.statusCode < 200 && parsed.statusCode !== 101) {
      current = current.subarray(parsed.totalBytes);
      continue;
    }
    break;
  }
  return current;
}

export function sendRawHttp(
  host: string,
  port: number,
  rawPayload: string | Buffer,
  opts?: SendRawHttpOptions
): Promise<RawHttpResponse> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const payloadBuf = typeof rawPayload === 'string' ? Buffer.from(rawPayload, 'latin1') : rawPayload;
  const headRequest = isHeadPayload(payloadBuf);

  return new Promise<RawHttpResponse>((resolve, reject) => {
    let connected = false;
    let settled = false;
    let socketClosed = false;
    const chunks: Buffer[] = [];
    let closeGraceTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      clearTimeout(overallTimer);
      if (closeGraceTimer) {
        clearTimeout(closeGraceTimer);
        closeGraceTimer = null;
      }
    };

    const socket: net.Socket | tls.TLSSocket = opts?.tls
      ? tls.connect({
          host,
          port,
          rejectUnauthorized: false,
          ...(opts.tlsOptions ?? {}),
        })
      : net.connect({ host, port });

    const overallTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (closeGraceTimer) {
        clearTimeout(closeGraceTimer);
        closeGraceTimer = null;
      }
      socket.destroy();
      const raw = stripLeadingInterimResponses(Buffer.concat(chunks), headRequest);
      let parsed: ReturnType<typeof tryParseCompleteResponse> = null;
      try {
        parsed = tryParseCompleteResponse(raw, headRequest);
      } catch {
        parsed = null;
      }
      if (parsed) {
        resolve({
          statusCode: parsed.statusCode,
          statusLine: parsed.statusLine,
          headersRaw: parsed.headersRaw,
          headers: parsed.headers,
          body: parsed.body,
          raw,
          closed: socketClosed,
        });
      } else {
        reject(new Error(`sendRawHttp timed out after ${timeoutMs}ms (received ${raw.length} bytes)`));
      }
    }, timeoutMs);

    const finalize = (closedNow: boolean) => {
      if (settled) return;
      settled = true;
      clearTimers();
      socketClosed = socketClosed || closedNow;

      const raw = stripLeadingInterimResponses(Buffer.concat(chunks), headRequest);
      let parsed: ReturnType<typeof tryParseCompleteResponse> = null;
      try {
        parsed = tryParseCompleteResponse(raw, headRequest);
      } catch {
        parsed = null;
      }
      if (parsed) {
        if (!socketClosed && !socket.destroyed) {
          socket.destroy();
        }
        resolve({
          statusCode: parsed.statusCode,
          statusLine: parsed.statusLine,
          headersRaw: parsed.headersRaw,
          headers: parsed.headers,
          body: parsed.body,
          raw,
          closed: socketClosed,
        });
        return;
      }

      const headerEnd = raw.indexOf(HEADER_END_CRLF);
      if (headerEnd !== -1) {
        const headersRaw = raw.subarray(0, headerEnd).toString('latin1');
        const { statusLine, statusCode, headers } = parseHeaders(headersRaw);
        let body: Buffer = raw.subarray(headerEnd + 4);
        const te = (getHeaderSingle(headers, 'transfer-encoding') ?? '').toLowerCase();
        if (te.includes('chunked')) {
          try {
            body = decodeChunkedBody(body);
          } catch {
            // Preserve raw slice if server closed mid-chunk
          }
        }
        if (!socketClosed && !socket.destroyed) {
          socket.destroy();
        }
        resolve({
          statusCode,
          statusLine,
          headersRaw,
          headers,
          body: Buffer.from(body),
          raw,
          closed: socketClosed,
        });
        return;
      }

      if (!socketClosed && !socket.destroyed) {
        socket.destroy();
      }
      resolve({
        statusCode: 0,
        statusLine: '',
        headersRaw: '',
        headers: Object.create(null) as Record<string, string | string[]>,
        body: Buffer.alloc(0),
        raw,
        closed: socketClosed,
      });
    };

    const onConnect = () => {
      connected = true;
      socket.write(payloadBuf);
    };

    if (opts?.tls) {
      socket.once('secureConnect', onConnect);
    } else {
      socket.once('connect', onConnect);
    }

    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      chunks.push(chunk);
      let raw = Buffer.concat(chunks);
      let parsed: ReturnType<typeof tryParseCompleteResponse> = null;

      while (true) {
        try {
          parsed = tryParseCompleteResponse(raw, headRequest);
        } catch {
          // Wait for close if malformed chunked frame
          return;
        }
        if (!parsed) return;

        // Strip interim 1xx frames (except 101 Switching Protocols) immediately
        if (parsed.statusCode >= 100 && parsed.statusCode < 200 && parsed.statusCode !== 101) {
          const rest = raw.subarray(parsed.totalBytes);
          chunks.length = 0;
          if (rest.length > 0) {
            const copy = Buffer.from(rest);
            chunks.push(copy);
            raw = copy;
            continue;
          }
          return;
        }

        break;
      }

      if (parsed.expectsClose) {
        if (!closeGraceTimer) {
          closeGraceTimer = setTimeout(() => finalize(socketClosed), 150);
        }
      } else {
        finalize(false);
      }
    });

    socket.once('end', () => {
      socketClosed = true;
      finalize(true);
    });

    socket.once('close', () => {
      socketClosed = true;
      finalize(true);
    });

    socket.once('error', (err: Error) => {
      if (settled) return;
      if (!connected) {
        settled = true;
        clearTimers();
        reject(err);
      } else {
        socketClosed = true;
        finalize(true);
      }
    });
  });
}

export function openRawSocket(
  host: string,
  port: number,
  opts?: OpenRawSocketOptions
): Promise<RawSocketClient> {
  const connectTimeoutMs = opts?.connectTimeoutMs ?? 5000;

  return new Promise<RawSocketClient>((resolve, reject) => {
    let settled = false;
    let closed = false;
    const receivedChunks: Buffer[] = [];
    const dataWaiters: Array<() => void> = [];
    const closeWaiters: Array<(closed: boolean) => void> = [];

    const socket: net.Socket | tls.TLSSocket = opts?.tls
      ? tls.connect({
          host,
          port,
          rejectUnauthorized: false,
          ...(opts.tlsOptions ?? {}),
        })
      : net.connect({ host, port });

    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`openRawSocket timed out connecting to ${host}:${port}`));
    }, connectTimeoutMs);

    const notifyData = () => {
      while (dataWaiters.length > 0) {
        const fn = dataWaiters.shift();
        fn?.();
      }
    };

    const markClosed = () => {
      closed = true;
      notifyData();
      while (closeWaiters.length > 0) {
        const fn = closeWaiters.shift();
        fn?.(true);
      }
    };

    socket.on('data', (chunk: Buffer) => {
      receivedChunks.push(chunk);
      notifyData();
    });

    socket.once('end', () => {
      markClosed();
    });

    socket.once('close', () => {
      markClosed();
    });

    socket.once('error', (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        reject(err);
        return;
      }
      markClosed();
    });

    const onReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);

      const client: RawSocketClient = {
        socket,
        write(data: string | Buffer): Promise<void> {
          return new Promise<void>((res, rej) => {
            if (closed || socket.destroyed) {
              rej(new Error('Socket is closed'));
              return;
            }
            const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
            socket.write(buf, (err?: Error | null) => {
              if (err) rej(err);
              else res();
            });
          });
        },
        async writeChunksSlowly(chunksToWrite: Array<string | Buffer>, delayMs: number): Promise<void> {
          for (let i = 0; i < chunksToWrite.length; i++) {
            if (closed || socket.destroyed) return;
            try {
              await client.write(chunksToWrite[i]);
            } catch {
              return;
            }
            if (i < chunksToWrite.length - 1) {
              await new Promise<void>((r) => setTimeout(r, delayMs));
            }
          }
        },
        pause(): void {
          socket.pause();
        },
        resume(): void {
          socket.resume();
        },
        getBufferedData(): Buffer {
          return Buffer.concat(receivedChunks);
        },
        async readAvailable(waitMs = 100): Promise<Buffer> {
          if (receivedChunks.length > 0 || closed) {
            const out = Buffer.concat(receivedChunks);
            receivedChunks.length = 0;
            return out;
          }
          await new Promise<void>((res) => {
            const t = setTimeout(res, waitMs);
            dataWaiters.push(() => {
              clearTimeout(t);
              res();
            });
          });
          const out = Buffer.concat(receivedChunks);
          receivedChunks.length = 0;
          return out;
        },
        async readUntil(
          matcher: string | RegExp | ((buf: Buffer) => boolean),
          timeoutMs = 5000
        ): Promise<Buffer> {
          const matches = (buf: Buffer): boolean => {
            if (typeof matcher === 'string') {
              return buf.includes(matcher);
            }
            if (matcher instanceof RegExp) {
              return matcher.test(buf.toString('latin1'));
            }
            return matcher(buf);
          };

          const deadline = Date.now() + timeoutMs;
          while (true) {
            const combined = Buffer.concat(receivedChunks);
            if (matches(combined)) {
              return combined;
            }
            if (closed) {
              return combined;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              throw new Error(
                `readUntil timed out after ${timeoutMs}ms (received ${combined.length} bytes)`
              );
            }
            await new Promise<void>((res) => {
              const t = setTimeout(res, remaining);
              dataWaiters.push(() => {
                clearTimeout(t);
                res();
              });
            });
          }
        },
        waitForClose(timeoutMs = 5000): Promise<boolean> {
          if (closed) return Promise.resolve(true);
          return new Promise<boolean>((res) => {
            const t = setTimeout(() => {
              res(false);
            }, timeoutMs);
            closeWaiters.push((isClosed) => {
              clearTimeout(t);
              res(isClosed);
            });
          });
        },
        end(): Promise<void> {
          return new Promise<void>((res) => {
            if (socket.destroyed) {
              res();
              return;
            }
            socket.end(() => res());
          });
        },
        destroy(): void {
          socket.destroy();
        },
      };

      resolve(client);
    };

    if (opts?.tls) {
      socket.once('secureConnect', onReady);
    } else {
      socket.once('connect', onReady);
    }
  });
}
