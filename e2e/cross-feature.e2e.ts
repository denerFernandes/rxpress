import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTempWorkspace,
  setupConsumerPackage,
  type TempWorkspace,
} from './helpers/fixtures.js';
import {
  openRawSocket,
  sendRawHttp,
  type RawSocketClient,
} from './helpers/raw-http.js';
import {
  createApp,
  createRouter,
  createSelfSignedCert,
  isExpressBaseline,
  itRxpress,
  jsonMiddleware,
  rawMiddleware,
  startServer,
  startTlsServer,
  staticMiddleware,
  textMiddleware,
  urlencodedMiddleware,
  type E2EApplication,
  type E2EErrorRequestHandler,
  type E2ERequestHandler,
  type StartedServer,
} from './helpers/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const activeServers: StartedServer[] = [];
const activeWorkspaces: TempWorkspace[] = [];
const activeSockets: RawSocketClient[] = [];
const activeAgents: Array<http.Agent | https.Agent> = [];
const activeChildren: ChildProcess[] = [];

function trackServer(srv: StartedServer): StartedServer {
  activeServers.push(srv);
  return srv;
}

function makeWorkspace(prefix: string): TempWorkspace {
  const ws = createTempWorkspace(prefix);
  activeWorkspaces.push(ws);
  return ws;
}

function trackSocket(sock: RawSocketClient): RawSocketClient {
  activeSockets.push(sock);
  return sock;
}

function trackAgent<T extends http.Agent | https.Agent>(agent: T): T {
  activeAgents.push(agent);
  return agent;
}

function trackChild(child: ChildProcess): ChildProcess {
  activeChildren.push(child);
  return child;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2500,
  intervalMs = 20
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(intervalMs);
  }
  return predicate();
}

interface HttpResponseResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function performHttpRequest(opts: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  ca?: Buffer;
  agent?: http.Agent | https.Agent;
  timeoutMs?: number;
}): Promise<HttpResponseResult> {
  const parsed = new URL(opts.url);
  const isHttps = parsed.protocol === 'https:';

  return new Promise<HttpResponseResult>((resolve, reject) => {
    const reqOpts: https.RequestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: opts.method ?? 'GET',
      headers: opts.headers,
      agent: opts.agent,
      ca: opts.ca,
      rejectUnauthorized: opts.ca ? true : false,
      timeout: opts.timeoutMs ?? 10000,
    };

    const transport = isHttps ? https : http;
    const req = transport.request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out: ${opts.method ?? 'GET'} ${opts.url}`));
    });
    req.on('error', reject);

    if (opts.body !== undefined) {
      req.write(opts.body);
    }
    req.end();
  });
}

function headerToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(', ');
  return value ?? '';
}

function asMw(fn: unknown): E2ERequestHandler {
  return fn as E2ERequestHandler;
}

afterEach(async () => {
  while (activeSockets.length > 0) {
    const sock = activeSockets.pop();
    sock?.destroy();
  }
  while (activeAgents.length > 0) {
    const agent = activeAgents.pop();
    agent?.destroy();
  }
  while (activeChildren.length > 0) {
    const child = activeChildren.pop();
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
  }
  while (activeServers.length > 0) {
    const srv = activeServers.pop();
    if (srv) {
      srv.closeAllConnections();
      await srv.close().catch(() => {});
    }
  }
  while (activeWorkspaces.length > 0) {
    const ws = activeWorkspaces.pop();
    ws?.cleanup();
  }
});

describe('Cross-feature combinations', () => {
  itRxpress(
    'TLS + SSE/Streaming handles mid-stream client disconnect cleanly',
    async () => {
      const { key, cert } = createSelfSignedCert();
      const app = createApp();
      const timers = new Set<ReturnType<typeof setInterval>>();
      let clientClosed = false;
      let eventsSent = 0;

      app.get('/events', (req, res) => {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.flushHeaders();

        const emitTick = () => {
          eventsSent += 1;
          res.write(`id: ${eventsSent}\ndata: tick-${eventsSent}\n\n`);
        };
        emitTick();

        const timer = setInterval(emitTick, 25);
        timers.add(timer);

        req.on('close', () => {
          clearInterval(timer);
          timers.delete(timer);
          clientClosed = true;
        });
      });

      const srv = trackServer(await startTlsServer(app, { key, cert }));
      try {
        const sock = trackSocket(
          await openRawSocket(srv.host, srv.port, {
            tls: true,
            tlsOptions: { ca: cert, rejectUnauthorized: true },
          })
        );

        await sock.write('GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n');
        const received = await sock.readUntil('id: 1\ndata: tick-1\n\n', 4000);
        const text = received.toString('utf8');
        expect(text).toContain('HTTP/1.1 200');
        expect(text.toLowerCase()).toContain('text/event-stream');
        expect(text).toContain('id: 1\ndata: tick-1\n\n');

        sock.destroy();
        const detected = await waitForCondition(() => clientClosed, 2500);
        expect(detected).toBe(true);
        expect(eventsSent).toBeGreaterThanOrEqual(1);
      } finally {
        for (const t of timers) {
          clearInterval(t);
        }
      }
    }
  );

  itRxpress(
    'TLS + sendFile & Range serves 206 byte slices over HTTPS',
    async () => {
      const ws = makeWorkspace('rxpress-e2e-');
      const payload = Buffer.alloc(4096);
      for (let i = 0; i < payload.length; i++) {
        payload[i] = i % 251;
      }
      ws.writeFile('blob.bin', payload);

      const { key, cert } = createSelfSignedCert();
      const app = createApp();
      app.get('/blob', (req, res) => {
        res.setHeader('x-secure', String(req.secure));
        res.setHeader('x-proto', req.protocol);
        res.sendFile('blob.bin', { root: ws.dir });
      });

      const srv = trackServer(await startTlsServer(app, { key, cert }));
      const res = await performHttpRequest({
        url: `${srv.baseUrl}/blob`,
        headers: { Range: 'bytes=100-199' },
        ca: cert,
      });

      expect(res.statusCode).toBe(206);
      expect(res.headers['content-range']).toBe('bytes 100-199/4096');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['x-secure']).toBe('true');
      expect(res.headers['x-proto']).toBe('https');
      expect(res.body.equals(payload.subarray(100, 200))).toBe(true);
    }
  );

  it(
    'cors + helmet + morgan + async error handler',
    async () => {
      const logLines: string[] = [];
      const logStream = new Writable({
        write(chunk, _encoding, cb) {
          logLines.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
          cb();
        },
      });

      const app = createApp();
      app.use(asMw(helmet()));
      app.use(asMw(cors({ origin: 'https://client.test', credentials: true })));
      app.use(asMw(morgan(':method :url :status', { stream: logStream })));

      app.get('/fail', async () => {
        await delay(10);
        const err = Object.assign(new Error('unprocessable'), { status: 422 });
        throw err;
      });

      const errHandler: E2EErrorRequestHandler = (err, _req, res, _next) => {
        const status =
          typeof (err as { status?: unknown })?.status === 'number'
            ? (err as { status: number }).status
            : 500;
        res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
      };
      app.use(errHandler);

      const srv = trackServer(await startServer(app));

      const preflight = await performHttpRequest({
        url: `${srv.baseUrl}/fail`,
        method: 'OPTIONS',
        headers: {
          Origin: 'https://client.test',
          'Access-Control-Request-Method': 'GET',
        },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('https://client.test');
      expect(preflight.headers['access-control-allow-credentials']).toBe('true');

      const getRes = await performHttpRequest({
        url: `${srv.baseUrl}/fail`,
        headers: { Origin: 'https://client.test' },
      });
      expect(getRes.statusCode).toBe(422);
      expect(JSON.parse(getRes.body.toString('utf8'))).toEqual({ error: 'unprocessable' });
      expect(getRes.headers['access-control-allow-origin']).toBe('https://client.test');
      expect(getRes.headers['access-control-allow-credentials']).toBe('true');
      expect(getRes.headers['x-content-type-options']).toBe('nosniff');
      expect(getRes.headers['x-powered-by']).toBeUndefined();

      const logged = await waitForCondition(
        () => logLines.join('').includes('GET /fail 422'),
        1500
      );
      expect(logged).toBe(true);
    }
  );

  itRxpress(
    'static + Range/If-Range/ETag + dotfiles & symlink rejection',
    async () => {
      const ws = makeWorkspace('rxpress-e2e-');
      const pubDir = ws.mkdir('pub');
      ws.writeFile('pub/doc.txt', '0123456789ABCDEF');
      ws.writeFile('pub/.env', 'SECRET=1');
      const outsidePath = ws.writeFile('outside/secret.txt', 'TOP_SECRET_OUTSIDE');
      ws.writeSymlink('pub/leak.txt', outsidePath);

      const app = createApp();
      app.use(
        '/files',
        staticMiddleware(pubDir, {
          dotfiles: 'deny',
          etag: true,
          lastModified: true,
          fallthrough: false,
        })
      );

      const srv = trackServer(await startServer(app));

      const full = await performHttpRequest({ url: `${srv.baseUrl}/files/doc.txt` });
      expect(full.statusCode).toBe(200);
      expect(full.body.toString('utf8')).toBe('0123456789ABCDEF');
      const etag = headerToString(full.headers.etag);
      expect(etag.length).toBeGreaterThan(0);

      const partial = await performHttpRequest({
        url: `${srv.baseUrl}/files/doc.txt`,
        headers: {
          Range: 'bytes=2-5',
          'If-Range': etag,
        },
      });
      expect(partial.statusCode).toBe(206);
      expect(partial.headers['content-range']).toBe('bytes 2-5/16');
      expect(partial.body.toString('utf8')).toBe('2345');

      const staleRange = await performHttpRequest({
        url: `${srv.baseUrl}/files/doc.txt`,
        headers: {
          Range: 'bytes=2-5',
          'If-Range': '"stale-etag"',
        },
      });
      expect(staleRange.statusCode).toBe(200);
      expect(staleRange.body.toString('utf8')).toBe('0123456789ABCDEF');

      const notModified = await performHttpRequest({
        url: `${srv.baseUrl}/files/doc.txt`,
        headers: { 'If-None-Match': etag },
      });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.body.length).toBe(0);

      const dotRes = await performHttpRequest({ url: `${srv.baseUrl}/files/.env` });
      expect(dotRes.statusCode).toBe(403);
      expect(dotRes.body.toString('utf8')).not.toContain('SECRET=1');

      const symlinkRes = await performHttpRequest({ url: `${srv.baseUrl}/files/leak.txt` });
      expect([403, 404]).toContain(symlinkRes.statusCode);
      expect(symlinkRes.body.toString('utf8')).not.toContain('TOP_SECRET_OUTSIDE');
    }
  );

  it(
    'nested Router + mergeParams + async router.param + json({ limit })',
    async () => {
      const app = createApp();
      const tenants = createRouter();
      const users = createRouter({ mergeParams: true });

      users.param('uid', async (req, _res, next, val) => {
        await delay(5);
        req.pUid = val;
        next();
      });

      users.post(
        '/:uid/profile',
        jsonMiddleware({ limit: 512 }),
        async (req, res) => {
          const body = req.body as { fail?: boolean; name?: string } | undefined;
          if (body?.fail) {
            throw Object.assign(new Error('bad profile'), { status: 400 });
          }
          res.status(200).json({
            tid: req.params.tid,
            uid: req.params.uid,
            pUid: req.pUid,
            body,
          });
        }
      );

      tenants.use('/:tid/users', users);
      app.use('/tenants', tenants);

      const errHandler: E2EErrorRequestHandler = (err, _req, res, _next) => {
        const status =
          typeof (err as { status?: unknown })?.status === 'number'
            ? (err as { status: number }).status
            : 500;
        res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
      };
      app.use(errHandler);

      const srv = trackServer(await startServer(app));

      const okRes = await performHttpRequest({
        url: `${srv.baseUrl}/tenants/acme/users/42/profile`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ada' }),
      });
      expect(okRes.statusCode).toBe(200);
      expect(JSON.parse(okRes.body.toString('utf8'))).toEqual({
        tid: 'acme',
        uid: '42',
        pUid: '42',
        body: { name: 'ada' },
      });

      const bigBody = JSON.stringify({ bio: 'x'.repeat(600) });
      const bigRes = await performHttpRequest({
        url: `${srv.baseUrl}/tenants/acme/users/42/profile`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bigBody,
      });
      expect(bigRes.statusCode).toBe(413);

      const errRes = await performHttpRequest({
        url: `${srv.baseUrl}/tenants/acme/users/42/profile`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fail: true }),
      });
      expect(errRes.statusCode).toBe(400);
      expect(JSON.parse(errRes.body.toString('utf8'))).toEqual({ error: 'bad profile' });
    }
  );

  it(
    'trust proxy + req.ip/req.secure + Secure cookie & 302 redirect',
    async () => {
      const app = createApp();
      app.set('trust proxy', true);

      app.get('/login', (req, res) => {
        res.setHeader('x-ip', req.ip ?? '');
        res.setHeader('x-secure', String(req.secure));
        res.cookie('sid', 'tok123', {
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
        });
        res.redirect(302, '/home');
      });

      const srv = trackServer(await startServer(app));

      const res = await performHttpRequest({
        url: `${srv.baseUrl}/login`,
        headers: {
          'X-Forwarded-For': '203.0.113.9',
          'X-Forwarded-Proto': 'https',
        },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/home');
      expect(res.headers['x-ip']).toBe('203.0.113.9');
      expect(res.headers['x-secure']).toBe('true');

      const setCookie = headerToString(res.headers['set-cookie']);
      expect(setCookie).toContain('sid=tok123');
      expect(setCookie).toMatch(/;\s*Secure\b/i);
      expect(setCookie).toMatch(/;\s*HttpOnly\b/i);
      expect(setCookie).toMatch(/;\s*SameSite=Lax\b/i);
    }
  );

  itRxpress(
    'pipelined valid + CL+TE smuggling rejection + keep-alive isolation',
    async () => {
      let adminHit = false;
      const app = createApp();
      app.get('/ok', (req, res) => {
        req.leaked = 'yes';
        res.json({ ok: true });
      });
      app.all('/admin', (_req, res) => {
        adminHit = true;
        res.status(200).json({ admin: true });
      });
      app.get('/clean', (req, res) => {
        res.json({ leaked: req.leaked ?? null });
      });

      const srv = trackServer(await startServer(app));
      const sock = trackSocket(await openRawSocket(srv.host, srv.port));

      const pipelined =
        'GET /ok HTTP/1.1\r\nHost: localhost\r\n\r\n' +
        'POST /admin HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n' +
        'GET /admin HTTP/1.1\r\nHost: localhost\r\n\r\n';
      await sock.write(pipelined);

      const closed = await sock.waitForClose(3000);
      expect(closed).toBe(true);

      const wireText = sock.getBufferedData().toString('latin1');
      expect(wireText).toMatch(/^HTTP\/1\.1 200 /);
      expect(wireText).toContain('{"ok":true}');
      expect(wireText).toContain('HTTP/1.1 400 ');
      expect(adminHit).toBe(false);

      const cleanRes = await sendRawHttp(
        srv.host,
        srv.port,
        'GET /clean HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect(cleanRes.statusCode).toBe(200);
      expect(JSON.parse(cleanRes.body.toString('utf8'))).toEqual({ leaked: null });
    }
  );

  itRxpress(
    'handlerTimeout times out hung handler without breaking streaming lifecycle',
    async () => {
      const app = createApp({ handlerTimeoutMs: 150 });
      app.get('/hang', () => new Promise(() => {}));
      app.get('/stream', async (_req, res) => {
        res.status(200);
        res.setHeader('Content-Type', 'text/plain');
        res.flushHeaders();
        res.write('a\n');
        await delay(220);
        res.write('b\n');
        res.end('c\n');
      });
      app.get('/health', (_req, res) => {
        res.json({ ok: true });
      });

      const srv = trackServer(await startServer(app));

      const t0 = Date.now();
      const hangRes = await sendRawHttp(
        srv.host,
        srv.port,
        'GET /hang HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
        { timeoutMs: 2500 }
      );
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(1500);
      expect(hangRes.statusCode === 504 || hangRes.statusCode === 503 || hangRes.closed).toBe(true);

      const streamRes = await sendRawHttp(
        srv.host,
        srv.port,
        'GET /stream HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
        { timeoutMs: 3000 }
      );
      expect(streamRes.statusCode).toBe(200);
      expect(streamRes.body.toString('utf8')).toBe('a\nb\nc\n');

      const healthRes = await performHttpRequest({ url: `${srv.baseUrl}/health` });
      expect(healthRes.statusCode).toBe(200);
      expect(JSON.parse(healthRes.body.toString('utf8'))).toEqual({ ok: true });
    }
  );

  itRxpress(
    'graceful close() over TLS drains in-flight async response and closes idle TLS socket',
    async () => {
      const { key, cert } = createSelfSignedCert();
      const app = createApp();
      app.get('/slow', async (_req, res) => {
        await delay(150);
        res.json({ drained: true });
      });
      app.get('/ping', (_req, res) => {
        res.json({ pong: true });
      });

      const srv = trackServer(await startTlsServer(app, { key, cert }));

      const slowReqPromise = performHttpRequest({
        url: `${srv.baseUrl}/slow`,
        ca: cert,
      });

      await delay(25);

      const idleSock = trackSocket(
        await openRawSocket(srv.host, srv.port, {
          tls: true,
          tlsOptions: { ca: cert, rejectUnauthorized: true },
        })
      );
      await idleSock.write('GET /ping HTTP/1.1\r\nHost: localhost\r\n\r\n');
      const pingBuf = await idleSock.readUntil('"pong":true', 3000);
      expect(pingBuf.toString('utf8')).toContain('"pong":true');
      await idleSock.readAvailable(20);

      let idleTlsEnded = false;
      let idleTlsError: Error | null = null;
      idleSock.socket.once('end', () => {
        idleTlsEnded = true;
      });
      idleSock.socket.once('error', (err: Error) => {
        idleTlsError = err;
      });

      const closePromise = srv.close();

      const slowRes = await slowReqPromise;
      expect(slowRes.statusCode).toBe(200);
      expect(JSON.parse(slowRes.body.toString('utf8'))).toEqual({ drained: true });

      const idleClosed = await idleSock.waitForClose(2500);
      expect(idleClosed).toBe(true);
      expect(idleTlsError).toBeNull();
      expect(idleTlsEnded).toBe(true);

      await closePromise;
    }
  );

  it(
    'urlencoded({ verify }) + prototype pollution & parameterLimit',
    async () => {
      let verifiedRaw = '';
      const app = createApp();
      app.post(
        '/form',
        urlencodedMiddleware({
          extended: true,
          parameterLimit: 3,
          verify: (req, _res, buf) => {
            verifiedRaw = buf.toString('utf8');
            if (req.headers['x-sig'] === 'bad') {
              throw Object.assign(new Error('invalid signature'), { status: 401 });
            }
          },
        }),
        (req, res) => {
          const polluted = ({} as Record<string, unknown>).polluted ?? null;
          const p2 = ({} as Record<string, unknown>).p2 ?? null;
          res.json({ body: req.body, polluted, p2 });
        }
      );

      const errHandler: E2EErrorRequestHandler = (err, _req, res, _next) => {
        const status =
          typeof (err as { status?: unknown })?.status === 'number'
            ? (err as { status: number }).status
            : 500;
        res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
      };
      app.use(errHandler);

      const srv = trackServer(await startServer(app));

      const payload = '__proto__[polluted]=yes&constructor[prototype][p2]=yes&name=alice';
      const okRes = await performHttpRequest({
        url: `${srv.baseUrl}/form`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-sig': 'ok',
        },
        body: payload,
      });
      expect(okRes.statusCode).toBe(200);
      const parsed = JSON.parse(okRes.body.toString('utf8')) as {
        body: Record<string, unknown>;
        polluted: unknown;
        p2: unknown;
      };
      expect(parsed.polluted).toBeNull();
      expect(parsed.p2).toBeNull();
      expect(parsed.body.name).toBe('alice');
      expect(verifiedRaw).toBe(payload);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(({} as Record<string, unknown>).p2).toBeUndefined();

      const badSigRes = await performHttpRequest({
        url: `${srv.baseUrl}/form`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-sig': 'bad',
        },
        body: 'name=bob',
      });
      expect(badSigRes.statusCode).toBe(401);

      const limitRes = await performHttpRequest({
        url: `${srv.baseUrl}/form`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-sig': 'ok',
        },
        body: 'a=1&b=2&c=3&d=4',
      });
      if (limitRes.statusCode === 200) {
        const limitData = JSON.parse(limitRes.body.toString('utf8')) as {
          body: Record<string, unknown>;
        };
        expect(Object.keys(limitData.body).length).toBeLessThanOrEqual(3);
      } else {
        expect([400, 413]).toContain(limitRes.statusCode);
      }
    }
  );

  it(
    'NODE_ENV=production error handler + CRLF injection defense',
    async () => {
      const ws = makeWorkspace('rxpress-e2e-');
      setupConsumerPackage(ws, REPO_ROOT, {
        type: 'module',
        linkDeps: isExpressBaseline() ? ['express'] : [],
      });

      const targetImport = isExpressBaseline() ? 'express' : 'rxpress';
      const scriptPath = ws.writeFile(
        'prod-server.mjs',
        `
import factory from ${JSON.stringify(targetImport)};

const app = factory();
app.get('/boom', () => {
  throw new Error('DB_SECRET\\r\\nEvil: injected');
});

const srv = app.listen(0, '127.0.0.1', () => {
  const addr = srv.address();
  process.stdout.write('PORT=' + addr.port + '\\n');
});

process.stdin.resume();
process.stdin.on('end', () => {
  Promise.resolve(srv.close(() => process.exit(0))).then(() => process.exit(0));
});
`
      );

      const child = trackChild(
        spawn(process.execPath, [scriptPath], {
          cwd: ws.dir,
          env: { ...process.env, NODE_ENV: 'production' },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      );

      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });

      const port = await new Promise<number>((resolve, reject) => {
        let stdout = '';
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for child port. stderr=${stderr}`)),
          8000
        );
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          const m = /PORT=(\d+)/.exec(stdout);
          if (m) {
            clearTimeout(timer);
            resolve(Number.parseInt(m[1], 10));
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Child exited early (${code}): ${stderr}`));
        });
      });

      let exitCode: number | null = null;
      try {
        const res = await sendRawHttp(
          '127.0.0.1',
          port,
          'GET /boom HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
        );
        expect(res.statusCode).toBe(500);
        expect(res.headers['evil']).toBeUndefined();
        expect(res.headersRaw).not.toMatch(/Evil:/i);
        const bodyText = res.body.toString('utf8');
        expect(bodyText).toContain('Internal Server Error');
        expect(bodyText).not.toContain('DB_SECRET');
        expect(bodyText).not.toContain('Evil: injected');
      } finally {
        child.stdin?.end();
        exitCode = await new Promise<number | null>((resolve) => {
          const t = setTimeout(() => {
            child.kill('SIGKILL');
            resolve(null);
          }, 3000);
          child.once('exit', (code) => {
            clearTimeout(t);
            resolve(code);
          });
        });
      }
      expect(exitCode).toBe(0);
    }
  );

  itRxpress(
    'ESM and CJS child processes load rxpress + cors + helmet + static',
    () => {
      const esmWs = makeWorkspace('rxpress-e2e-esm-');
      setupConsumerPackage(esmWs, REPO_ROOT, {
        type: 'module',
        linkDeps: ['cors', 'helmet'],
      });
      const esmPub = esmWs.mkdir('public');
      esmWs.writeFile('public/hello.txt', 'hello-esm');

      const esmScript = esmWs.writeFile(
        'app.mjs',
        `
import rxpress, { serveStatic } from 'rxpress';
import cors from 'cors';
import helmet from 'helmet';

const app = rxpress();
app.use(helmet());
app.use(cors({ origin: 'https://web.test' }));
app.use('/static', serveStatic(${JSON.stringify(esmPub)}));
app.get('/api', (_req, res) => res.json({ mode: 'esm' }));

const srv = app.listen(0, '127.0.0.1');
try {
  const port = srv.address().port;
  const apiRes = await fetch(\`http://127.0.0.1:\${port}/api\`, {
    headers: { Origin: 'https://web.test' },
  });
  if (apiRes.status !== 200) throw new Error('ESM /api status ' + apiRes.status);
  if (apiRes.headers.get('access-control-allow-origin') !== 'https://web.test') {
    throw new Error('ESM missing CORS header');
  }
  if (apiRes.headers.get('x-content-type-options') !== 'nosniff') {
    throw new Error('ESM missing helmet nosniff header');
  }
  if (apiRes.headers.get('x-powered-by') !== null) {
    throw new Error('ESM x-powered-by not stripped by helmet');
  }
  const apiBody = await apiRes.json();
  if (apiBody.mode !== 'esm') throw new Error('ESM unexpected JSON body');

  const stRes = await fetch(\`http://127.0.0.1:\${port}/static/hello.txt\`);
  if (stRes.status !== 200 || (await stRes.text()) !== 'hello-esm') {
    throw new Error('ESM static mismatch');
  }
} finally {
  await srv.close();
}
`
      );

      const esmOut = spawnSync(process.execPath, [esmScript], {
        cwd: esmWs.dir,
        encoding: 'utf8',
        timeout: 15000,
      });
      expect(esmOut.stderr).toBe('');
      expect(esmOut.status).toBe(0);

      const cjsWs = makeWorkspace('rxpress-e2e-cjs-');
      setupConsumerPackage(cjsWs, REPO_ROOT, {
        type: 'commonjs',
        linkDeps: ['cors', 'helmet'],
      });
      const cjsPub = cjsWs.mkdir('public');
      cjsWs.writeFile('public/hello.txt', 'hello-cjs');

      const cjsScript = cjsWs.writeFile(
        'app.cjs',
        `
const rxpress = require('rxpress');
const cors = require('cors');
const helmet = require('helmet');

if (typeof rxpress !== 'function') {
  throw new Error('require("rxpress") must be callable, got ' + typeof rxpress);
}

const app = rxpress();
app.use(helmet());
app.use(cors({ origin: 'https://web.test' }));
app.use('/static', rxpress.static(${JSON.stringify(cjsPub)}));
app.get('/api', (_req, res) => res.json({ mode: 'cjs' }));

(async () => {
  const srv = app.listen(0, '127.0.0.1');
  try {
    const port = srv.address().port;
    const apiRes = await fetch(\`http://127.0.0.1:\${port}/api\`, {
      headers: { Origin: 'https://web.test' },
    });
    if (apiRes.status !== 200) throw new Error('CJS /api status ' + apiRes.status);
    if (apiRes.headers.get('access-control-allow-origin') !== 'https://web.test') {
      throw new Error('CJS missing CORS header');
    }
    if (apiRes.headers.get('x-content-type-options') !== 'nosniff') {
      throw new Error('CJS missing helmet nosniff header');
    }
    if (apiRes.headers.get('x-powered-by') !== null) {
      throw new Error('CJS x-powered-by not stripped by helmet');
    }
    const apiBody = await apiRes.json();
    if (apiBody.mode !== 'cjs') throw new Error('CJS unexpected JSON body');

    const stRes = await fetch(\`http://127.0.0.1:\${port}/static/hello.txt\`);
    if (stRes.status !== 200 || (await stRes.text()) !== 'hello-cjs') {
      throw new Error('CJS static mismatch');
    }
  } finally {
    await srv.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
`
      );

      const cjsOut = spawnSync(process.execPath, [cjsScript], {
        cwd: cjsWs.dir,
        encoding: 'utf8',
        timeout: 15000,
      });
      expect(cjsOut.stderr).toBe('');
      expect(cjsOut.status).toBe(0);
    }
  );

  it(
    'res.format / req.accepts + HEAD body auto-suppression',
    async () => {
      const app = createApp();
      app.get('/item', (req, res) => {
        res.format({
          json: () => res.json({ item: 1, accepted: req.accepts(['json', 'html']) }),
          html: () => res.send('<h1>1</h1>'),
        });
      });

      const srv = trackServer(await startServer(app));

      const headRes = await sendRawHttp(
        srv.host,
        srv.port,
        'HEAD /item HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nConnection: close\r\n\r\n'
      );
      expect(headRes.statusCode).toBe(200);
      expect(String(headRes.headers['content-type'] ?? '')).toContain('application/json');
      expect(String(headRes.headers['vary'] ?? '').toLowerCase()).toContain('accept');
      const hdrEnd = headRes.raw.indexOf('\r\n\r\n');
      expect(hdrEnd).toBeGreaterThan(-1);
      expect(headRes.raw.subarray(hdrEnd + 4).length).toBe(0);

      const htmlRes = await sendRawHttp(
        srv.host,
        srv.port,
        'GET /item HTTP/1.1\r\nHost: localhost\r\nAccept: text/html\r\nConnection: close\r\n\r\n'
      );
      expect(htmlRes.statusCode).toBe(200);
      expect(String(htmlRes.headers['content-type'] ?? '')).toContain('text/html');
      expect(htmlRes.body.toString('utf8')).toBe('<h1>1</h1>');
    }
  );

  itRxpress(
    'maxConnections + closeAllConnections()',
    async () => {
      const app = createApp({ maxConnections: 3 });
      app.get('/sse', (_req, res) => {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders();
        res.write('data: open\n\n');
      });
      app.get('/ping', (_req, res) => {
        res.json({ ok: true });
      });

      const srv = trackServer(await startServer(app));

      const sseSockets: RawSocketClient[] = [];
      for (let i = 0; i < 3; i++) {
        const s = trackSocket(await openRawSocket(srv.host, srv.port));
        await s.write('GET /sse HTTP/1.1\r\nHost: localhost\r\n\r\n');
        const chunk = await s.readUntil('data: open', 3000);
        expect(chunk.toString('utf8')).toContain('data: open');
        sseSockets.push(s);
      }

      const fourth = await sendRawHttp(
        srv.host,
        srv.port,
        'GET /ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
        { timeoutMs: 2500 }
      );
      expect(fourth.statusCode).toBe(503);
      expect(fourth.closed).toBe(true);

      expect(typeof srv.server.closeAllConnections).toBe('function');
      srv.server.closeAllConnections!();

      const closedFlags = await Promise.all(sseSockets.map((s) => s.waitForClose(2500)));
      expect(closedFlags).toEqual([true, true, true]);

      await srv.close();
    }
  );

  it(
    'sub-routers with distinct raw / json / text body parsers',
    async () => {
      const app = createApp();

      const webhooksRouter = createRouter();
      webhooksRouter.use(rawMiddleware({ type: 'application/octet-stream' }));
      webhooksRouter.post('/hook', (req, res) => {
        const isBuf = Buffer.isBuffer(req.body);
        res.json({
          isBuf,
          hex: isBuf ? (req.body as Buffer).toString('hex') : null,
        });
      });

      const apiRouter = createRouter();
      apiRouter.use(jsonMiddleware());
      apiRouter.post('/data', (req, res) => {
        res.json({
          kind: typeof req.body,
          isBuf: Buffer.isBuffer(req.body),
          body: req.body,
        });
      });

      const plainRouter = createRouter();
      plainRouter.use(textMiddleware());
      plainRouter.post('/msg', (req, res) => {
        res.json({
          kind: typeof req.body,
          body: req.body,
        });
      });

      app.use('/webhooks', webhooksRouter);
      app.use('/api', apiRouter);
      app.use('/plain', plainRouter);

      const srv = trackServer(await startServer(app));

      const rawRes = await performHttpRequest({
        url: `${srv.baseUrl}/webhooks/hook`,
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
      });
      expect(rawRes.statusCode).toBe(200);
      expect(JSON.parse(rawRes.body.toString('utf8'))).toEqual({
        isBuf: true,
        hex: 'deadbeef',
      });

      const jsonRes = await performHttpRequest({
        url: `${srv.baseUrl}/api/data`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: 42 }),
      });
      expect(jsonRes.statusCode).toBe(200);
      expect(JSON.parse(jsonRes.body.toString('utf8'))).toEqual({
        kind: 'object',
        isBuf: false,
        body: { x: 42 },
      });

      const textRes = await performHttpRequest({
        url: `${srv.baseUrl}/plain/msg`,
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'hello plain',
      });
      expect(textRes.statusCode).toBe(200);
      expect(JSON.parse(textRes.body.toString('utf8'))).toEqual({
        kind: 'string',
        body: 'hello plain',
      });
    }
  );

  it(
    'res.download + CRLF filename header sanitization/rejection',
    async () => {
      const ws = makeWorkspace('rxpress-e2e-');
      ws.writeFile('report.txt', 'annual-report');

      const app = createApp();
      app.get('/dl', (_req, res) => {
        res.download('report.txt', 'bad\r\nEvil: injected.txt', { root: ws.dir });
      });

      const srv = trackServer(await startServer(app));

      const res = await sendRawHttp(
        srv.host,
        srv.port,
        'GET /dl HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect([200, 500]).toContain(res.statusCode);
      expect(res.headers['evil']).toBeUndefined();
      expect(res.headersRaw).not.toMatch(/\r?\nEvil:/i);
      if (res.statusCode === 200) {
        const disp = String(res.headers['content-disposition'] ?? '');
        expect(disp).toMatch(/^attachment;/i);
        expect(disp).not.toMatch(/[\r\n]/);
      }
    }
  );

  itRxpress(
    'req.cookies + keep-alive isolation & __proto__ cookie guard',
    async () => {
      const app = createApp();
      app.get('/check', (req, res) => {
        const cookies = req.cookies ?? {};
        const polluted = ({} as Record<string, unknown>).polluted ?? 'clean';
        res.json({
          session: cookies.session ?? null,
          keys: Object.keys(cookies),
          protoIsNull: Object.getPrototypeOf(cookies) === null,
          polluted,
        });
      });

      const srv = trackServer(await startServer(app));
      const sock = trackSocket(await openRawSocket(srv.host, srv.port));

      await sock.write(
        'GET /check HTTP/1.1\r\nHost: localhost\r\nCookie: __proto__=1; constructor=evil; session=abc\r\n\r\n'
      );
      const buf1 = await sock.readUntil('}', 3000);
      const text1 = buf1.toString('utf8');
      const body1 = JSON.parse(text1.slice(text1.indexOf('\r\n\r\n') + 4)) as {
        session: string | null;
        keys: string[];
        protoIsNull: boolean;
        polluted: string;
      };
      expect(body1.protoIsNull).toBe(true);
      expect(body1.keys).not.toContain('__proto__');
      expect(body1.keys).not.toContain('constructor');
      expect(body1.session).toBe('abc');
      expect(body1.polluted).toBe('clean');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();

      await sock.readAvailable(50);

      await sock.write('GET /check HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      const buf2 = await sock.readUntil('}', 3000);
      const text2 = buf2.toString('utf8');
      const body2 = JSON.parse(text2.slice(text2.indexOf('\r\n\r\n') + 4)) as {
        session: string | null;
        keys: string[];
        protoIsNull: boolean;
        polluted: string;
      };
      expect(body2.session).toBeNull();
      expect(body2.keys).toEqual([]);
      expect(body2.protoIsNull).toBe(true);
      expect(body2.polluted).toBe('clean');
    }
  );

  itRxpress(
    'Slowloris headersTimeout/requestTimeout inside TLS connection',
    async () => {
      const { key, cert } = createSelfSignedCert();
      const app = createApp({ headersTimeoutMs: 150, requestTimeoutMs: 500 });
      app.get('/health', (_req, res) => {
        res.json({ ok: true });
      });

      const srv = trackServer(await startTlsServer(app, { key, cert }));

      const slowSock = trackSocket(
        await openRawSocket(srv.host, srv.port, {
          tls: true,
          tlsOptions: { ca: cert, rejectUnauthorized: true },
        })
      );
      await slowSock.write('GET /health HTTP/1.1\r\nHost: localhost\r\n');

      const healthyRes = await performHttpRequest({
        url: `${srv.baseUrl}/health`,
        ca: cert,
      });
      expect(healthyRes.statusCode).toBe(200);
      expect(JSON.parse(healthyRes.body.toString('utf8'))).toEqual({ ok: true });

      const closed = await slowSock.waitForClose(1500);
      expect(closed).toBe(true);
    }
  );
});
