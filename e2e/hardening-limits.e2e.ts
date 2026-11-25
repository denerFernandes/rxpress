import http from 'node:http';
import { afterEach, describe, expect } from 'vitest';
import {
  openRawSocket,
  sendRawHttp,
  type RawSocketClient,
} from './helpers/raw-http.js';
import {
  createApp,
  itRxpress,
  jsonMiddleware,
  startServer,
  type E2EServerConfigOptions,
} from './helpers/server.js';

const activeClosables: Array<() => Promise<unknown>> = [];
const activeSockets: RawSocketClient[] = [];
const activeAgents: http.Agent[] = [];

function trackClosable(fn: () => Promise<unknown>): void {
  activeClosables.push(fn);
}

function trackSocket(sock: RawSocketClient): RawSocketClient {
  activeSockets.push(sock);
  return sock;
}

function trackAgent(agent: http.Agent): http.Agent {
  activeAgents.push(agent);
  return agent;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function httpRequestWithAgent(
  port: number,
  path: string,
  agent: http.Agent,
  method = 'GET',
  body?: string,
  headers?: Record<string, string>
): Promise<{ statusCode: number; body: string }> {
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        agent,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error('httpRequestWithAgent timed out')));
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

afterEach(async () => {
  while (activeSockets.length > 0) {
    activeSockets.pop()?.destroy();
  }
  while (activeAgents.length > 0) {
    activeAgents.pop()?.destroy();
  }
  while (activeClosables.length > 0) {
    const closeFn = activeClosables.pop();
    if (closeFn) {
      await Promise.allSettled([closeFn()]);
    }
  }
});

describe('Engine Config, Timeouts & Connection/Header/Body Limits', () => {
  itRxpress(
    'requests completing within headersTimeoutMs, requestTimeoutMs, handlerTimeoutMs, and keepAliveTimeoutMs succeed and keep socket alive',
    async () => {
      const cfg: E2EServerConfigOptions = {
        headersTimeoutMs: 2000,
        requestTimeoutMs: 2000,
        handlerTimeoutMs: 2000,
        keepAliveTimeoutMs: 2000,
      };
      const app = createApp(cfg);
      app.get('/slow-ok', async (_req, res) => {
        await delay(50);
        res.status(200).send('first-ok');
      });
      app.get('/second', (_req, res) => {
        res.status(200).send('second-ok');
      });

      const srv = await startServer(app, { timeouts: cfg });
      trackClosable(() => srv.close());

      const client = trackSocket(await openRawSocket(srv.host, srv.port));
      await client.write('GET /slow-ok HTTP/1.1\r\nHost: 127.0.0.1\r\n');
      await delay(40);
      await client.write('X-Step: 2\r\n\r\n');

      const firstBuf = await client.readUntil('first-ok', 3000);
      expect(firstBuf.toString('latin1')).toContain('HTTP/1.1 200');
      expect(firstBuf.toString('latin1')).toContain('first-ok');

      // Drain cumulative buffer before sending second request on same keep-alive socket
      await client.readAvailable(0);
      await delay(50);

      await client.write('GET /second HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      const secondBuf = await client.readUntil('second-ok', 3000);
      expect(secondBuf.toString('latin1')).toContain('HTTP/1.1 200');
      expect(secondBuf.toString('latin1')).toContain('second-ok');
    }
  );

  itRxpress(
    'maxConnections allows up to N concurrent keep-alive connections',
    async () => {
      const cfg: E2EServerConfigOptions = {
        maxConnections: 5,
        keepAliveTimeoutMs: 5000,
      };
      const app = createApp(cfg);
      app.get('/ok', (_req, res) => {
        res.status(200).send('ok');
      });

      const srv = await startServer(app, { timeouts: cfg });
      trackClosable(() => srv.close());

      const sockets = await Promise.all(
        Array.from({ length: 5 }, async () =>
          trackSocket(await openRawSocket(srv.host, srv.port))
        )
      );

      const responses = await Promise.all(
        sockets.map(async (sock) => {
          await sock.write('GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
          return (await sock.readUntil('ok', 3000)).toString('latin1');
        })
      );

      for (const raw of responses) {
        expect(raw).toContain('HTTP/1.1 200');
        expect(raw).toContain('ok');
      }
    }
  );

  itRxpress(
    'maxHeadersCount and maxHeaderSizeBytes accept valid requests just below limits',
    async () => {
      const cfg: E2EServerConfigOptions = {
        maxHeadersCount: 20,
        maxHeaderSizeBytes: 2048,
      };
      const app = createApp(cfg);
      app.get('/headers', (_req, res) => {
        res.status(200).send('headers-ok');
      });

      const srv = await startServer(app, { timeouts: cfg });
      trackClosable(() => srv.close());

      const lines = ['GET /headers HTTP/1.1', 'Host: 127.0.0.1', 'Connection: close'];
      for (let i = 0; i < 17; i++) {
        lines.push(`X-H-${i}: ${'v'.repeat(55)}`);
      }
      const payload = `${lines.join('\r\n')}\r\n\r\n`;
      expect(Buffer.byteLength(payload)).toBeLessThan(2048);

      const resp = await sendRawHttp(srv.host, srv.port, payload);
      expect(resp.statusCode).toBe(200);
      expect(resp.body.toString('utf8')).toBe('headers-ok');
    }
  );

  itRxpress(
    'defaultBodyLimitBytes accepts a body at the exact limit even without body-parser middleware',
    async () => {
      const cfg: E2EServerConfigOptions = {
        defaultBodyLimitBytes: 1024,
      };
      const app = createApp(cfg);
      app.post('/raw-limit', (req, res) => {
        res.status(200).json({ ok: true, cl: req.get('content-length') });
      });

      const srv = await startServer(app, { timeouts: cfg });
      trackClosable(() => srv.close());

      const body = 'a'.repeat(1024);
      const rawReq =
        `POST /raw-limit HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\n` +
        `Content-Type: text/plain\r\n` +
        `Content-Length: ${body.length}\r\n` +
        `Connection: close\r\n\r\n${body}`;

      const resp = await sendRawHttp(srv.host, srv.port, rawReq);
      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body.toString('utf8'))).toEqual({ ok: true, cl: '1024' });
    }
  );

  itRxpress(
    'zero-config default production timeouts work out-of-the-box for GET, POST, and keep-alive',
    async () => {
      const app = createApp();
      app.use(jsonMiddleware());
      app.get('/ping', (_req, res) => {
        res.status(200).send('pong');
      });
      app.post('/echo', (req, res) => {
        res.status(200).json(req.body);
      });

      const srv = await startServer(app);
      trackClosable(() => srv.close());

      const agent = trackAgent(new http.Agent({ keepAlive: true, maxSockets: 1 }));
      const r1 = await httpRequestWithAgent(srv.port, '/ping', agent);
      expect(r1.statusCode).toBe(200);
      expect(r1.body).toBe('pong');

      const postPayload = JSON.stringify({ hello: 'world' });
      const r2 = await httpRequestWithAgent(srv.port, '/echo', agent, 'POST', postPayload, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(postPayload)),
      });
      expect(r2.statusCode).toBe(200);
      expect(JSON.parse(r2.body)).toEqual({ hello: 'world' });

      const r3 = await httpRequestWithAgent(srv.port, '/ping', agent);
      expect(r3.statusCode).toBe(200);
      expect(r3.body).toBe('pong');
    }
  );

  itRxpress(
    'Slowloris partial headers trigger headersTimeoutMs (408/close) while concurrent healthy clients succeed',
    async () => {
      const cfg: E2EServerConfigOptions = {
        headersTimeoutMs: 150,
        shutdownTimeoutMs: 200,
      };
      const app = createApp(cfg);
      app.get('/health', (_req, res) => {
        res.status(200).send('healthy');
      });

      const srv = await startServer(app, { timeouts: cfg });
      trackClosable(() => srv.close());

      const slowClient = trackSocket(await openRawSocket(srv.host, srv.port));
      const t0 = Date.now();
      await slowClient.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n');

      const [closed, healthResp] = await Promise.all([
        slowClient.waitForClose(2000),
        fetch(`${srv.baseUrl}/health`),
      ]);
      const elapsed = Date.now() - t0;

      expect(closed).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(elapsed).toBeLessThan(1500);
      const buffered = slowClient.getBufferedData().toString('latin1');
      if (buffered.length > 0) {
        expect(buffered).toMatch(/^HTTP\/1\.1 408/);
      }

      expect(healthResp.status).toBe(200);
      expect(await healthResp.text()).toBe('healthy');
    }
  );

  itRxpress(
    'stalled request body triggers requestTimeoutMs (408/close) without leaking slots',
    async () => {
      const cfg: E2EServerConfigOptions = {
        headersTimeoutMs: 2000,
        requestTimeoutMs: 150,
        shutdownTimeoutMs: 200,
      };
      const app = createApp(cfg);
      app.post('/upload', (_req, res) => {
        res.status(200).send('uploaded');
      });
      app.get('/health', (_req, res) => {
        res.status(200).send('ok');
      });

      const srv = await startServer(app, { timeouts: cfg });
      trackClosable(() => srv.close());

      const slowBodyClient = trackSocket(await openRawSocket(srv.host, srv.port));
      const t0 = Date.now();
      await slowBodyClient.write(
        'POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1000\r\n\r\n0123456789'
      );

      const closed = await slowBodyClient.waitForClose(2000);
      const elapsed = Date.now() - t0;
      expect(closed).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(elapsed).toBeLessThan(1500);
      const buffered = slowBodyClient.getBufferedData().toString('latin1');
      if (buffered.length > 0) {
        expect(buffered).toMatch(/^HTTP\/1\.1 408/);
      }

      const healthResp = await fetch(`${srv.baseUrl}/health`);
      expect(healthResp.status).toBe(200);
      expect(await healthResp.text()).toBe('ok');
    }
  );

  itRxpress(
    'idle keep-alive socket is evicted promptly after keepAliveTimeoutMs',
    async () => {
      const cfg: E2EServerConfigOptions = {
        keepAliveTimeoutMs: 150,
        shutdownTimeoutMs: 200,
      };
      const app = createApp(cfg);
      app.get('/ping', (_req, res) => {
        res.status(200).send('pong');
      });

      const srv = await startServer(app, { timeouts: cfg });
      trackClosable(() => srv.close());

      const client = trackSocket(await openRawSocket(srv.host, srv.port));
      await client.write('GET /ping HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      const firstResp = (await client.readUntil('pong', 2000)).toString('latin1');
      expect(firstResp).toContain('HTTP/1.1 200');
      await client.readAvailable(0);

      const t0 = Date.now();
      const closed = await client.waitForClose(2000);
      const elapsed = Date.now() - t0;

      expect(closed).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(elapsed).toBeLessThan(1500);
    }
  );

  itRxpress(
    'hung async handler triggers handlerTimeoutMs (504/503/close) without leaking slots',
    async () => {
      const cfg: E2EServerConfigOptions = {
        handlerTimeoutMs: 150,
        requestTimeoutMs: 2000,
        shutdownTimeoutMs: 150,
      };
      const app = createApp(cfg);
      app.get('/hang', async () => new Promise<void>(() => {}));
      app.get('/health', (_req, res) => {
        res.status(200).send('ok');
      });

      const srv = await startServer(app, { timeouts: cfg });
      trackClosable(() => srv.close());

      const t0 = Date.now();
      const resp = await sendRawHttp(
        srv.host,
        srv.port,
        'GET /hang HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
        { timeoutMs: 2500 }
      );
      const elapsed = Date.now() - t0;

      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(elapsed).toBeLessThan(1500);
      expect(resp.closed).toBe(true);
      expect([503, 504]).toContain(resp.statusCode);

      const healthResp = await fetch(`${srv.baseUrl}/health`);
      expect(healthResp.status).toBe(200);
      expect(await healthResp.text()).toBe('ok');
    }
  );

  itRxpress(
    'exceeding maxConnections bounds/rejects excess connections and recovers after active connections close',
    async () => {
      const cfg: E2EServerConfigOptions = {
        maxConnections: 3,
        keepAliveTimeoutMs: 5000,
        shutdownTimeoutMs: 150,
      };
      const app = createApp(cfg);
      app.get('/ok', (_req, res) => {
        res.status(200).send('ok');
      });

      const srv = await startServer(app, { timeouts: cfg });
      trackClosable(() => srv.close());

      const held: RawSocketClient[] = [];
      for (let i = 0; i < 3; i++) {
        const sock = trackSocket(await openRawSocket(srv.host, srv.port));
        await sock.write('GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
        const data = (await sock.readUntil('ok', 2000)).toString('latin1');
        expect(data).toContain('HTTP/1.1 200');
        held.push(sock);
      }

      const attemptExcess = async (): Promise<'rejected' | '503' | 'closed'> => {
        try {
          const resp = await sendRawHttp(
            srv.host,
            srv.port,
            'GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
            { timeoutMs: 800 }
          );
          if (resp.statusCode === 503) return '503';
          if (resp.statusCode === 0 && resp.closed) return 'closed';
          throw new Error(`Unexpected excess connection status: ${resp.statusCode}`);
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('Unexpected excess')) {
            throw err;
          }
          return 'rejected';
        }
      };

      const [r4, r5] = await Promise.all([attemptExcess(), attemptExcess()]);
      expect(['rejected', '503', 'closed']).toContain(r4);
      expect(['rejected', '503', 'closed']).toContain(r5);

      for (const sock of held) {
        sock.destroy();
      }
      await delay(60);

      const recovered = await fetch(`${srv.baseUrl}/ok`);
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toBe('ok');
    }
  );

  itRxpress(
    'exceeding maxHeadersCount, maxHeaderSizeBytes, and defaultBodyLimitBytes returns 431/400 and 413 cleanly',
    async () => {
      // Note: src/config.rs clamps maxHeaderSizeBytes minimum to 1024.
      const cfg: E2EServerConfigOptions = {
        maxHeadersCount: 10,
        maxHeaderSizeBytes: 1024,
        defaultBodyLimitBytes: 256,
        shutdownTimeoutMs: 200,
      };
      const app = createApp(cfg);
      app.get('/h', (_req, res) => {
        res.status(200).send('ok');
      });
      app.post('/b', (_req, res) => {
        res.status(200).send('ok');
      });

      const srv = await startServer(app, { timeouts: cfg });
      trackClosable(() => srv.close());

      // 1) Too many headers (12 > maxHeadersCount: 10)
      const tooManyLines = ['GET /h HTTP/1.1', 'Host: 127.0.0.1'];
      for (let i = 0; i < 11; i++) {
        tooManyLines.push(`X-Too-Many-${i}: ${i}`);
      }
      const tooManyResp = await sendRawHttp(
        srv.host,
        srv.port,
        `${tooManyLines.join('\r\n')}\r\n\r\n`
      );
      expect([400, 431]).toContain(tooManyResp.statusCode);
      expect(tooManyResp.closed).toBe(true);

      // 2) Oversized header block (> 1024 bytes)
      const bigHeaderReq =
        `GET /h HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Big: ${'x'.repeat(1300)}\r\n\r\n`;
      const bigHeaderResp = await sendRawHttp(srv.host, srv.port, bigHeaderReq);
      expect([400, 431]).toContain(bigHeaderResp.statusCode);
      expect(bigHeaderResp.closed).toBe(true);

      // 3) Oversized body (> defaultBodyLimitBytes: 256)
      const overBody = 'z'.repeat(512);
      const overBodyReq =
        `POST /b HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\n` +
        `Content-Type: text/plain\r\n` +
        `Content-Length: ${overBody.length}\r\n\r\n${overBody}`;
      const overBodyResp = await sendRawHttp(srv.host, srv.port, overBodyReq);
      expect(overBodyResp.statusCode).toBe(413);
      expect(overBodyResp.closed).toBe(true);
    }
  );
});
