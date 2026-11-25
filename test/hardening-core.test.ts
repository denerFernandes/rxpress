import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import rxpress, { type NextFunction, type Request, type Response, type ServerHandle } from '../js/index.js';
import { loadNativeAddon, type NativeServerInstance } from '../js/native.js';
import { ResponseBatchWriter } from '../js/protocol.js';

let activeServers: ServerHandle[] = [];
let tempDirs: string[] = [];

afterEach(async () => {
  for (const srv of activeServers) {
    await srv.close();
  }
  activeServers = [];
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function startApp(
  app: ReturnType<typeof rxpress>,
  port = 0,
  host = '127.0.0.1'
): { handle: ServerHandle; port: number; base: string } {
  const handle = app.listen(port, host);
  activeServers.push(handle);
  const addr = handle.address();
  if (!addr) throw new Error('Expected bound address');
  return { handle, port: addr.port, base: `http://127.0.0.1:${addr.port}` };
}

function sendRawAndReadAll(
  port: number,
  chunks: Array<string | Buffer>,
  delayBetweenMs = 0
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const received: Buffer[] = [];
    socket.on('data', (d: Buffer) => received.push(d));
    socket.on('error', (err: Error) => {
      if (received.length > 0) {
        resolve(Buffer.concat(received).toString('utf8'));
      } else {
        reject(err);
      }
    });
    socket.on('end', () => resolve(Buffer.concat(received).toString('utf8')));
    socket.on('close', () => resolve(Buffer.concat(received).toString('utf8')));
    socket.on('connect', async () => {
      for (let i = 0; i < chunks.length; i++) {
        if (socket.destroyed) break;
        socket.write(chunks[i]);
        if (delayBetweenMs > 0 && i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, delayBetweenMs));
        }
      }
    });
  });
}

function generateSelfSignedCert(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'rxpress-test-tls-'));
  tempDirs.push(dir);
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=127.0.0.1"`,
    { stdio: 'ignore' }
  );
  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}

describe('core engine behaviour', () => {
  describe('1. Engine Timeouts', () => {
    it('returns 408 and closes when headers stall (headersTimeoutMs)', async () => {
      const app = rxpress();
      app.set('headersTimeoutMs', 120);
      app.get('/ok', (_req: Request, res: Response) => res.send('ok'));

      const { port } = startApp(app);
      const raw = await sendRawAndReadAll(port, ['GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\n']);
      expect(raw).toContain('HTTP/1.1 408 Request Timeout');
      expect(raw.toLowerCase()).toContain('connection: close');
    });

    it('returns 408 and closes when request body stalls (requestTimeoutMs)', async () => {
      const app = rxpress();
      app.set('requestTimeoutMs', 140);
      app.post('/upload', (_req: Request, res: Response) => res.send('ok'));

      const { port } = startApp(app);
      const raw = await sendRawAndReadAll(port, [
        'POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\npartial',
      ]);
      expect(raw).toContain('HTTP/1.1 408 Request Timeout');
      expect(raw.toLowerCase()).toContain('connection: close');
    });

    it('closes idle Keep-Alive sockets cleanly after keepAliveTimeoutMs', async () => {
      const app = rxpress();
      app.set('keepAliveTimeoutMs', 100);
      app.get('/ping', (_req: Request, res: Response) => res.send('pong'));

      const { port } = startApp(app);
      const socket = net.connect({ host: '127.0.0.1', port });
      const chunks: Buffer[] = [];
      let closedAt = 0;
      const connectedAt = Date.now();

      await new Promise<void>((resolve, reject) => {
        socket.on('error', reject);
        socket.on('data', (d: Buffer) => chunks.push(d));
        socket.on('close', () => {
          closedAt = Date.now();
          resolve();
        });
        socket.on('connect', () => {
          socket.write('GET /ping HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
        });
      });

      const response = Buffer.concat(chunks).toString('utf8');
      expect(response).toContain('HTTP/1.1 200 OK');
      expect(response).toContain('pong');
      expect(response).not.toContain('408');
      expect(closedAt - connectedAt).toBeGreaterThanOrEqual(70);
      expect(closedAt - connectedAt).toBeLessThan(1500);
    });

    it('returns 504 Gateway Timeout when JS handler hangs past handlerTimeoutMs', async () => {
      const app = rxpress();
      app.set('handlerTimeoutMs', 120);
      app.set('shutdownTimeoutMs', 50);
      app.get('/hang', (_req: Request, _res: Response) => {
        // Intentionally never ends response
      });

      const { port } = startApp(app);
      const raw = await sendRawAndReadAll(port, [
        'GET /hang HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
      ]);
      expect(raw).toContain('HTTP/1.1 504 Gateway Timeout');
      expect(raw.toLowerCase()).toContain('connection: close');
    });

    it('enforces short headersTimeoutMs accurately without slack bypass (408 vs 200)', async () => {
      const app = rxpress();
      app.set('headersTimeoutMs', 500);
      app.get('/ok', (_req: Request, res: Response) => res.send('ok'));

      const { port } = startApp(app);

      // Fast headers well within 500ms -> 200 OK
      const fastResp = await sendRawAndReadAll(port, [
        'GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
      ]);
      expect(fastResp).toContain('HTTP/1.1 200 OK');
      expect(fastResp).toContain('ok');

      // Headers completing at ~545ms (> 500ms, inside prior 20% slack window) -> 408 Request Timeout
      const slowResp = await sendRawAndReadAll(
        port,
        ['GET /ok HTTP/1.1\r\n', 'Host: 127.0.0.1\r\nConnection: close\r\n\r\n'],
        545
      );
      expect(slowResp).toContain('HTTP/1.1 408 Request Timeout');
      expect(slowResp.toLowerCase()).toContain('connection: close');
      expect(slowResp).not.toContain('HTTP/1.1 200 OK');
    });
  });

  describe('2. Connection Limits (maxConnections)', () => {
    it('rejects connections exceeding maxConnections with 503 and recovers after close', async () => {
      const app = rxpress();
      app.set('maxConnections', 2);
      app.get('/ok', (_req: Request, res: Response) => res.send('ok'));

      const { port } = startApp(app);

      const holdOne = (): Promise<net.Socket> =>
        new Promise((resolve, reject) => {
          const s = net.connect({ host: '127.0.0.1', port }, () => {
            s.write('GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
          });
          s.once('data', () => resolve(s));
          s.on('error', reject);
        });

      const c1 = await holdOne();
      const c2 = await holdOne();

      try {
        const resp3 = await sendRawAndReadAll(port, [
          'GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
        ]);
        expect(resp3).toContain('HTTP/1.1 503 Service Unavailable');
        expect(resp3.toLowerCase()).toContain('connection: close');
      } finally {
        c1.destroy();
      }

      // Wait briefly for permit release on c1 drop
      await new Promise((r) => setTimeout(r, 40));

      const respAfter = await sendRawAndReadAll(port, [
        'GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
      ]);
      expect(respAfter).toContain('HTTP/1.1 200 OK');
      expect(respAfter).toContain('ok');
      c2.destroy();
    });

    it('completes 503 maxConnections rejection with clean TCP FIN and zero ECONNRESET', async () => {
      const app = rxpress();
      app.set('maxConnections', 2);
      app.get('/ok', (_req: Request, res: Response) => res.send('ok'));

      const { port } = startApp(app);

      const holdOne = (): Promise<net.Socket> =>
        new Promise((resolve, reject) => {
          const s = net.connect({ host: '127.0.0.1', port }, () => {
            s.write('GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
          });
          s.once('data', () => resolve(s));
          s.on('error', reject);
        });

      const c1 = await holdOne();
      const c2 = await holdOne();

      try {
        const probeExcess = (): Promise<{ raw: string; ended: boolean; errors: string[] }> =>
          new Promise((resolve) => {
            const sock = net.connect({ host: '127.0.0.1', port }, () => {
              sock.write('GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
            });
            const chunks: Buffer[] = [];
            const errors: string[] = [];
            let ended = false;
            sock.on('data', (d: Buffer) => chunks.push(d));
            sock.on('end', () => {
              ended = true;
            });
            sock.on('error', (err: Error & { code?: string }) => {
              errors.push(err.code || err.message);
            });
            sock.on('close', () => {
              resolve({
                raw: Buffer.concat(chunks).toString('utf8'),
                ended,
                errors,
              });
            });
          });

        const results = await Promise.all([probeExcess(), probeExcess(), probeExcess()]);
        for (const r of results) {
          expect(r.errors).toEqual([]);
          expect(r.ended).toBe(true);
          expect(r.raw).toContain('HTTP/1.1 503 Service Unavailable');
          expect(r.raw.toLowerCase()).toContain('connection: close');
          expect(r.raw).toContain('Service Unavailable');
        }
      } finally {
        c1.destroy();
        c2.destroy();
      }
    });
  });

  describe('3. Strict HTTP/1.1 Framing & Anti-Smuggling', () => {
    it('rejects duplicate CL, invalid/negative/+ CL, CL+TE, malformed TE, missing/duplicate Host with 400', async () => {
      const app = rxpress();
      app.all('*', (_req: Request, res: Response) => res.send('reached'));
      const { port } = startApp(app);

      const smugglingPayloads = [
        'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\nhello',
        'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello!',
        'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: +5\r\n\r\nhello',
        'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: -1\r\n\r\n',
        'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
        'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n0\r\n\r\n',
        'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n',
        'POST / HTTP/1.0\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
        'GET / HTTP/1.1\r\nUser-Agent: test\r\n\r\n',
        'GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n',
      ];

      for (const reqRaw of smugglingPayloads) {
        const resp = await sendRawAndReadAll(port, [reqRaw]);
        expect(resp).toContain('HTTP/1.1 400 Bad Request');
        expect(resp.toLowerCase()).toContain('connection: close');
      }
    });

    it('enforces defaultBodyLimitBytes directly in Rust even without JS body-parser middleware (413)', async () => {
      const app = rxpress();
      app.set('defaultBodyLimitBytes', 128);
      app.post('/no-mw', (_req: Request, res: Response) => res.send('should-not-reach'));

      const { port } = startApp(app);
      const bigBody = 'a'.repeat(512);
      const resp = await sendRawAndReadAll(port, [
        `POST /no-mw HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${bigBody.length}\r\n\r\n${bigBody}`,
      ]);
      expect(resp).toContain('HTTP/1.1 413 Payload Too Large');
      expect(resp.toLowerCase()).toContain('connection: close');
    });

    it('enforces maxHeadersCount (including >64 heap fallback) and maxHeaderSizeBytes with 431', async () => {
      const app = rxpress();
      app.set('maxHeadersCount', 70);
      app.set('maxHeaderSizeBytes', 4096);
      app.get('/h', (_req: Request, res: Response) => res.send('ok'));

      const { port } = startApp(app);

      // 70 headers total (Host + 69 X-H-i) -> succeeds!
      let okReq = 'GET /h HTTP/1.1\r\nHost: 127.0.0.1\r\n';
      for (let i = 0; i < 69; i++) okReq += `X-H-${i}: v\r\n`;
      okReq += 'Connection: close\r\n'; // 71st! Wait: let's send 68 + Host + Connection = 70
      let exact70 = 'GET /h HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n';
      for (let i = 0; i < 68; i++) exact70 += `X-H-${i}: v\r\n`;
      exact70 += '\r\n';
      const resp70 = await sendRawAndReadAll(port, [exact70]);
      expect(resp70).toContain('HTTP/1.1 200 OK');

      // 71 headers -> 431
      let over70 = 'GET /h HTTP/1.1\r\nHost: 127.0.0.1\r\n';
      for (let i = 0; i < 70; i++) over70 += `X-H-${i}: v\r\n`;
      over70 += '\r\n';
      const resp71 = await sendRawAndReadAll(port, [over70]);
      expect(resp71).toContain('HTTP/1.1 431 Request Header Fields Too Large');
      expect(resp71.toLowerCase()).toContain('connection: close');

      // > maxHeaderSizeBytes -> 431
      const hugeHdr = `GET /h HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Big: ${'x'.repeat(4500)}\r\n\r\n`;
      const respHuge = await sendRawAndReadAll(port, [hugeHdr]);
      expect(respHuge).toContain('HTTP/1.1 431 Request Header Fields Too Large');
    });

    it('handles Expect: 100-continue, rejects oversized before 100-continue, and returns 417 on unknown Expect', async () => {
      const app = rxpress();
      app.set('defaultBodyLimitBytes', 64);
      app.use(rxpress.text({ limit: '64b' }));
      app.post('/exp', (req: Request, res: Response) => res.send(`got:${req.body}`));

      const { port } = startApp(app);

      // Valid Expect: 100-continue -> 100 Continue then 200 OK
      const socket = net.connect({ host: '127.0.0.1', port });
      const transcript = await new Promise<string>((resolve, reject) => {
        const bufs: Buffer[] = [];
        let sentBody = false;
        socket.on('error', reject);
        socket.on('data', (d: Buffer) => {
          bufs.push(d);
          const s = Buffer.concat(bufs).toString('utf8');
          if (!sentBody && s.includes('100 Continue')) {
            sentBody = true;
            socket.write('hello-100');
          }
        });
        socket.on('end', () => resolve(Buffer.concat(bufs).toString('utf8')));
        socket.on('close', () => resolve(Buffer.concat(bufs).toString('utf8')));
        socket.on('connect', () => {
          socket.write(
            'POST /exp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\nExpect: 100-continue\r\nContent-Length: 9\r\nConnection: close\r\n\r\n'
          );
        });
      });
      expect(transcript).toContain('HTTP/1.1 100 Continue');
      expect(transcript).toContain('HTTP/1.1 200 OK');
      expect(transcript).toContain('got:hello-100');

      // Oversized Expect: 100-continue -> immediate 413 WITHOUT 100 Continue
      const overResp = await sendRawAndReadAll(port, [
        'POST /exp HTTP/1.1\r\nHost: 127.0.0.1\r\nExpect: 100-continue\r\nContent-Length: 9999\r\n\r\n',
      ]);
      expect(overResp).not.toContain('100 Continue');
      expect(overResp).toContain('HTTP/1.1 413 Payload Too Large');

      // Unknown Expect -> 417
      const exp417 = await sendRawAndReadAll(port, [
        'POST /exp HTTP/1.1\r\nHost: 127.0.0.1\r\nExpect: 200-ok\r\n\r\n',
      ]);
      expect(exp417).toContain('HTTP/1.1 417 Expectation Failed');
    });

    it('drains chunked trailers cleanly before pipelined request and rejects malformed chunks', async () => {
      const app = rxpress();
      app.set('defaultBodyLimitBytes', 64);
      app.use(rxpress.text({ limit: '64b' }));
      app.post('/chunk', (req: Request, res: Response) => res.send(`body=${req.body}`));
      app.get('/next', (_req: Request, res: Response) => res.send('next-ok'));

      const { port } = startApp(app);

      const pipe =
        'POST /chunk HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n' +
        '5;ext=1\r\nhello\r\n0\r\nX-Trailer: val\r\n\r\n' +
        'GET /next HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n';
      const resp = await sendRawAndReadAll(port, [pipe]);
      expect(resp).toContain('body=hello');
      expect(resp).toContain('next-ok');
      expect(resp.toLowerCase()).toContain('connection: close');

      // Malformed chunk missing CRLF -> 400
      const badChunk = await sendRawAndReadAll(port, [
        'POST /chunk HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabcXX0\r\n\r\n',
      ]);
      expect(badChunk).toContain('HTTP/1.1 400 Bad Request');

      // Chunked > limit -> 413
      const bigChunk = await sendRawAndReadAll(port, [
        `POST /chunk HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n50\r\n${'x'.repeat(80)}\r\n0\r\n\r\n`,
      ]);
      expect(bigChunk).toContain('HTTP/1.1 413 Payload Too Large');
    });

    it('flushes earlier pipelined responses before mid-batch parse error and close', async () => {
      const app = rxpress();
      app.get('/first', (_req: Request, res: Response) => res.send('first-ok'));

      const { port } = startApp(app);
      const raw = await sendRawAndReadAll(port, [
        'GET /first HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nGET /second HTTP/1.1\r\n\r\n',
      ]);
      expect(raw).toContain('HTTP/1.1 200 OK');
      expect(raw).toContain('first-ok');
      expect(raw).toContain('HTTP/1.1 400 Bad Request');
      expect(raw.indexOf('first-ok')).toBeLessThan(raw.indexOf('400 Bad Request'));
    });

    it('emits Connection: close on static fast-path responses when requested', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rxpress-test-static-'));
      tempDirs.push(dir);
      writeFileSync(join(dir, 'hello.txt'), 'static-hello');

      const app = rxpress();
      app.use('/st', rxpress.static(dir));
      const { port } = startApp(app);

      // Send two requests on the same socket: first populates TL_STATIC_CACHE, second hits fast path with Connection: close
      const raw = await sendRawAndReadAll(port, [
        'GET /st/hello.txt HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
          'GET /st/hello.txt HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
      ]);
      const lastRespIdx = raw.lastIndexOf('HTTP/1.1 200 OK');
      expect(lastRespIdx).toBeGreaterThan(0);
      expect(raw.slice(lastRespIdx).toLowerCase()).toContain('connection: close');
      expect(raw).toContain('static-hello');
    });
  });

  describe('4. Response CRLF Validation, Status Bounds, & IPC Large Payload Safety', () => {
    it('validates status and headers in ResponseBatchWriter before mutating buffer', () => {
      const mockNative: NativeServerInstance = {
        setConfig() {},
        addRoute: () => true,
        addStatic() {},
        addBodyRule() {},
        start: () => ({ address: '127.0.0.1', port: 0, family: 'IPv4' }),
        drainBatchInto: () => 0,
        drainClosedStreams: () => null,
        takeRequestBody: () => null,
        releaseRequestBody() {},
        flushResponses() {},
        streamStart: () => true,
        streamWrite: () => true,
        streamEnd() {},
        beginClose: (_t, cb) => cb(),
        getMetrics: () => null,
        close() {},
      };
      const writer = new ResponseBatchWriter(mockNative, 1024);

      expect(() => writer.writeFastString(1, 99, 1, 0, null, 'bad')).toThrow(RangeError);
      expect(() => writer.writeFastString(1, 1000, 1, 0, null, 'bad')).toThrow(RangeError);
      expect(writer.offset).toBe(0);

      const crlfVal = new Map<string, string | string[]>([['X-Test', 'ok\r\nX-Injected: 1']]);
      expect(() => writer.writeFastString(1, 200, 1, 0, crlfVal, 'bad')).toThrow(TypeError);
      expect(writer.offset).toBe(0);

      const badName = new Map<string, string | string[]>([['Bad Name', 'ok']]);
      expect(() => writer.writeFastBuffer(1, 200, 1, 0, badName, Buffer.from('bad'))).toThrow(TypeError);
      expect(writer.offset).toBe(0);
    });

    it('rejects CRLF headers on buffered & streaming responses without hanging or leaking headers', async () => {
      const app = rxpress();
      app.get('/crlf-buf', (_req: Request, res: Response) => {
        res.setHeader('X-Custom', 'abc\r\nX-Evil: pwned');
        res.send('should-fail');
      });
      app.get('/good', (_req: Request, res: Response) => {
        res.send('good-ok');
      });
      app.get('/crlf-stream', (_req: Request, res: Response) => {
        res.setHeader('X-Stream', 'val\nInjected: yes');
        res.flushHeaders();
        res.write('chunk');
        res.end();
      });
      app.get('/crlf-finalhandler', (_req: Request, res: Response, next: NextFunction) => {
        res.setHeader('X-Poison', 'bad\r\nEvil: 1');
        next(new Error('boom'));
      });

      const { port, base } = startApp(app);

      // Pipelined [crlf-buf, good] -> first fails with 500 without X-Evil, second succeeds!
      const pipeResp = await sendRawAndReadAll(port, [
        'GET /crlf-buf HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
          'GET /good HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
      ]);
      expect(pipeResp).toContain('HTTP/1.1 500 Internal Server Error');
      expect(pipeResp).not.toContain('X-Evil');
      expect(pipeResp).toContain('good-ok');

      // Streaming CRLF header -> 500 without hanging
      const streamResp = await fetch(`${base}/crlf-stream`);
      expect(streamResp.status).toBe(500);
      expect(streamResp.headers.get('injected')).toBeNull();

      // makeFinalHandler fallback when res._headers is poisoned before next(err)
      const finalResp = await fetch(`${base}/crlf-finalhandler`);
      expect(finalResp.status).toBe(500);
      expect(finalResp.headers.get('evil')).toBeNull();
      // Express/Node parity: setHeader() throws ERR_INVALID_CHAR synchronously, so the error
      // reaches the final handler (dev mode shows the message) and nothing is injected.
      expect(await finalResp.text()).toContain('Invalid character in header content');
      expect(finalResp.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('handles >512KB payloads (resize sentinel) without scheduled flag starvation', async () => {
      const app = rxpress();
      app.set('defaultBodyLimitBytes', 2 * 1024 * 1024);
      app.use(rxpress.text({ limit: '2mb' }));
      app.post('/big', (req: Request, res: Response) => {
        res.json({ len: (req.body as string).length });
      });
      app.get('/after', (_req: Request, res: Response) => res.send('alive'));

      const { base } = startApp(app);
      const payload = 'z'.repeat(700 * 1024);
      const r1 = await fetch(`${base}/big`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: payload,
      });
      expect(r1.status).toBe(200);
      expect(await r1.json()).toEqual({ len: 700 * 1024 });

      const r2 = await fetch(`${base}/after`);
      expect(r2.status).toBe(200);
      expect(await r2.text()).toBe('alive');
    });
  });

  describe('5. Graceful Lifecycle & Guards', () => {
    it('drains in-flight async handlers before close() resolves and allows immediate port rebind', async () => {
      const app = rxpress();
      app.set('shutdownTimeoutMs', 2000);
      let handlerCompleted = false;
      let handlerStarted = false;
      app.get('/slow', async (_req: Request, res: Response) => {
        handlerStarted = true;
        await new Promise((r) => setTimeout(r, 80));
        handlerCompleted = true;
        res.send('finished');
      });

      const { handle, port, base } = startApp(app);

      // Start in-flight request and wait until the handler is really running (a fixed delay
      // is not enough on a slow CI runner: close() would reset a connection still being set up).
      const respPromise = fetch(`${base}/slow`);
      const startedBy = Date.now() + 5000;
      while (!handlerStarted && Date.now() < startedBy) await new Promise((r) => setTimeout(r, 5));

      // Trigger graceful close while request is active
      const closePromise = handle.close();
      expect(handle.listening).toBe(false);
      expect(handle.address()).toBeNull();

      const resp = await respPromise;
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe('finished');
      expect(handlerCompleted).toBe(true);

      await closePromise;

      // Immediate rebind on the exact same port must succeed
      const app2 = rxpress();
      app2.get('/rebound', (_req: Request, res: Response) => res.send('rebound-ok'));
      const srv2 = startApp(app2, port);
      const r2 = await fetch(`${srv2.base}/rebound`);
      expect(r2.status).toBe(200);
      expect(await r2.text()).toBe('rebound-ok');
    });

    it('forces close after shutdownTimeoutMs for hung handlers', async () => {
      const app = rxpress();
      app.set('shutdownTimeoutMs', 80);
      app.set('handlerTimeoutMs', 0);
      app.get('/stuck', (_req: Request, _res: Response) => {
        // Never ends
      });

      const { handle, port } = startApp(app);
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.write('GET /stuck HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      });
      sock.on('error', () => {});
      await new Promise((r) => setTimeout(r, 20));

      const t0 = Date.now();
      await handle.close();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(50);
      expect(elapsed).toBeLessThan(1500);
      sock.destroy();
    });

    it('resolves localhost, validates port range, and rejects double NativeServer.start()', async () => {
      const app = rxpress();
      app.get('/hi', (_req: Request, res: Response) => res.send('hi'));
      const srv = app.listen(0, 'localhost');
      activeServers.push(srv);
      const port = srv.address()!.port;
      const r = await fetch(`http://localhost:${port}/hi`);
      expect(await r.text()).toBe('hi');

      expect(() => app.listen(70000, '127.0.0.1')).toThrow(RangeError);
      expect(() => app.listen(-1, '127.0.0.1')).toThrow(RangeError);

      const addon = loadNativeAddon();
      const native = new addon.NativeServer();
      try {
        native.start('127.0.0.1', 0, () => {});
        expect(() => native.start('127.0.0.1', 0, () => {})).toThrow(/already running/i);
      } finally {
        native.close();
      }
    });

    it('force-closes Slowloris mid-header and mid-body sockets when close() hits shutdownTimeoutMs', async () => {
      const app = rxpress();
      app.set('headersTimeoutMs', 30000);
      app.set('requestTimeoutMs', 30000);
      app.set('shutdownTimeoutMs', 80);
      app.get('/ok', (_req: Request, res: Response) => res.send('ok'));
      app.post('/up', (_req: Request, res: Response) => res.send('up'));

      const { handle, port } = startApp(app);

      const openStalled = (payload: string): { sock: net.Socket; closed: Promise<number> } => {
        const sock = net.connect({ host: '127.0.0.1', port }, () => {
          sock.write(payload);
        });
        sock.on('error', () => {});
        // Consume whatever the server sends: a body the app does not read is streamed, so the
        // app may answer before the body arrives (as Node does), and an unread response keeps
        // a paused socket from ever emitting 'close'.
        sock.resume();
        const closed = new Promise<number>((resolve) => {
          sock.on('close', () => resolve(Date.now()));
        });
        return { sock, closed };
      };

      const midHeader = openStalled('GET /ok HTTP/1.1\r\n');
      const midBodyCl = openStalled(
        'POST /up HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\nhello'
      );
      const midBodyChunked = openStalled(
        'POST /up HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhe'
      );

      try {
        await new Promise((r) => setTimeout(r, 30));
        const closeStart = Date.now();
        const [, hClosedAt, clClosedAt, chClosedAt] = await Promise.all([
          handle.close(),
          midHeader.closed,
          midBodyCl.closed,
          midBodyChunked.closed,
        ]);

        expect(Date.now() - closeStart).toBeLessThan(1500);
        expect(hClosedAt - closeStart).toBeLessThan(1500);
        expect(clClosedAt - closeStart).toBeLessThan(1500);
        expect(chClosedAt - closeStart).toBeLessThan(1500);
      } finally {
        midHeader.sock.destroy();
        midBodyCl.sock.destroy();
        midBodyChunked.sock.destroy();
      }
    });

    it('rejects negative, non-integer, non-finite, and out-of-u32 timeout/limit settings in JS', () => {
      const settings = [
        'headersTimeoutMs',
        'requestTimeoutMs',
        'keepAliveTimeoutMs',
        'tlsHandshakeTimeoutMs',
        'handlerTimeoutMs',
        'shutdownTimeoutMs',
        'maxConnections',
        'maxHeadersCount',
        'maxHeaderSizeBytes',
        'defaultBodyLimitBytes',
        'streamQueueCapacity',
      ];
      const invalidValues: unknown[] = [-1, -100, 1.5, NaN, Infinity, -Infinity, 0x100000000, '100'];

      for (const key of settings) {
        for (const bad of invalidValues) {
          const app = rxpress();
          app.set(key, bad);
          expect(() => app.listen(0, '127.0.0.1')).toThrow(RangeError);
        }
      }

      // Also validates on listenTls
      const tlsApp = rxpress();
      tlsApp.set('tlsHandshakeTimeoutMs', -1);
      expect(() => tlsApp.listenTls({ cert: 'x', key: 'y' }, 0, '127.0.0.1')).toThrow(RangeError);

      // Valid edge values (0 disables/clamps, -0 normalizes to 0, undefined preserves default) continue working
      const validApp = rxpress();
      validApp.set('headersTimeoutMs', 0);
      validApp.set('keepAliveTimeoutMs', -0);
      validApp.set('requestTimeoutMs', undefined);
      validApp.set('maxConnections', 0xffffffff);
      const srv = startApp(validApp);
      expect(srv.port).toBeGreaterThan(0);
    });
  });

  describe('6. Hardened HTTPS / TLS', () => {
    it('guards invalid/missing PEM options and drops stalled/non-TLS handshakes via timeout', async () => {
      const appBad = rxpress();
      expect(() =>
        appBad.listenTls({ cert: undefined as unknown as string, key: '-----BEGIN PRIVATE KEY-----\n' }, 0, '127.0.0.1')
      ).toThrow(TypeError);

      const { key, cert } = generateSelfSignedCert();
      const app = rxpress();
      app.set('tlsHandshakeTimeoutMs', 100);
      app.get('/tls-ok', (_req: Request, res: Response) => res.json({ ok: true }));

      const handle = app.listenTls({ key, cert }, 0, '127.0.0.1');
      activeServers.push(handle);
      const port = handle.address()!.port;

      // 1. Stalled raw TCP client -> closed by tlsHandshakeTimeoutMs
      const stalledStart = Date.now();
      await new Promise<void>((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port });
        s.on('error', () => resolve());
        s.on('close', () => resolve());
      });
      expect(Date.now() - stalledStart).toBeGreaterThanOrEqual(70);

      // 2. Plain HTTP bytes sent to TLS port -> handshake error, dropped cleanly
      await sendRawAndReadAll(port, ['GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n']).catch(() => '');

      // 3. Valid TLS client still succeeds and receives clean close_notify
      const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = https.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/tls-ok',
            method: 'GET',
            rejectUnauthorized: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
              resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') })
            );
          }
        );
        req.on('error', reject);
        req.end();
      });
      expect(body.status).toBe(200);
      expect(JSON.parse(body.text)).toEqual({ ok: true });

      // Raw TLS socket with Connection: close receives clean EOF (close_notify)
      const tlsRaw = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const tlsSock = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
          tlsSock.write('GET /tls-ok HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
        });
        tlsSock.on('data', (d: Buffer) => chunks.push(d));
        tlsSock.on('error', reject);
        tlsSock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      expect(tlsRaw).toContain('HTTP/1.1 200 OK');
      expect(tlsRaw.toLowerCase()).toContain('connection: close');
    });
  });
});
