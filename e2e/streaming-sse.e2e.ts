import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeChunkedBody,
  openRawSocket,
  sendRawHttp,
  type RawSocketClient,
} from './helpers/raw-http.js';
import { createApp, itRxpress, startServer, type StartedServer } from './helpers/server.js';

const servers: StartedServer[] = [];
const clients: RawSocketClient[] = [];
const timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];

function trackServer(srv: StartedServer): StartedServer {
  servers.push(srv);
  return srv;
}

function trackClient(client: RawSocketClient): RawSocketClient {
  clients.push(client);
  return client;
}

function trackTimer<T extends ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>>(t: T): T {
  timers.push(t);
  return t;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = trackTimer(setTimeout(resolve, ms));
    void t;
  });
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  let firstError: unknown;
  try {
    while (clients.length > 0) {
      try {
        clients.pop()?.destroy();
      } catch (err) {
        firstError ??= err;
      }
    }
  } finally {
    try {
      while (timers.length > 0) {
        const t = timers.pop();
        if (t !== undefined) {
          try {
            clearInterval(t as ReturnType<typeof setInterval>);
            clearTimeout(t as ReturnType<typeof setTimeout>);
          } catch (err) {
            firstError ??= err;
          }
        }
      }
    } finally {
      while (servers.length > 0) {
        try {
          await servers.pop()?.close();
        } catch (err) {
          firstError ??= err;
        }
      }
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
});

describe('Streaming, Chunked Transfer & Server-Sent Events (SSE)', () => {
  it(
    'res.write multi-chunk streaming + res.end final chunk emits valid chunked HTTP/1.1 framing incrementally',
    async () => {
      let resolveC1Arrived!: () => void;
      const c1ArrivedPromise = new Promise<void>((resolve) => {
        resolveC1Arrived = resolve;
      });
      let c1ArrivedOnClient = false;
      let c1ArrivedBeforeEnd = false;

      const app = createApp();
      app.get('/chunks', async (_req, res) => {
        res.setHeader('Content-Type', 'text/plain');
        const parts = ['c1', 'c2', 'c3', 'c4', 'c5'];
        for (const part of parts) {
          res.write(part);
          await delay(15);
        }
        let gateTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          c1ArrivedPromise,
          new Promise<void>((resolve) => {
            gateTimer = trackTimer(setTimeout(resolve, 1500));
          }),
        ]);
        if (gateTimer !== undefined) clearTimeout(gateTimer);
        c1ArrivedBeforeEnd = c1ArrivedOnClient;
        res.end('done');
      });

      const srv = trackServer(await startServer(app));
      const client = trackClient(await openRawSocket(srv.host, srv.port));

      await client.write('GET /chunks HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');

      const firstSeen = await client.readUntil('c1', 1500);
      c1ArrivedOnClient = true;
      resolveC1Arrived();
      expect(firstSeen.includes('done')).toBe(false);

      const fullBuf = await client.readUntil('0\r\n\r\n', 5000);
      expect(c1ArrivedBeforeEnd).toBe(true);
      const headerEnd = fullBuf.indexOf('\r\n\r\n');
      expect(headerEnd).toBeGreaterThan(0);

      const headersStr = fullBuf.subarray(0, headerEnd).toString('latin1').toLowerCase();
      expect(headersStr).toContain('http/1.1 200');
      expect(headersStr).toContain('transfer-encoding: chunked');

      const decoded = decodeChunkedBody(fullBuf.subarray(headerEnd + 4));
      expect(decoded.toString('utf8')).toBe('c1c2c3c4c5done');
    }
  );

  it(
    'SSE res.flushHeaders sends headers before delayed events and delivers events unbuffered in order',
    async () => {
      let resolveHeadersArrived!: () => void;
      const headersArrivedPromise = new Promise<void>((resolve) => {
        resolveHeadersArrived = resolve;
      });
      let headersArrivedOnClient = false;
      let headersArrivedBeforeWrite = false;

      const app = createApp();
      app.get('/sse', async (_req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.flushHeaders();
        let gateTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          headersArrivedPromise,
          new Promise<void>((resolve) => {
            gateTimer = trackTimer(setTimeout(resolve, 1500));
          }),
        ]);
        if (gateTimer !== undefined) clearTimeout(gateTimer);
        headersArrivedBeforeWrite = headersArrivedOnClient;
        res.write('id: 1\ndata: hello\n\n');
        await delay(20);
        res.write('id: 2\ndata: world\n\n');
        res.end();
      });

      const srv = trackServer(await startServer(app));
      const client = trackClient(await openRawSocket(srv.host, srv.port));

      await client.write('GET /sse HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');

      const hdrBuf = await client.readUntil('\r\n\r\n', 1500);
      headersArrivedOnClient = true;
      resolveHeadersArrived();
      expect(hdrBuf.includes('data: hello')).toBe(false);

      const hdrEnd = hdrBuf.indexOf('\r\n\r\n');
      const headersStr = hdrBuf.subarray(0, hdrEnd).toString('latin1').toLowerCase();
      expect(headersStr).toContain('content-type: text/event-stream');
      expect(headersStr).toContain('cache-control: no-cache');

      const fullBuf = await client.readUntil('0\r\n\r\n', 5000);
      expect(headersArrivedBeforeWrite).toBe(true);
      const decoded = decodeChunkedBody(fullBuf.subarray(hdrEnd + 4)).toString('utf8');
      expect(decoded).toBe('id: 1\ndata: hello\n\nid: 2\ndata: world\n\n');
    }
  );

  it(
    'client TCP abort fires req.on("close") promptly and stops server streaming interval',
    async () => {
      let closed = false;
      let ticks = 0;

      const app = createApp();
      app.get('/abort', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders();
        res.write('data: init\n\n');

        const interval = trackTimer(
          setInterval(() => {
            if (!closed) {
              ticks++;
              res.write(`data: tick-${ticks}\n\n`);
            }
          }, 20)
        );

        req.on('close', () => {
          closed = true;
          clearInterval(interval);
        });
      });

      const srv = trackServer(await startServer(app));
      const client = trackClient(await openRawSocket(srv.host, srv.port));

      await client.write('GET /abort HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      await client.readUntil('data: init\n\n', 3000);
      client.destroy();

      await waitForCondition(() => closed, 1500);
      expect(closed).toBe(true);

      const ticksAtClose = ticks;
      await delay(80);
      expect(ticks).toBe(ticksAtClose);
    }
  );

  it(
    'res.write returns false under paused peer backpressure and emits drain once resumed',
    async () => {
      let sawBackpressure = false;
      let sawDrain = false;
      let chunksWritten = 0;

      const app = createApp();
      app.get('/bp', async (_req, res) => {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.flushHeaders();
        const maxChunks = 512;
        for (let i = 0; i < maxChunks; i++) {
          const chunk = Buffer.alloc(65536, 0x41 + (i % 26));
          const ok = res.write(chunk);
          chunksWritten++;
          if (!ok) {
            sawBackpressure = true;
            await new Promise<void>((resolve) => {
              res.once('drain', () => resolve());
            });
            sawDrain = true;
            break;
          }
          if (i % 8 === 7) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        }
        res.write('TAIL');
        res.end();
      });

      const srv = trackServer(await startServer(app));
      const client = trackClient(await openRawSocket(srv.host, srv.port));

      await client.write('GET /bp HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      const hdrBuf = await client.readUntil('\r\n\r\n', 3000);
      client.pause();

      await delay(150);
      client.resume();

      const fullBuf = await client.readUntil('0\r\n\r\n', 15000);
      const hdrEnd = hdrBuf.indexOf('\r\n\r\n');
      const decoded = decodeChunkedBody(fullBuf.subarray(hdrEnd + 4));

      expect(sawBackpressure).toBe(true);
      expect(sawDrain).toBe(true);
      expect(decoded.length).toBe(chunksWritten * 65536 + 4);
      expect(decoded.subarray(decoded.length - 4).toString('utf8')).toBe('TAIL');
    }
  );

  it(
    'HEAD streaming, 204, and 304 emit strictly zero wire body bytes',
    async () => {
      const app = createApp();
      app.get('/stream', (_req, res) => {
        res.write('abc');
        res.end();
      });
      app.get('/empty204', (_req, res) => {
        res.status(204).end();
      });
      app.get('/empty304', (_req, res) => {
        res.status(304).end();
      });

      const srv = trackServer(await startServer(app));

      const cases: Array<{ req: string; expectedStatus: number }> = [
        { req: 'HEAD /stream HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n', expectedStatus: 200 },
        { req: 'GET /empty204 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n', expectedStatus: 204 },
        { req: 'GET /empty304 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n', expectedStatus: 304 },
      ];

      for (const tc of cases) {
        const client = trackClient(await openRawSocket(srv.host, srv.port));
        await client.write(tc.req);
        const closed = await client.waitForClose(3000);
        expect(closed).toBe(true);

        const buf = client.getBufferedData();
        const hdrEnd = buf.indexOf('\r\n\r\n');
        expect(hdrEnd).toBeGreaterThan(0);

        const statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
        expect(statusLine).toContain(` ${tc.expectedStatus} `);
        expect(buf.subarray(hdrEnd + 4).length).toBe(0);
      }
    }
  );

  it(
    'res.write after client disconnect and after res.end returns false without uncaught error or server crash',
    async () => {
      let writeAfterClose: boolean | undefined;
      let writeAfterEnd: boolean | undefined;

      const app = createApp();
      app.get('/post-close', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders();
        res.write('init\n');
        req.on('close', () => {
          trackTimer(
            setTimeout(() => {
              writeAfterClose = res.write('after');
              res.end();
            }, 20)
          );
        });
      });

      app.get('/post-end', (_req, res) => {
        res.on('error', () => {
          // Expected ERR_STREAM_WRITE_AFTER_END in Node ServerResponse
        });
        res.write('ok');
        res.end();
        writeAfterEnd = res.write('after');
      });

      app.get('/ping', (_req, res) => {
        res.send('pong');
      });

      const srv = trackServer(await startServer(app));

      const client = trackClient(await openRawSocket(srv.host, srv.port));
      await client.write('GET /post-close HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      await client.readUntil('init\n', 3000);
      client.destroy();

      await waitForCondition(() => writeAfterClose !== undefined, 1500);
      expect(writeAfterClose).toBe(false);

      const postEndRes = await fetch(`${srv.baseUrl}/post-end`);
      expect(postEndRes.status).toBe(200);
      expect(await postEndRes.text()).toBe('ok');
      expect(writeAfterEnd).toBe(false);

      const pingRes = await fetch(`${srv.baseUrl}/ping`);
      expect(pingRes.status).toBe(200);
      expect(await pingRes.text()).toBe('pong');
    }
  );

  it(
    'zero-byte writes inside chunked stream do not emit premature 0-chunk terminator',
    async () => {
      const app = createApp();
      app.get('/zero', (_req, res) => {
        res.write('');
        res.write(Buffer.alloc(0));
        res.write('o');
        res.write('');
        res.write(Buffer.alloc(0));
        res.write('k');
        res.end();
      });

      const srv = trackServer(await startServer(app));
      const res = await sendRawHttp(
        srv.host,
        srv.port,
        'GET /zero HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
      );

      expect(res.statusCode).toBe(200);
      expect(String(res.headers['transfer-encoding'] ?? '')).toContain('chunked');
      expect(res.body.toString('utf8')).toBe('ok');

      const hdrEnd = res.raw.indexOf('\r\n\r\n');
      const wireBody = res.raw.subarray(hdrEnd + 4).toString('latin1');
      expect(wireBody.startsWith('0\r\n\r\n')).toBe(false);
      expect(wireBody.endsWith('0\r\n\r\n')).toBe(true);
      expect(wireBody.indexOf('0\r\n\r\n')).toBe(wireBody.length - 5);
    }
  );

  it(
    'streaming response over HTTP/1.0 omits Transfer-Encoding: chunked and closes on end',
    async () => {
      const app = createApp();
      app.get('/http10', (_req, res) => {
        res.write('hello ');
        res.end('world');
      });

      const srv = trackServer(await startServer(app));
      const res = await sendRawHttp(
        srv.host,
        srv.port,
        'GET /http10 HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n'
      );

      expect(res.statusCode).toBe(200);
      expect(res.headers['transfer-encoding']).toBeUndefined();
      expect(res.body.toString('utf8')).toBe('hello world');
      expect(res.closed).toBe(true);
    }
  );

  it(
    'streaming with explicit Content-Length omits Transfer-Encoding and keeps keep-alive valid',
    async () => {
      const app = createApp();
      app.get('/cl', (_req, res) => {
        res.setHeader('Content-Length', '10');
        res.write('12345');
        res.end('67890');
      });
      app.get('/next', (_req, res) => {
        res.send('ok');
      });

      const srv = trackServer(await startServer(app));
      const client = trackClient(await openRawSocket(srv.host, srv.port));

      await client.write('GET /cl HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      const first = await client.readUntil('67890', 3000);
      const firstStr = first.toString('latin1');
      expect(firstStr.toLowerCase()).toContain('content-length: 10');
      expect(firstStr.toLowerCase()).not.toContain('transfer-encoding');
      expect(firstStr.endsWith('1234567890')).toBe(true);

      await client.readAvailable(0);
      await delay(20);
      const trailing = await client.readAvailable(10);
      expect(trailing.length).toBe(0);

      await client.write('GET /next HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      const second = await client.readUntil('ok', 3000);
      const secondStr = second.toString('latin1');
      expect(secondStr.startsWith('HTTP/1.1 200')).toBe(true);
      expect(secondStr.endsWith('\r\n\r\nok')).toBe(true);
    }
  );

  itRxpress(
    '100 rapid SSE stream aborts clean up without spin-loop and keep /ping < 100ms',
    async () => {
      let opened = 0;
      let closed = 0;

      const app = createApp();
      app.get('/churn', (req, res) => {
        opened++;
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders();
        res.write('data: s\n\n');

        const interval = trackTimer(
          setInterval(() => {
            res.write('data: beat\n\n');
          }, 50)
        );

        req.on('close', () => {
          clearInterval(interval);
          closed++;
        });
      });
      app.get('/ping', (_req, res) => {
        res.send('pong');
      });

      const srv = trackServer(await startServer(app));

      const tasks: Array<Promise<void>> = [];
      for (let i = 0; i < 100; i++) {
        const abortAfterHeaders = i < 50;
        tasks.push(
          (async () => {
            const c = trackClient(await openRawSocket(srv.host, srv.port));
            await c.write('GET /churn HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
            await c.readUntil(abortAfterHeaders ? '\r\n\r\n' : 'data: s\n\n', 5000);
            c.destroy();
          })()
        );
      }

      await Promise.all(tasks);
      await waitForCondition(() => closed === 100, 5000);

      expect(opened).toBe(100);
      expect(closed).toBe(100);

      const t0 = performance.now();
      const pingRes = await fetch(`${srv.baseUrl}/ping`);
      const elapsedMs = performance.now() - t0;

      expect(pingRes.status).toBe(200);
      expect(await pingRes.text()).toBe('pong');
      expect(elapsedMs).toBeLessThan(100);
    }
  );

  it(
    'keep-alive request immediately after completed chunked stream has no framing desync or dropped bytes',
    async () => {
      const app = createApp();
      app.get('/chunked', (_req, res) => {
        res.write('part1');
        res.write('part2');
        res.end();
      });
      app.get('/next', (_req, res) => {
        res.send('clean-next');
      });

      const srv = trackServer(await startServer(app));
      const client = trackClient(await openRawSocket(srv.host, srv.port));

      await client.write('GET /chunked HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      const first = await client.readUntil('0\r\n\r\n', 3000);
      const firstHdrEnd = first.indexOf('\r\n\r\n');
      expect(firstHdrEnd).toBeGreaterThan(0);
      expect(decodeChunkedBody(first.subarray(firstHdrEnd + 4)).toString('utf8')).toBe('part1part2');
      expect(first.subarray(firstHdrEnd + 4).toString('latin1').endsWith('0\r\n\r\n')).toBe(true);

      await client.readAvailable(0);
      await delay(20);
      const trailing = await client.readAvailable(10);
      expect(trailing.length).toBe(0);

      await client.write('GET /next HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      const second = await client.readUntil('clean-next', 3000);
      const secondStr = second.toString('latin1');
      expect(secondStr.startsWith('HTTP/1.1 200')).toBe(true);
      expect(secondStr.endsWith('\r\n\r\nclean-next')).toBe(true);
    }
  );
});
