import { createHash } from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import { afterEach, beforeAll, describe, expect } from 'vitest';
import { createTempWorkspace, type TempWorkspace } from './helpers/fixtures.js';
import { openRawSocket, type RawSocketClient } from './helpers/raw-http.js';
import {
  createApp,
  createHttpsServer,
  createSelfSignedCert,
  itRxpress,
  jsonMiddleware,
  startTlsServer,
  staticMiddleware,
  type E2EServerConfigOptions,
  type E2ETlsOptions,
} from './helpers/server.js';

interface HttpsResponseResult {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  socket: unknown;
}

const activeClosables: Array<() => Promise<unknown>> = [];
const activeSockets: RawSocketClient[] = [];
const activeRawTlsSockets: tls.TLSSocket[] = [];
const activeAgents: https.Agent[] = [];
const workspaces: TempWorkspace[] = [];

let certPairA: { key: Buffer; cert: Buffer };
let certPairB: { key: Buffer; cert: Buffer };

function trackClosable(fn: () => Promise<unknown>): void {
  activeClosables.push(fn);
}

function trackSocket(sock: RawSocketClient): RawSocketClient {
  activeSockets.push(sock);
  return sock;
}

function trackTlsSocket(sock: tls.TLSSocket): tls.TLSSocket {
  activeRawTlsSockets.push(sock);
  return sock;
}

function trackAgent(agent: https.Agent): https.Agent {
  activeAgents.push(agent);
  return agent;
}

function makeWorkspace(prefix: string): TempWorkspace {
  const ws = createTempWorkspace(prefix);
  workspaces.push(ws);
  return ws;
}

function httpsRequest(
  options: https.RequestOptions,
  body?: string | Buffer
): Promise<HttpsResponseResult> {
  return new Promise<HttpsResponseResult>((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks),
          socket: res.socket,
        });
      });
      res.on('error', reject);
    });
    req.setTimeout(10000, () => {
      req.destroy(new Error('httpsRequest timed out'));
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

async function expectTlsStartFailure(tlsOpts: E2ETlsOptions): Promise<void> {
  const app = createApp();
  app.get('/', (_req, res) => {
    res.send('unexpected');
  });

  let caught: unknown = null;
  try {
    const started = await startTlsServer(app, tlsOpts);
    trackClosable(() => started.close());
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(Error);
}

beforeAll(() => {
  certPairA = createSelfSignedCert();
  certPairB = createSelfSignedCert();
});

afterEach(async () => {
  while (activeSockets.length > 0) {
    activeSockets.pop()?.destroy();
  }
  while (activeRawTlsSockets.length > 0) {
    activeRawTlsSockets.pop()?.destroy();
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
  while (workspaces.length > 0) {
    workspaces.pop()?.cleanup();
  }
});

describe('HTTPS/TLS (rustls, listenTls, createHttpsServer)', () => {
  itRxpress(
    'app.listenTls with Buffer PEM cert & key serves HTTPS with req.secure and req.protocol',
    async () => {
      const app = createApp();
      app.get('/tls', (req, res) => {
        res.json({
          secure: req.secure,
          protocol: req.protocol,
          encrypted: Boolean(req.socket.encrypted),
        });
      });

      const srv = await startTlsServer(app, certPairA);
      trackClosable(() => srv.close());

      const resp = await httpsRequest({
        hostname: '127.0.0.1',
        port: srv.port,
        path: '/tls',
        method: 'GET',
        ca: certPairA.cert,
        rejectUnauthorized: true,
        headers: { Connection: 'close' },
      });

      expect(resp.statusCode).toBe(200);
      const parsed = JSON.parse(resp.body.toString('utf8')) as {
        secure: boolean;
        protocol: string;
        encrypted: boolean;
      };
      expect(parsed).toEqual({
        secure: true,
        protocol: 'https',
        encrypted: true,
      });
    }
  );

  itRxpress(
    'listenTls and createHttpsServer accept filesystem .pem paths and serve HTTPS',
    async () => {
      const ws = makeWorkspace('rxpress-fg04-t1-02-');
      const certPath = ws.writeFile('cert.pem', certPairA.cert);
      const keyPath = ws.writeFile('key.pem', certPairA.key);

      const appA = createApp();
      appA.get('/a', (req, res) => {
        res.json({ via: 'listenTls', secure: req.secure, protocol: req.protocol });
      });
      const srvA = await startTlsServer(appA, { cert: certPath, key: keyPath });
      trackClosable(() => srvA.close());

      const appB = createApp();
      appB.get('/b', (req, res) => {
        res.json({ via: 'createHttpsServer', secure: req.secure, protocol: req.protocol });
      });
      const srvB = createHttpsServer({ cert: certPath, key: keyPath }, appB).listen(
        0,
        '127.0.0.1'
      );
      trackClosable(() => Promise.resolve(srvB.close()));

      const deadline = Date.now() + 2000;
      while (!srvB.address()?.port && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 10));
      }
      const portB = srvB.address()?.port;
      expect(portB).toBeGreaterThan(0);

      const resA = await httpsRequest({
        hostname: '127.0.0.1',
        port: srvA.port,
        path: '/a',
        ca: certPairA.cert,
        rejectUnauthorized: true,
        headers: { Connection: 'close' },
      });
      expect(resA.statusCode).toBe(200);
      expect(JSON.parse(resA.body.toString('utf8'))).toEqual({
        via: 'listenTls',
        secure: true,
        protocol: 'https',
      });

      const resB = await httpsRequest({
        hostname: '127.0.0.1',
        port: portB,
        path: '/b',
        ca: certPairA.cert,
        rejectUnauthorized: true,
        headers: { Connection: 'close' },
      });
      expect(resB.statusCode).toBe(200);
      expect(JSON.parse(resB.body.toString('utf8'))).toEqual({
        via: 'createHttpsServer',
        secure: true,
        protocol: 'https',
      });
    }
  );

  itRxpress(
    'explicit TLS 1.2 and TLS 1.3 negotiation both succeed over rustls',
    async () => {
      const app = createApp();
      app.get('/ver', (_req, res) => {
        res.status(200).send('tls-ok');
      });

      const srv = await startTlsServer(app, certPairA);
      trackClosable(() => srv.close());

      for (const version of ['TLSv1.2', 'TLSv1.3'] as const) {
        const result = await new Promise<{ protocol: string | null; raw: string }>(
          (resolve, reject) => {
            const sock = trackTlsSocket(
              tls.connect({
                host: '127.0.0.1',
                port: srv.port,
                ca: certPairA.cert,
                rejectUnauthorized: true,
                minVersion: version,
                maxVersion: version,
              })
            );
            const chunks: Buffer[] = [];
            const timer = setTimeout(() => {
              sock.destroy();
              reject(new Error(`Timed out testing ${version}`));
            }, 5000);

            sock.once('error', (err) => {
              clearTimeout(timer);
              reject(err);
            });
            sock.on('data', (chunk: Buffer) => {
              chunks.push(chunk);
            });
            sock.once('secureConnect', () => {
              const negotiated = sock.getProtocol();
              sock.write('GET /ver HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
              sock.once('end', () => {
                clearTimeout(timer);
                resolve({
                  protocol: negotiated,
                  raw: Buffer.concat(chunks).toString('utf8'),
                });
              });
            });
          }
        );

        expect(result.protocol).toBe(version);
        expect(result.raw).toContain('HTTP/1.1 200');
        expect(result.raw).toContain('tls-ok');
      }
    }
  );

  itRxpress(
    'keep-alive reuses a single TLS session across 10 sequential GET/POST requests',
    async () => {
      const app = createApp();
      app.use(jsonMiddleware());
      app.get('/seq/:idx', (req, res) => {
        res.json({ method: 'GET', idx: Number(req.params.idx), secure: req.secure });
      });
      app.post('/seq', (req, res) => {
        res.json({ method: 'POST', payload: req.body, secure: req.secure });
      });

      const srv = await startTlsServer(app, certPairA);
      trackClosable(() => srv.close());

      const agent = trackAgent(new https.Agent({ keepAlive: true, maxSockets: 1 }));
      const observedSockets = new Set<unknown>();

      for (let i = 0; i < 10; i++) {
        if (i % 2 === 0) {
          const res = await httpsRequest({
            hostname: '127.0.0.1',
            port: srv.port,
            path: `/seq/${i}`,
            method: 'GET',
            agent,
            ca: certPairA.cert,
            rejectUnauthorized: true,
          });
          expect(res.statusCode).toBe(200);
          expect(JSON.parse(res.body.toString('utf8'))).toEqual({
            method: 'GET',
            idx: i,
            secure: true,
          });
          observedSockets.add(res.socket);
        } else {
          const body = JSON.stringify({ n: i });
          const res = await httpsRequest(
            {
              hostname: '127.0.0.1',
              port: srv.port,
              path: '/seq',
              method: 'POST',
              agent,
              ca: certPairA.cert,
              rejectUnauthorized: true,
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(body)),
              },
            },
            body
          );
          expect(res.statusCode).toBe(200);
          expect(JSON.parse(res.body.toString('utf8'))).toEqual({
            method: 'POST',
            payload: { n: i },
            secure: true,
          });
          observedSockets.add(res.socket);
        }
      }

      expect(observedSockets.size).toBe(1);
    }
  );

  itRxpress(
    'graceful server.close() sends TLS close_notify without ECONNRESET on idle TLS socket',
    async () => {
      const cfg: E2EServerConfigOptions = {
        keepAliveTimeoutMs: 10000,
        shutdownTimeoutMs: 1000,
      };
      const app = createApp(cfg);
      app.get('/', (_req, res) => {
        res.status(200).send('hello');
      });

      const srv = await startTlsServer(app, certPairA, { timeouts: cfg });
      trackClosable(() => srv.close());

      const sock = trackTlsSocket(
        tls.connect({
          host: '127.0.0.1',
          port: srv.port,
          ca: certPairA.cert,
          rejectUnauthorized: true,
        })
      );

      let ended = false;
      let closed = false;
      const errors: Error[] = [];

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('TLS connect timed out')), 5000);
        sock.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        sock.once('secureConnect', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      sock.on('end', () => {
        ended = true;
      });
      sock.on('close', () => {
        closed = true;
      });
      sock.on('error', (err) => {
        errors.push(err);
      });

      await new Promise<void>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('Response timed out')), 5000);
        const onData = (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          if (buf.includes('hello')) {
            sock.off('data', onData);
            clearTimeout(timer);
            resolve();
          }
        };
        sock.on('data', onData);
        sock.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
      });

      const closeDone = new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        const t = setTimeout(resolve, 2000);
        sock.once('close', () => {
          clearTimeout(t);
          resolve();
        });
      });

      await srv.close();
      await closeDone;

      expect(errors).toEqual([]);
      expect(ended).toBe(true);
      expect(closed).toBe(true);
    }
  );

  itRxpress(
    'invalid PEM syntax in cert or key rejects cleanly on startup without panic',
    async () => {
      await expectTlsStartFailure({ cert: 'not-a-pem', key: certPairA.key });
      await expectTlsStartFailure({ cert: certPairA.cert, key: 'not-a-pem' });
      await expectTlsStartFailure({
        cert: certPairA.cert.subarray(0, 32),
        key: certPairA.key,
      });
    }
  );

  itRxpress(
    'mismatched cert/key pair and nonexistent PEM file path reject cleanly on startup',
    async () => {
      await expectTlsStartFailure({ cert: certPairA.cert, key: certPairB.key });
      await expectTlsStartFailure({
        cert: '/nonexistent/rxpress-e2e-missing-cert.pem',
        key: '/nonexistent/rxpress-e2e-missing-key.pem',
      });
    }
  );

  itRxpress(
    'plaintext HTTP bytes sent to TLS port are rejected and server stays healthy',
    async () => {
      const app = createApp();
      app.get('/', (_req, res) => {
        res.status(200).send('healthy-tls');
      });

      const srv = await startTlsServer(app, certPairA);
      trackClosable(() => srv.close());

      const rawClient = trackSocket(
        await openRawSocket(srv.host, srv.port, { tls: false })
      );
      await rawClient.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
      const didClose = await rawClient.waitForClose(2000);
      expect(didClose).toBe(true);
      expect(rawClient.getBufferedData().toString('latin1')).not.toMatch(/^HTTP\/1\.1 200/);

      const validResp = await httpsRequest({
        hostname: '127.0.0.1',
        port: srv.port,
        path: '/',
        ca: certPairA.cert,
        rejectUnauthorized: true,
        headers: { Connection: 'close' },
      });
      expect(validResp.statusCode).toBe(200);
      expect(validResp.body.toString('utf8')).toBe('healthy-tls');
    }
  );

  itRxpress(
    'corrupt/truncated TLS ClientHello closes socket cleanly without crashing server',
    async () => {
      const app = createApp();
      app.get('/ok', (_req, res) => {
        res.status(200).send('still-alive');
      });

      const srv = await startTlsServer(app, certPairA);
      trackClosable(() => srv.close());

      const rawClient = trackSocket(
        await openRawSocket(srv.host, srv.port, { tls: false })
      );
      // Complete 5-byte TLS Handshake record with malformed 1-byte ClientHello triggers immediate decode_error/close
      await rawClient.write(
        Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x00, 0x01, 0xff])
      );
      const didClose = await rawClient.waitForClose(2000);
      expect(didClose).toBe(true);

      const validResp = await httpsRequest({
        hostname: '127.0.0.1',
        port: srv.port,
        path: '/ok',
        ca: certPairA.cert,
        rejectUnauthorized: true,
        headers: { Connection: 'close' },
      });
      expect(validResp.statusCode).toBe(200);
      expect(validResp.body.toString('utf8')).toBe('still-alive');
    }
  );

  itRxpress(
    'stalled TLS handshakes time out via tlsHandshakeTimeoutMs without blocking other TLS clients',
    async () => {
      const cfg: E2EServerConfigOptions = {
        tlsHandshakeTimeoutMs: 150,
        shutdownTimeoutMs: 200,
      };
      const app = createApp(cfg);
      app.get('/fast', (_req, res) => {
        res.status(200).send('unblocked');
      });

      const srv = await startTlsServer(app, certPairA, { timeouts: cfg });
      trackClosable(() => srv.close());

      const idleSock = trackSocket(await openRawSocket(srv.host, srv.port, { tls: false }));
      const tIdle = Date.now();
      const partialSock = trackSocket(await openRawSocket(srv.host, srv.port, { tls: false }));
      const tPartial = Date.now();
      await partialSock.write(Buffer.from([0x16, 0x03, 0x01]));

      const [idleResult, partialResult, validResp] = await Promise.all([
        idleSock.waitForClose(2000).then((closed) => ({ closed, elapsed: Date.now() - tIdle })),
        partialSock
          .waitForClose(2000)
          .then((closed) => ({ closed, elapsed: Date.now() - tPartial })),
        httpsRequest({
          hostname: '127.0.0.1',
          port: srv.port,
          path: '/fast',
          ca: certPairA.cert,
          rejectUnauthorized: true,
          headers: { Connection: 'close' },
        }),
      ]);

      expect(idleResult.closed).toBe(true);
      expect(idleResult.elapsed).toBeGreaterThanOrEqual(80);
      expect(idleResult.elapsed).toBeLessThan(1500);
      expect(partialResult.closed).toBe(true);
      expect(partialResult.elapsed).toBeGreaterThanOrEqual(80);
      expect(partialResult.elapsed).toBeLessThan(1500);
      expect(validResp.statusCode).toBe(200);
      expect(validResp.body.toString('utf8')).toBe('unblocked');
    }
  );

  itRxpress(
    'large 256KB JSON POST body and static binary file preserve exact integrity over TLS',
    async () => {
      const ws = makeWorkspace('rxpress-fg04-t2-06-');
      const staticPayload = Buffer.alloc(128 * 1024);
      for (let i = 0; i < staticPayload.length; i++) {
        staticPayload[i] = (i * 31 + 7) & 0xff;
      }
      const staticHash = createHash('sha256').update(staticPayload).digest('hex');
      ws.writeFile('payload.bin', staticPayload);

      const app = createApp();
      app.use(jsonMiddleware({ limit: '1mb' }));
      app.use('/static', staticMiddleware(ws.dir));
      app.post('/echo', (req, res) => {
        const body = req.body as { data: string };
        const hash = createHash('sha256').update(body.data).digest('hex');
        res.json({ length: body.data.length, hash });
      });

      const srv = await startTlsServer(app, certPairA);
      trackClosable(() => srv.close());

      const bigText = 'X'.repeat(256 * 1024);
      const expectedTextHash = createHash('sha256').update(bigText).digest('hex');
      const jsonBody = JSON.stringify({ data: bigText });

      const postResp = await httpsRequest(
        {
          hostname: '127.0.0.1',
          port: srv.port,
          path: '/echo',
          method: 'POST',
          ca: certPairA.cert,
          rejectUnauthorized: true,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(jsonBody)),
            Connection: 'close',
          },
        },
        jsonBody
      );

      expect(postResp.statusCode).toBe(200);
      expect(JSON.parse(postResp.body.toString('utf8'))).toEqual({
        length: bigText.length,
        hash: expectedTextHash,
      });

      const staticResp = await httpsRequest({
        hostname: '127.0.0.1',
        port: srv.port,
        path: '/static/payload.bin',
        method: 'GET',
        ca: certPairA.cert,
        rejectUnauthorized: true,
        headers: { Connection: 'close' },
      });

      expect(staticResp.statusCode).toBe(200);
      expect(staticResp.body.length).toBe(staticPayload.length);
      expect(createHash('sha256').update(staticResp.body).digest('hex')).toBe(staticHash);
    }
  );
});
