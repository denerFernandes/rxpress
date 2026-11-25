import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  createSelfSignedCert,
  isExpressBaseline,
  itRxpress,
  jsonMiddleware,
  startServer,
  startTlsServer,
  staticMiddleware,
  urlencodedMiddleware,
  type E2ERequest,
  type E2ERequestHandler,
  type E2EResponse,
  type StartedServer,
} from './helpers/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const TSC_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');

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

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function headerToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(', ');
  return value ?? '';
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
      timeout: opts.timeoutMs ?? 15000,
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

describe('Real-world application scenarios', () => {
  it(
    'Production REST API service behind reverse proxy (helmet, cors, morgan, trust proxy, nested routers, NODE_ENV=production)',
    async () => {
      const ws = makeWorkspace('rxpress-e2e-');
      setupConsumerPackage(ws, REPO_ROOT, {
        type: 'module',
        linkDeps: isExpressBaseline()
          ? ['express', 'cors', 'helmet', 'morgan']
          : ['cors', 'helmet', 'morgan'],
      });

      const logPath = ws.resolve('morgan.log');
      const targetImport = isExpressBaseline() ? 'express' : 'rxpress';

      const scriptPath = ws.writeFile(
        'api-server.mjs',
        `
import { createWriteStream } from 'node:fs';
import factory from ${JSON.stringify(targetImport)};
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

const app = factory();
app.disable('x-powered-by');
app.set('trust proxy', true);

const logStream = createWriteStream(${JSON.stringify(logPath)}, { flags: 'a' });
app.use(helmet());
app.use(cors({ origin: 'https://portal.test', credentials: true }));
app.use(morgan(':method :url :status', { stream: logStream }));
app.use(factory.json());

const store = new Map();
let seq = 0;

const apiV1 = factory.Router();
const orgRouter = factory.Router({ mergeParams: true });
const itemsRouter = factory.Router({ mergeParams: true });

orgRouter.param('orgId', async (req, _res, next, val) => {
  await new Promise((r) => setTimeout(r, 2));
  req.orgSlug = String(val).toUpperCase();
  next();
});

itemsRouter.param('itemId', async (req, _res, next, val) => {
  await new Promise((r) => setTimeout(r, 2));
  req.itemKey = req.params.orgId + ':' + val;
  next();
});

itemsRouter.post('/', async (req, res) => {
  await new Promise((r) => setTimeout(r, 3));
  seq += 1;
  const id = String(seq);
  const key = req.params.orgId + ':' + id;
  const record = {
    id,
    orgId: req.params.orgId,
    orgSlug: req.orgSlug,
    name: req.body?.name ?? 'unnamed',
    ip: req.ip,
    secure: req.secure,
  };
  store.set(key, record);
  res.status(201).json(record);
});

itemsRouter.get('/boom', async () => {
  await new Promise((r) => setTimeout(r, 2));
  throw new Error('DB_PASSWORD_LEAK');
});

itemsRouter.get('/:itemId', async (req, res) => {
  await new Promise((r) => setTimeout(r, 2));
  const rec = store.get(req.itemKey);
  if (!rec) {
    throw Object.assign(new Error('Item not found'), { status: 404 });
  }
  res.status(200).json(rec);
});

itemsRouter.put('/:itemId', async (req, res) => {
  await new Promise((r) => setTimeout(r, 2));
  const rec = store.get(req.itemKey);
  if (!rec) {
    throw Object.assign(new Error('Item not found'), { status: 404 });
  }
  if (req.body?.conflict) {
    throw Object.assign(new Error('Version conflict'), { status: 409 });
  }
  rec.name = req.body?.name ?? rec.name;
  res.status(200).json(rec);
});

itemsRouter.delete('/:itemId', async (req, res) => {
  await new Promise((r) => setTimeout(r, 2));
  if (!store.delete(req.itemKey)) {
    throw Object.assign(new Error('Item not found'), { status: 404 });
  }
  res.status(204).end();
});

orgRouter.use('/:orgId/items', itemsRouter);
apiV1.use('/orgs', orgRouter);
app.use('/api/v1', apiV1);

app.use((err, _req, res, next) => {
  if (err && typeof err.status === 'number' && err.status < 500) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
});

const srv = app.listen(0, '127.0.0.1', () => {
  const addr = srv.address();
  process.stdout.write('PORT=' + addr.port + '\\n');
});

process.stdin.resume();
process.stdin.on('end', async () => {
  await new Promise((resolve) => {
    Promise.resolve(srv.close(() => resolve())).then(resolve, resolve);
  });
  await new Promise((resolve) => logStream.end(resolve));
  process.exit(0);
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
          () => reject(new Error(`Child startup timeout. stderr=${stderr}`)),
          8000
        );
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          const match = /PORT=(\d+)/.exec(stdout);
          if (match) {
            clearTimeout(timer);
            resolve(Number.parseInt(match[1], 10));
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Child exited early (${code}). stderr=${stderr}`));
        });
      });

      const baseUrl = `http://127.0.0.1:${port}`;
      let exitCode: number | null = null;
      try {
        const preflight = await performHttpRequest({
          url: `${baseUrl}/api/v1/orgs/acme/items`,
          method: 'OPTIONS',
          headers: {
            Origin: 'https://portal.test',
            'Access-Control-Request-Method': 'POST',
          },
        });
        expect(preflight.statusCode).toBe(204);
        expect(preflight.headers['access-control-allow-origin']).toBe('https://portal.test');
        expect(preflight.headers['access-control-allow-credentials']).toBe('true');

        const proxyHeaders = {
          Origin: 'https://portal.test',
          'X-Forwarded-For': '198.51.100.77',
          'X-Forwarded-Proto': 'https',
          'Content-Type': 'application/json',
        };

        const createRes = await performHttpRequest({
          url: `${baseUrl}/api/v1/orgs/acme/items`,
          method: 'POST',
          headers: proxyHeaders,
          body: JSON.stringify({ name: 'widget-1' }),
        });
        expect(createRes.statusCode).toBe(201);
        expect(createRes.headers['x-powered-by']).toBeUndefined();
        expect(createRes.headers['x-content-type-options']).toBe('nosniff');
        expect(createRes.headers['access-control-allow-origin']).toBe('https://portal.test');
        const created = JSON.parse(createRes.body.toString('utf8')) as {
          id: string;
          orgId: string;
          orgSlug: string;
          name: string;
          ip: string;
          secure: boolean;
        };
        expect(created).toEqual({
          id: '1',
          orgId: 'acme',
          orgSlug: 'ACME',
          name: 'widget-1',
          ip: '198.51.100.77',
          secure: true,
        });

        const getRes = await performHttpRequest({
          url: `${baseUrl}/api/v1/orgs/acme/items/1`,
          headers: { Origin: 'https://portal.test' },
        });
        expect(getRes.statusCode).toBe(200);
        expect(JSON.parse(getRes.body.toString('utf8')).name).toBe('widget-1');

        const missingRes = await performHttpRequest({
          url: `${baseUrl}/api/v1/orgs/acme/items/999`,
          headers: { Origin: 'https://portal.test' },
        });
        expect(missingRes.statusCode).toBe(404);

        const putRes = await performHttpRequest({
          url: `${baseUrl}/api/v1/orgs/acme/items/1`,
          method: 'PUT',
          headers: proxyHeaders,
          body: JSON.stringify({ name: 'widget-v2' }),
        });
        expect(putRes.statusCode).toBe(200);
        expect(JSON.parse(putRes.body.toString('utf8')).name).toBe('widget-v2');

        const conflictRes = await performHttpRequest({
          url: `${baseUrl}/api/v1/orgs/acme/items/1`,
          method: 'PUT',
          headers: proxyHeaders,
          body: JSON.stringify({ conflict: true }),
        });
        expect(conflictRes.statusCode).toBe(409);

        const delRes = await performHttpRequest({
          url: `${baseUrl}/api/v1/orgs/acme/items/1`,
          method: 'DELETE',
          headers: { Origin: 'https://portal.test' },
        });
        expect(delRes.statusCode).toBe(204);

        const boomRes = await performHttpRequest({
          url: `${baseUrl}/api/v1/orgs/acme/items/boom`,
          headers: { Origin: 'https://portal.test' },
        });
        expect(boomRes.statusCode).toBe(500);
        const boomBody = boomRes.body.toString('utf8');
        expect(boomBody).toContain('Internal Server Error');
        expect(boomBody).not.toContain('DB_PASSWORD_LEAK');
        expect(boomBody).not.toContain('api-server.mjs');
      } finally {
        child.stdin?.end();
        exitCode = await new Promise<number | null>((resolve) => {
          const t = setTimeout(() => {
            child.kill('SIGKILL');
            resolve(null);
          }, 4000);
          child.once('exit', (code) => {
            clearTimeout(t);
            resolve(code);
          });
        });
      }

      expect(exitCode).toBe(0);
      expect(stderr).not.toContain('UnhandledPromiseRejection');

      const logs = readFileSync(logPath, 'utf8');
      expect(logs).toContain('POST /api/v1/orgs/acme/items 201');
      expect(logs).toContain('GET /api/v1/orgs/acme/items/1 200');
      expect(logs).toContain('GET /api/v1/orgs/acme/items/999 404');
      expect(logs).toContain('PUT /api/v1/orgs/acme/items/1 409');
      expect(logs).toContain('DELETE /api/v1/orgs/acme/items/1 204');
      expect(logs).toContain('GET /api/v1/orgs/acme/items/boom 500');
    }
  );

  it(
    'Static SPA + Asset CDN + API Gateway (etag, 304, Range/If-Range, dotfiles, traversal, *splat, json)',
    async () => {
      const ws = makeWorkspace('rxpress-e2e-');
      const spaDir = ws.mkdir('spa');
      const assetsDir = ws.mkdir('spa/assets');
      const indexHtml = '<!doctype html><html><body>SPA_SHELL</body></html>';
      const videoBuf = Buffer.alloc(1024);
      for (let i = 0; i < videoBuf.length; i++) {
        videoBuf[i] = (i * 7) % 256;
      }

      ws.writeFile('spa/index.html', indexHtml);
      ws.writeFile('spa/assets/app.js', 'console.log("cdn-bundle");');
      ws.writeFile('spa/assets/video.bin', videoBuf);
      ws.writeFile('spa/assets/.env', 'ASSET_SECRET=1');
      ws.writeFile('spa/.env', 'SPA_SECRET=1');
      const outsideFile = ws.writeFile('outside.txt', 'OUTSIDE_SECRET_DATA');
      ws.writeSymlink('spa/assets/leak.txt', outsideFile);

      const app = createApp();
      app.post('/api/contact', jsonMiddleware(), (req, res) => {
        res.status(200).json({ received: req.body });
      });
      app.use(
        '/assets',
        staticMiddleware(assetsDir, {
          etag: true,
          lastModified: true,
          maxAge: '1d',
          dotfiles: 'deny',
          fallthrough: false,
        })
      );
      app.use(
        staticMiddleware(spaDir, {
          index: 'index.html',
          dotfiles: 'deny',
        })
      );
      app.get('*splat', (_req, res) => {
        res.sendFile('index.html', { root: spaDir });
      });

      const srv = trackServer(await startServer(app));

      const jsRes = await performHttpRequest({ url: `${srv.baseUrl}/assets/app.js` });
      expect(jsRes.statusCode).toBe(200);
      expect(jsRes.body.toString('utf8')).toBe('console.log("cdn-bundle");');
      expect(headerToString(jsRes.headers['cache-control'])).toContain('max-age=86400');
      const jsEtag = headerToString(jsRes.headers.etag);
      expect(jsEtag.length).toBeGreaterThan(0);

      const js304 = await performHttpRequest({
        url: `${srv.baseUrl}/assets/app.js`,
        headers: { 'If-None-Match': jsEtag },
      });
      expect(js304.statusCode).toBe(304);
      expect(js304.body.length).toBe(0);

      const vidFull = await performHttpRequest({ url: `${srv.baseUrl}/assets/video.bin` });
      expect(vidFull.statusCode).toBe(200);
      const vidEtag = headerToString(vidFull.headers.etag);
      expect(vidEtag.length).toBeGreaterThan(0);

      const vidRange = await performHttpRequest({
        url: `${srv.baseUrl}/assets/video.bin`,
        headers: {
          Range: 'bytes=100-199',
          'If-Range': vidEtag,
        },
      });
      expect(vidRange.statusCode).toBe(206);
      expect(vidRange.headers['content-range']).toBe('bytes 100-199/1024');
      expect(vidRange.body.equals(videoBuf.subarray(100, 200))).toBe(true);

      const vidStale = await performHttpRequest({
        url: `${srv.baseUrl}/assets/video.bin`,
        headers: {
          Range: 'bytes=100-199',
          'If-Range': '"stale-tag"',
        },
      });
      expect(vidStale.statusCode).toBe(200);
      expect(vidStale.body.equals(videoBuf)).toBe(true);

      const dotRes = await performHttpRequest({ url: `${srv.baseUrl}/assets/.env` });
      expect(dotRes.statusCode).toBe(403);
      expect(dotRes.body.toString('utf8')).not.toContain('ASSET_SECRET');

      const traversalRes = await sendRawHttp(
        srv.host,
        srv.port,
        'GET /assets/%2e%2e/outside.txt HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      );
      expect([403, 404]).toContain(traversalRes.statusCode);
      expect(traversalRes.body.toString('utf8')).not.toContain('OUTSIDE_SECRET_DATA');

      if (!isExpressBaseline()) {
        const symlinkRes = await performHttpRequest({ url: `${srv.baseUrl}/assets/leak.txt` });
        expect([403, 404]).toContain(symlinkRes.statusCode);
        expect(symlinkRes.body.toString('utf8')).not.toContain('OUTSIDE_SECRET_DATA');
      }

      const spaFallback = await performHttpRequest({ url: `${srv.baseUrl}/app/users/42` });
      expect(spaFallback.statusCode).toBe(200);
      expect(spaFallback.body.toString('utf8')).toBe(indexHtml);

      const apiRes = await performHttpRequest({
        url: `${srv.baseUrl}/api/contact`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.test', msg: 'hi' }),
      });
      expect(apiRes.statusCode).toBe(200);
      expect(JSON.parse(apiRes.body.toString('utf8'))).toEqual({
        received: { email: 'user@example.test', msg: 'hi' },
      });
    }
  );

  itRxpress(
    'HTTPS real-time SSE notification hub (10 TLS clients, broadcast, abort cleanup, closeAllConnections)',
    async () => {
      const { key, cert } = createSelfSignedCert();
      const app = createApp();
      app.use(jsonMiddleware());

      let nextSubId = 0;
      let closedCount = 0;
      let eventSeq = 0;
      const subscribers = new Map<number, E2EResponse>();

      app.get('/subscribe', (req, res) => {
        const id = ++nextSubId;
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.flushHeaders();
        res.write(': connected\n\n');
        subscribers.set(id, res);

        req.on('close', () => {
          if (subscribers.delete(id)) {
            closedCount += 1;
          }
        });
      });

      app.post('/publish', (req, res) => {
        eventSeq += 1;
        const frame = `id: ${eventSeq}\ndata: ${JSON.stringify(req.body)}\n\n`;
        let delivered = 0;
        for (const subRes of subscribers.values()) {
          if (subRes.write(frame)) {
            delivered += 1;
          }
        }
        res.status(200).json({ seq: eventSeq, delivered });
      });

      const srv = trackServer(await startTlsServer(app, { key, cert }));

      const clients: RawSocketClient[] = [];
      for (let i = 0; i < 10; i++) {
        const c = trackSocket(
          await openRawSocket(srv.host, srv.port, {
            tls: true,
            tlsOptions: { ca: cert, rejectUnauthorized: true },
          })
        );
        await c.write('GET /subscribe HTTP/1.1\r\nHost: localhost\r\n\r\n');
        await c.readUntil(': connected\n\n', 4000);
        await c.readAvailable(10);
        clients.push(c);
      }

      for (let seq = 1; seq <= 5; seq++) {
        const pub = await performHttpRequest({
          url: `${srv.baseUrl}/publish`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ n: seq }),
          ca: cert,
        });
        expect(pub.statusCode).toBe(200);
        expect(JSON.parse(pub.body.toString('utf8'))).toEqual({ seq, delivered: 10 });
      }

      for (const c of clients) {
        const buf = await c.readUntil('id: 5\ndata: {"n":5}\n\n', 4000);
        const txt = buf.toString('utf8');
        for (let seq = 1; seq <= 5; seq++) {
          expect(txt).toContain(`id: ${seq}\ndata: {"n":${seq}}\n\n`);
        }
        await c.readAvailable(10);
      }

      for (let i = 0; i < 4; i++) {
        clients[i].destroy();
      }
      const abortedDetected = await waitForCondition(() => closedCount === 4, 2500);
      expect(abortedDetected).toBe(true);

      const remaining = clients.slice(4);
      for (let seq = 6; seq <= 10; seq++) {
        const pub = await performHttpRequest({
          url: `${srv.baseUrl}/publish`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ n: seq }),
          ca: cert,
        });
        expect(pub.statusCode).toBe(200);
        expect(JSON.parse(pub.body.toString('utf8'))).toEqual({ seq, delivered: 6 });
      }

      for (const c of remaining) {
        const buf = await c.readUntil('id: 10\ndata: {"n":10}\n\n', 4000);
        const txt = buf.toString('utf8');
        for (let seq = 6; seq <= 10; seq++) {
          expect(txt).toContain(`id: ${seq}\ndata: {"n":${seq}}\n\n`);
        }
      }

      expect(typeof srv.server.closeAllConnections).toBe('function');
      srv.server.closeAllConnections!();

      const remainingClosed = await Promise.all(remaining.map((c) => c.waitForClose(2500)));
      expect(remainingClosed).toEqual([true, true, true, true, true, true]);

      await srv.close();
    }
  );

  itRxpress(
    'Authenticated file vault & resumable download portal (cookies, redirect, sendFile, download, Range/If-Range, traversal)',
    async () => {
      const ws = makeWorkspace('rxpress-e2e-');
      const vaultDir = ws.mkdir('vault');
      const totalSize = 2 * 1024 * 1024;
      const archiveBuf = Buffer.alloc(totalSize);
      for (let i = 0; i < totalSize; i++) {
        archiveBuf[i] = (i * 31 + 17) & 0xff;
      }
      const expectedSha = sha256Hex(archiveBuf);
      ws.writeFile('vault/archive.bin', archiveBuf);
      const outsidePath = ws.writeFile('outside.txt', 'VAULT_OUTSIDE_SECRET');
      ws.writeSymlink('vault/escape.bin', outsidePath);

      const app = createApp();
      app.post('/login', urlencodedMiddleware({ extended: false }), (req, res) => {
        const body = req.body as Record<string, unknown> | undefined;
        if (body?.user !== 'vault') {
          res.status(401).json({ error: 'Invalid credentials' });
          return;
        }
        res.cookie('vault_session', 'valid-token', {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
        });
        res.redirect(302, '/portal');
      });

      const requireAuth: E2ERequestHandler = (req: E2ERequest, res: E2EResponse, next) => {
        if (req.cookies?.vault_session !== 'valid-token') {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        next();
      };

      app.get('/files/:name', requireAuth, (req, res) => {
        res.sendFile(req.params.name, { root: vaultDir });
      });

      app.get('/download/:name', requireAuth, (req, res) => {
        res.download(req.params.name, 'vault-export.bin', { root: vaultDir });
      });

      const srv = trackServer(await startServer(app));

      const unauth = await performHttpRequest({ url: `${srv.baseUrl}/files/archive.bin` });
      expect(unauth.statusCode).toBe(401);

      const loginRes = await performHttpRequest({
        url: `${srv.baseUrl}/login`,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'user=vault',
      });
      expect(loginRes.statusCode).toBe(302);
      expect(loginRes.headers.location).toBe('/portal');
      const setCookie = headerToString(loginRes.headers['set-cookie']);
      expect(setCookie).toContain('vault_session=valid-token');
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);

      const cookiePair = 'vault_session=valid-token';

      const fullRes = await performHttpRequest({
        url: `${srv.baseUrl}/files/archive.bin`,
        headers: { Cookie: cookiePair },
      });
      expect(fullRes.statusCode).toBe(200);
      expect(sha256Hex(fullRes.body)).toBe(expectedSha);
      const etag = headerToString(fullRes.headers.etag);
      expect(etag.length).toBeGreaterThan(0);

      const part1 = await performHttpRequest({
        url: `${srv.baseUrl}/files/archive.bin`,
        headers: {
          Cookie: cookiePair,
          Range: 'bytes=0-1048575',
          'If-Range': etag,
        },
      });
      expect(part1.statusCode).toBe(206);
      expect(part1.headers['content-range']).toBe(`bytes 0-1048575/${totalSize}`);

      const part2 = await performHttpRequest({
        url: `${srv.baseUrl}/files/archive.bin`,
        headers: {
          Cookie: cookiePair,
          Range: `bytes=1048576-${totalSize - 1}`,
          'If-Range': etag,
        },
      });
      expect(part2.statusCode).toBe(206);
      expect(part2.headers['content-range']).toBe(`bytes 1048576-${totalSize - 1}/${totalSize}`);

      const reassembled = Buffer.concat([part1.body, part2.body]);
      expect(reassembled.length).toBe(totalSize);
      expect(sha256Hex(reassembled)).toBe(expectedSha);

      const staleRes = await performHttpRequest({
        url: `${srv.baseUrl}/files/archive.bin`,
        headers: {
          Cookie: cookiePair,
          Range: 'bytes=0-1023',
          'If-Range': '"stale-etag"',
        },
      });
      expect(staleRes.statusCode).toBe(200);
      expect(sha256Hex(staleRes.body)).toBe(expectedSha);

      const dlRes = await performHttpRequest({
        url: `${srv.baseUrl}/download/archive.bin`,
        headers: { Cookie: cookiePair },
      });
      expect(dlRes.statusCode).toBe(200);
      expect(headerToString(dlRes.headers['content-disposition'])).toContain('attachment');
      expect(headerToString(dlRes.headers['content-disposition'])).toContain('vault-export.bin');
      expect(sha256Hex(dlRes.body)).toBe(expectedSha);

      const traversal = await sendRawHttp(
        srv.host,
        srv.port,
        `GET /files/..%2foutside.txt HTTP/1.1\r\nHost: localhost\r\nCookie: ${cookiePair}\r\nConnection: close\r\n\r\n`
      );
      expect([403, 404]).toContain(traversal.statusCode);
      expect(traversal.body.toString('utf8')).not.toContain('VAULT_OUTSIDE_SECRET');

      const symlinkEscape = await performHttpRequest({
        url: `${srv.baseUrl}/files/escape.bin`,
        headers: { Cookie: cookiePair },
      });
      expect([403, 404]).toContain(symlinkEscape.statusCode);
      expect(symlinkEscape.body.toString('utf8')).not.toContain('VAULT_OUTSIDE_SECRET');
    }
  );

  it(
    'High-concurrency mixed workload & keep-alive stress (32 workers, 1,120 mixed requests, zero pooling leaks)',
    async () => {
      const ws = makeWorkspace('rxpress-e2e-');
      const pubDir = ws.mkdir('public');
      ws.writeFile('public/asset.txt', 'static-asset-v1');

      const app = createApp();
      app.use('/static', staticMiddleware(pubDir));
      app.use(jsonMiddleware());

      app.get('/fast', (req, res) => {
        res.json({
          ok: true,
          customTag: req.customTag ?? null,
          customHdr: res.customHdr ?? null,
          secret: res.locals.secret ?? null,
        });
      });

      app.get('/async', async (req, res) => {
        const id = String(req.query.id ?? '');
        await delay(5);
        res.json({ id });
      });

      app.get('/dirty', (req, res) => {
        req.customTag = 'DIRTY';
        res.customHdr = 'LEAK';
        res.locals.secret = 'S3CR3T';
        res.json({ dirty: true });
      });

      app.get('/wrap', (_req, res) => {
        const origEnd = res.end.bind(res);
        res.end = ((...args: unknown[]) => {
          if (!res.headersSent) {
            res.setHeader('x-wrapped', '1');
          }
          return (origEnd as (...a: unknown[]) => E2EResponse)(...args);
        }) as E2EResponse['end'];
        res.json({ wrapped: true });
      });

      app.post('/echo', (req, res) => {
        res.json({ echoed: req.body });
      });

      const srv = trackServer(await startServer(app));

      const workerCount = 32;
      const requestsPerWorker = 35;

      const workers = Array.from({ length: workerCount }, async (_, w) => {
        const agent = trackAgent(new http.Agent({ keepAlive: true, maxSockets: 1 }));
        try {
          for (let i = 0; i < requestsPerWorker; i++) {
            const kind = (w + i) % 7;
            if (kind === 0) {
              const res = await performHttpRequest({ url: `${srv.baseUrl}/fast`, agent });
              expect(res.statusCode).toBe(200);
              expect(res.headers['x-wrapped']).toBeUndefined();
              expect(JSON.parse(res.body.toString('utf8'))).toEqual({
                ok: true,
                customTag: null,
                customHdr: null,
                secret: null,
              });
            } else if (kind === 1) {
              const id = `w${w}-i${i}`;
              const res = await performHttpRequest({
                url: `${srv.baseUrl}/async?id=${id}`,
                agent,
              });
              expect(res.statusCode).toBe(200);
              expect(JSON.parse(res.body.toString('utf8'))).toEqual({ id });
            } else if (kind === 2) {
              const res = await performHttpRequest({ url: `${srv.baseUrl}/dirty`, agent });
              expect(res.statusCode).toBe(200);
              expect(JSON.parse(res.body.toString('utf8'))).toEqual({ dirty: true });
            } else if (kind === 3) {
              const res = await performHttpRequest({ url: `${srv.baseUrl}/wrap`, agent });
              expect(res.statusCode).toBe(200);
              expect(res.headers['x-wrapped']).toBe('1');
              expect(JSON.parse(res.body.toString('utf8'))).toEqual({ wrapped: true });
            } else if (kind === 4) {
              const res = await performHttpRequest({
                url: `${srv.baseUrl}/static/asset.txt`,
                agent,
              });
              expect(res.statusCode).toBe(200);
              expect(res.body.toString('utf8')).toBe('static-asset-v1');
            } else if (kind === 5) {
              const res = await performHttpRequest({
                url: `${srv.baseUrl}/echo`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ w, i }),
                agent,
              });
              expect(res.statusCode).toBe(200);
              expect(JSON.parse(res.body.toString('utf8'))).toEqual({ echoed: { w, i } });
            } else {
              const res = await performHttpRequest({
                url: `${srv.baseUrl}/missing-${w}-${i}`,
                agent,
              });
              expect(res.statusCode).toBe(404);
            }
          }
        } finally {
          agent.destroy();
        }
      });

      await Promise.all(workers);
    }
  );

  itRxpress(
    'Adversarial security & DoS hardening gauntlet with concurrent /health SLA probe',
    async () => {
      const app = createApp({
        headersTimeoutMs: 200,
        requestTimeoutMs: 300,
        maxConnections: 16,
        maxHeadersCount: 24,
        maxHeaderSizeBytes: 2048,
        defaultBodyLimitBytes: 1024,
      });

      app.get('/health', (_req, res) => {
        res.json({
          ok: true,
          polluted: ({} as Record<string, unknown>).polluted ?? 'clean',
        });
      });

      app.post('/json', jsonMiddleware({ limit: 512 }), (req, res) => {
        res.json({
          body: req.body,
          polluted: ({} as Record<string, unknown>).polluted ?? 'clean',
        });
      });

      app.post('/form', urlencodedMiddleware({ extended: true, parameterLimit: 10 }), (req, res) => {
        res.json({
          body: req.body,
          polluted: ({} as Record<string, unknown>).polluted ?? 'clean',
        });
      });

      app.post('/raw-limit', (_req, res) => {
        res.json({ ok: true });
      });

      app.get('/crlf', (_req, res) => {
        res.setHeader('X-Inject', 'safe\r\nEvil: 1');
        res.send('ok');
      });

      const srv = trackServer(await startServer(app));

      let probing = true;
      const probeResults: Array<{ statusCode: number; ok: boolean; polluted: string }> = [];
      const probeTask = (async () => {
        while (probing) {
          const res = await performHttpRequest({
            url: `${srv.baseUrl}/health`,
            timeoutMs: 2000,
          });
          const data = JSON.parse(res.body.toString('utf8')) as { ok: boolean; polluted: string };
          probeResults.push({ statusCode: res.statusCode, ok: data.ok, polluted: data.polluted });
          await delay(25);
        }
      })();

      try {
        // 1) Slowloris wave
        const slowlorisSockets = await Promise.all(
          Array.from({ length: 4 }, async () => {
            const s = trackSocket(await openRawSocket(srv.host, srv.port));
            await s.write('GET /health HTTP/1.1\r\nHost: localhost\r\n');
            return s;
          })
        );

        // 2) Smuggling & framing attacks
        const clTe = await sendRawHttp(
          srv.host,
          srv.port,
          'POST /raw-limit HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'
        );
        expect(clTe.statusCode).toBe(400);
        expect(clTe.closed).toBe(true);

        const dupCl = await sendRawHttp(
          srv.host,
          srv.port,
          'POST /raw-limit HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nContent-Length: 4\r\n\r\ntest'
        );
        expect(dupCl.statusCode).toBe(400);
        expect(dupCl.closed).toBe(true);

        const badTe = await sendRawHttp(
          srv.host,
          srv.port,
          'POST /raw-limit HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n'
        );
        expect(badTe.statusCode).toBe(400);
        expect(badTe.closed).toBe(true);

        const missingHost = await sendRawHttp(
          srv.host,
          srv.port,
          'GET /health HTTP/1.1\r\nConnection: close\r\n\r\n'
        );
        expect(missingHost.statusCode).toBe(400);

        const chunkTooBig = await sendRawHttp(
          srv.host,
          srv.port,
          'POST /raw-limit HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\nffffffffffffffff\r\n'
        );
        expect([400, 413]).toContain(chunkTooBig.statusCode);

        const chunkOverflow = await sendRawHttp(
          srv.host,
          srv.port,
          'POST /raw-limit HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n10000000000000000\r\n'
        );
        expect(chunkOverflow.statusCode).toBe(400);

        // 3) CRLF response header injection defense
        const crlfRes = await sendRawHttp(
          srv.host,
          srv.port,
          'GET /crlf HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
        );
        expect(crlfRes.statusCode).toBe(500);
        expect(crlfRes.headers['evil']).toBeUndefined();
        expect(crlfRes.headersRaw).not.toMatch(/Evil:/i);

        // 4) Prototype pollution attempts across query, JSON, urlencoded, cookies
        const queryProto = await performHttpRequest({
          url: `${srv.baseUrl}/health?__proto__[polluted]=1&constructor[prototype][polluted]=1`,
        });
        expect(queryProto.statusCode).toBe(200);
        expect(JSON.parse(queryProto.body.toString('utf8')).polluted).toBe('clean');

        const jsonProto = await performHttpRequest({
          url: `${srv.baseUrl}/json`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"safe":1}',
        });
        expect(jsonProto.statusCode).toBe(200);
        expect(JSON.parse(jsonProto.body.toString('utf8')).polluted).toBe('clean');

        const formProto = await performHttpRequest({
          url: `${srv.baseUrl}/form`,
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: '__proto__[polluted]=yes&constructor[prototype][polluted]=yes&ok=1',
        });
        expect(formProto.statusCode).toBe(200);
        expect(JSON.parse(formProto.body.toString('utf8')).polluted).toBe('clean');

        const cookieProto = await sendRawHttp(
          srv.host,
          srv.port,
          'GET /health HTTP/1.1\r\nHost: localhost\r\nCookie: __proto__=1; constructor=evil\r\nConnection: close\r\n\r\n'
        );
        expect(cookieProto.statusCode).toBe(200);
        expect(JSON.parse(cookieProto.body.toString('utf8')).polluted).toBe('clean');

        // 5) Header count & header size caps
        const tooManyHeaders = Array.from({ length: 30 }, (_, i) => `X-H-${i}: v`).join('\r\n');
        const hdrCountRes = await sendRawHttp(
          srv.host,
          srv.port,
          `GET /health HTTP/1.1\r\nHost: localhost\r\n${tooManyHeaders}\r\n\r\n`
        );
        expect([400, 431]).toContain(hdrCountRes.statusCode);

        const bigHeader = `X-Big: ${'a'.repeat(2500)}`;
        const hdrSizeRes = await sendRawHttp(
          srv.host,
          srv.port,
          `GET /health HTTP/1.1\r\nHost: localhost\r\n${bigHeader}\r\n\r\n`
        );
        expect([400, 431]).toContain(hdrSizeRes.statusCode);

        // 6) Body limits
        const rawOver = await performHttpRequest({
          url: `${srv.baseUrl}/raw-limit`,
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: 'x'.repeat(1200),
        });
        expect(rawOver.statusCode).toBe(413);

        const jsonOver = await performHttpRequest({
          url: `${srv.baseUrl}/json`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: 'y'.repeat(600) }),
        });
        expect(jsonOver.statusCode).toBe(413);

        // 7) Verify all Slowloris sockets closed cleanly
        const slowClosed = await Promise.all(slowlorisSockets.map((s) => s.waitForClose(1500)));
        expect(slowClosed).toEqual([true, true, true, true]);
      } finally {
        probing = false;
        await probeTask;
      }

      expect(probeResults.length).toBeGreaterThanOrEqual(5);
      for (const p of probeResults) {
        expect(p).toEqual({ statusCode: 200, ok: true, polluted: 'clean' });
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  );

  itRxpress(
    'Zero-downtime rolling shutdown under load (drain async + streams, evict idle keep-alive, listening/close events)',
    async () => {
      const app = createApp({ shutdownTimeoutMs: 1500 });
      app.get('/ping', (_req, res) => {
        res.json({ ok: true });
      });
      app.get('/slow', async (_req, res) => {
        await delay(150);
        res.json({ slow: true });
      });
      app.get('/stream', async (_req, res) => {
        res.status(200);
        res.setHeader('Content-Type', 'text/plain');
        res.flushHeaders();
        res.write('part1\n');
        await delay(150);
        res.end('part2\n');
      });

      const handle = app.listen(0, '127.0.0.1');
      let closeCalled = false;

      try {
        expect(typeof handle.on).toBe('function');

        let listeningFired = false;
        let closeFired = false;
        handle.on!('listening', () => {
          listeningFired = true;
        });
        handle.on!('close', () => {
          closeFired = true;
        });

        await waitForCondition(() => handle.listening && listeningFired, 2000);
        expect(listeningFired).toBe(true);
        expect(handle.listening).toBe(true);

        const addr = handle.address();
        expect(addr).not.toBeNull();
        const port = addr!.port;
        const host = '127.0.0.1';

        const idleSockets: RawSocketClient[] = [];
        for (let i = 0; i < 5; i++) {
          const s = trackSocket(await openRawSocket(host, port));
          await s.write('GET /ping HTTP/1.1\r\nHost: localhost\r\n\r\n');
          const buf = await s.readUntil('"ok":true', 2000);
          expect(buf.toString('utf8')).toContain('"ok":true');
          await s.readAvailable(20);
          idleSockets.push(s);
        }

        const slowPromises = Array.from({ length: 5 }, () =>
          performHttpRequest({ url: `http://${host}:${port}/slow` })
        );
        const streamPromises = Array.from({ length: 2 }, () =>
          performHttpRequest({ url: `http://${host}:${port}/stream` })
        );

        await delay(30);

        const closeStart = Date.now();
        closeCalled = true;
        const closePromise = Promise.resolve(handle.close());

        const rejectedNewConn = await new Promise<boolean>((resolve) => {
          const sock = net.connect({ host, port });
          const t = setTimeout(() => {
            sock.destroy();
            resolve(true);
          }, 500);
          sock.once('error', () => {
            clearTimeout(t);
            resolve(true);
          });
          sock.once('connect', () => {
            sock.write('GET /ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
            let data = '';
            sock.on('data', (c: Buffer) => {
              data += c.toString('latin1');
            });
            sock.once('close', () => {
              clearTimeout(t);
              resolve(!data.includes('HTTP/1.1 200'));
            });
          });
        });
        expect(rejectedNewConn).toBe(true);

        const slowResults = await Promise.all(slowPromises);
        for (const r of slowResults) {
          expect(r.statusCode).toBe(200);
          expect(JSON.parse(r.body.toString('utf8'))).toEqual({ slow: true });
        }

        const streamResults = await Promise.all(streamPromises);
        for (const r of streamResults) {
          expect(r.statusCode).toBe(200);
          expect(r.body.toString('utf8')).toBe('part1\npart2\n');
        }

        const idleClosed = await Promise.all(idleSockets.map((s) => s.waitForClose(1000)));
        expect(idleClosed).toEqual([true, true, true, true, true]);

        await closePromise;
        const closeElapsed = Date.now() - closeStart;
        expect(closeElapsed).toBeLessThan(1500);
        expect(closeFired).toBe(true);
        expect(handle.listening).toBe(false);
        expect(handle.address()).toBeNull();
      } finally {
        if (!closeCalled) {
          handle.closeAllConnections?.();
          await Promise.resolve(handle.close()).catch(() => {});
        }
      }
    }
  );

  itRxpress(
    'Dual-ecosystem consumer verification (ESM NodeNext + CJS CommonJS, strict tsc + live HTTP/HTTPS execution)',
    () => {
      const { key, cert } = createSelfSignedCert();

      const buildAppSource = (isEsm: boolean): string => `
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import rxpress, {
  Router,
  json,
  serveStatic,
  type ErrorRequestHandler,
} from 'rxpress';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

function requestHttps(url: string, ca: Buffer): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ca, rejectUnauthorized: true }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main(): Promise<void> {
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
      logs.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });

  const app = rxpress();
  app.use(helmet());
  app.use(cors({ origin: 'https://consumer.test' }));
  app.use(morgan(':method :url :status', { stream: logStream }));
  app.use(json());

  const pubDir = join(process.cwd(), 'public');
  app.use('/static', serveStatic(pubDir));

  const api: Router = rxpress.Router();
  api.get('/ping', (req, res) => {
    res.json({ ok: true, mode: ${JSON.stringify(isEsm ? 'esm' : 'cjs')}, secure: req.secure });
  });
  api.post('/ping', (req, res) => {
    res.status(201).json({ echoed: req.body });
  });
  app.use('/api', api);

  const errMw: ErrorRequestHandler = (err, _req, res, _next) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  };
  app.use(errMw);

  const certBuf = readFileSync(join(process.cwd(), 'cert.pem'));
  const keyBuf = readFileSync(join(process.cwd(), 'key.pem'));

  const httpSrv = app.listen(0, '127.0.0.1');
  const httpsSrv = app.listenTls({ cert: certBuf, key: keyBuf }, 0, '127.0.0.1');

  try {
    const httpPort = httpSrv.address()!.port;
    const httpsPort = httpsSrv.address()!.port;

    const httpGet = await fetch(\`http://127.0.0.1:\${httpPort}/api/ping\`, {
      headers: { Origin: 'https://consumer.test' },
    });
    if (httpGet.status !== 200) throw new Error('HTTP GET failed: ' + httpGet.status);
    if (httpGet.headers.get('access-control-allow-origin') !== 'https://consumer.test') {
      throw new Error('HTTP missing CORS header');
    }
    if (httpGet.headers.get('x-content-type-options') !== 'nosniff') {
      throw new Error('HTTP missing Helmet header');
    }
    const httpJson = (await httpGet.json()) as { ok: boolean; secure: boolean };
    if (!httpJson.ok || httpJson.secure !== false) {
      throw new Error('Unexpected HTTP JSON: ' + JSON.stringify(httpJson));
    }

    const httpPost = await fetch(\`http://127.0.0.1:\${httpPort}/api/ping\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    if (httpPost.status !== 201) throw new Error('HTTP POST failed: ' + httpPost.status);

    const staticRes = await fetch(\`http://127.0.0.1:\${httpPort}/static/hello.txt\`);
    if (staticRes.status !== 200 || (await staticRes.text()) !== 'ecosystem-ok') {
      throw new Error('Static fetch failed');
    }

    const httpsGet = await requestHttps(\`https://127.0.0.1:\${httpsPort}/api/ping\`, certBuf);
    if (httpsGet.status !== 200) throw new Error('HTTPS GET failed: ' + httpsGet.status);
    const httpsJson = JSON.parse(httpsGet.body) as { ok: boolean; secure: boolean };
    if (!httpsJson.ok || httpsJson.secure !== true) {
      throw new Error('Unexpected HTTPS JSON: ' + httpsGet.body);
    }

    await new Promise((r) => setTimeout(r, 30));
    const joinedLogs = logs.join('');
    if (!joinedLogs.includes('GET /api/ping 200') || !joinedLogs.includes('POST /api/ping 201')) {
      throw new Error('Morgan did not record requests: ' + joinedLogs);
    }
  } finally {
    await httpSrv.close();
    await httpsSrv.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

      // Project A: ESM (NodeNext)
      const wsEsm = makeWorkspace('rxpress-e2e-esm-');
      setupConsumerPackage(wsEsm, REPO_ROOT, {
        type: 'module',
        linkDeps: ['cors', 'helmet', 'morgan', '@types/cors', '@types/morgan', '@types/node'],
      });
      wsEsm.writeFile('cert.pem', cert);
      wsEsm.writeFile('key.pem', key);
      wsEsm.writeFile('public/hello.txt', 'ecosystem-ok');
      wsEsm.writeFile(
        'tsconfig.json',
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              strict: true,
              esModuleInterop: true,
              skipLibCheck: true,
              rootDir: './src',
              outDir: './out',
            },
            include: ['./src/**/*.ts'],
          },
          null,
          2
        )
      );
      wsEsm.writeFile('src/app.ts', buildAppSource(true));

      const esmCheck = spawnSync(TSC_BIN, ['--noEmit'], {
        cwd: wsEsm.dir,
        encoding: 'utf8',
        timeout: 20000,
      });
      expect(esmCheck.stdout + esmCheck.stderr).toBe('');
      expect(esmCheck.status).toBe(0);

      const esmCompile = spawnSync(TSC_BIN, [], {
        cwd: wsEsm.dir,
        encoding: 'utf8',
        timeout: 20000,
      });
      expect(esmCompile.stdout + esmCompile.stderr).toBe('');
      expect(esmCompile.status).toBe(0);

      const esmRun = spawnSync(process.execPath, [wsEsm.resolve('out/app.js')], {
        cwd: wsEsm.dir,
        encoding: 'utf8',
        timeout: 20000,
      });
      expect(esmRun.stderr).toBe('');
      expect(esmRun.status).toBe(0);

      // Project B: CommonJS
      const wsCjs = makeWorkspace('rxpress-e2e-cjs-');
      setupConsumerPackage(wsCjs, REPO_ROOT, {
        type: 'commonjs',
        linkDeps: ['cors', 'helmet', 'morgan', '@types/cors', '@types/morgan', '@types/node'],
      });
      wsCjs.writeFile('cert.pem', cert);
      wsCjs.writeFile('key.pem', key);
      wsCjs.writeFile('public/hello.txt', 'ecosystem-ok');
      wsCjs.writeFile(
        'tsconfig.json',
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'CommonJS',
              moduleResolution: 'node',
              strict: true,
              esModuleInterop: true,
              skipLibCheck: true,
              rootDir: './src',
              outDir: './out',
            },
            include: ['./src/**/*.ts'],
          },
          null,
          2
        )
      );
      wsCjs.writeFile('src/app.ts', buildAppSource(false));

      const cjsCheck = spawnSync(TSC_BIN, ['--noEmit'], {
        cwd: wsCjs.dir,
        encoding: 'utf8',
        timeout: 20000,
      });
      expect(cjsCheck.stdout + cjsCheck.stderr).toBe('');
      expect(cjsCheck.status).toBe(0);

      const cjsCompile = spawnSync(TSC_BIN, [], {
        cwd: wsCjs.dir,
        encoding: 'utf8',
        timeout: 20000,
      });
      expect(cjsCompile.stdout + cjsCompile.stderr).toBe('');
      expect(cjsCompile.status).toBe(0);

      const cjsRun = spawnSync(process.execPath, [wsCjs.resolve('out/app.js')], {
        cwd: wsCjs.dir,
        encoding: 'utf8',
        timeout: 20000,
      });
      expect(cjsRun.stderr).toBe('');
      expect(cjsRun.status).toBe(0);
    }
  );
});
