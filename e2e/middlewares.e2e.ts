import { basename } from 'node:path';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempWorkspace, type TempWorkspace } from './helpers/fixtures.js';
import { sendRawHttp } from './helpers/raw-http.js';
import {
  createApp,
  isExpressBaseline,
  jsonMiddleware,
  rawMiddleware,
  startServer,
  staticMiddleware,
  textMiddleware,
  urlencodedMiddleware,
  type E2EErrorRequestHandler,
  type E2ERequestHandler,
  type StartedServer,
} from './helpers/server.js';

const servers: StartedServer[] = [];
const workspaces: TempWorkspace[] = [];

function trackServer(srv: StartedServer): StartedServer {
  servers.push(srv);
  return srv;
}

function makeWorkspace(prefix: string): TempWorkspace {
  const ws = createTempWorkspace(prefix);
  workspaces.push(ws);
  return ws;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  let firstError: unknown;
  try {
    while (servers.length > 0) {
      try {
        await servers.pop()?.close();
      } catch (err) {
        firstError ??= err;
      }
    }
  } finally {
    while (workspaces.length > 0) {
      try {
        workspaces.pop()?.cleanup();
      } catch (err) {
        firstError ??= err;
      }
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
});

describe('Built-in (json, urlencoded, text, raw, static) & 3rd-Party (cors, helmet, morgan) Middlewares', () => {
  it(
    'jsonMiddleware parses application/json and application/*+json with reviver and verify buffer hook',
    async () => {
      const app = createApp();
      const reviver = (_key: string, value: unknown): unknown =>
        _key === 'count' && typeof value === 'number' ? value * 2 : value;
      const verify = (req: { [key: string]: unknown }, _res: unknown, buf: Buffer): void => {
        req.verifiedIsBuffer = Buffer.isBuffer(buf);
        req.verifiedRaw = buf.toString('utf8');
      };

      app.use('/default', jsonMiddleware({ reviver, verify }));
      app.post('/default', (req, res) => {
        res.json({
          body: req.body,
          verifiedIsBuffer: req.verifiedIsBuffer,
          verifiedRaw: req.verifiedRaw,
        });
      });

      app.use(
        '/problem',
        jsonMiddleware({
          type: ['application/json', 'application/*+json'],
          reviver,
          verify,
        })
      );
      app.post('/problem', (req, res) => {
        res.json({
          body: req.body,
          verifiedIsBuffer: req.verifiedIsBuffer,
          verifiedRaw: req.verifiedRaw,
        });
      });

      const srv = trackServer(await startServer(app));
      const payload = '{"name":"rx","count":3}';

      const r1 = await fetch(`${srv.baseUrl}/default`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      expect(r1.status).toBe(200);
      expect(await r1.json()).toEqual({
        body: { name: 'rx', count: 6 },
        verifiedIsBuffer: true,
        verifiedRaw: payload,
      });

      const r2 = await fetch(`${srv.baseUrl}/problem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/problem+json' },
        body: payload,
      });
      expect(r2.status).toBe(200);
      expect(await r2.json()).toEqual({
        body: { name: 'rx', count: 6 },
        verifiedIsBuffer: true,
        verifiedRaw: payload,
      });
    }
  );

  it(
    'urlencodedMiddleware handles extended: true nested objects and extended: false flat keys',
    async () => {
      const app = createApp();
      app.use('/ext', urlencodedMiddleware({ extended: true }));
      app.post('/ext', (req, res) => {
        res.json(req.body);
      });

      app.use('/simple', urlencodedMiddleware({ extended: false }));
      app.post('/simple', (req, res) => {
        res.json(req.body);
      });

      const srv = trackServer(await startServer(app));
      const formBody = 'a=hello+world&u[name]=bob';

      const extRes = await fetch(`${srv.baseUrl}/ext`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody,
      });
      expect(extRes.status).toBe(200);
      expect(await extRes.json()).toEqual({
        a: 'hello world',
        u: { name: 'bob' },
      });

      const simpleRes = await fetch(`${srv.baseUrl}/simple`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody,
      });
      expect(simpleRes.status).toBe(200);
      expect(await simpleRes.json()).toEqual({
        a: 'hello world',
        'u[name]': 'bob',
      });
    }
  );

  it(
    'textMiddleware parses text/plain string and rawMiddleware preserves binary Buffer',
    async () => {
      const app = createApp();
      app.use('/t', textMiddleware());
      app.post('/t', (req, res) => {
        res.json({ type: typeof req.body, body: req.body });
      });

      app.use('/b', rawMiddleware());
      app.post('/b', (req, res) => {
        const isBuf = Buffer.isBuffer(req.body);
        res.json({
          isBuffer: isBuf,
          hex: isBuf ? (req.body as Buffer).toString('hex') : null,
        });
      });

      const srv = trackServer(await startServer(app));

      const textRes = await fetch(`${srv.baseUrl}/t`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'hello plain',
      });
      expect(textRes.status).toBe(200);
      expect(await textRes.json()).toEqual({
        type: 'string',
        body: 'hello plain',
      });

      const rawBytes = new Uint8Array([0x00, 0xff, 0x42]);
      const rawRes = await fetch(`${srv.baseUrl}/b`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: rawBytes,
      });
      expect(rawRes.status).toBe(200);
      expect(await rawRes.json()).toEqual({
        isBuffer: true,
        hex: '00ff42',
      });
    }
  );

  it(
    'staticMiddleware honors index, extensions, maxAge, immutable, etag, lastModified, and setHeaders',
    async () => {
      const ws = makeWorkspace('rxpress-fg03-t1-04-');
      ws.writeFile('index.html', '<h1>Index</h1>');
      ws.writeFile('page.html', '<p>Page</p>');
      ws.writeFile('app.js', 'console.log(1);');

      const app = createApp();
      app.use(
        staticMiddleware(ws.dir, {
          index: ['index.html'],
          extensions: ['html'],
          maxAge: '1d',
          immutable: true,
          etag: true,
          lastModified: true,
          setHeaders: (res, filePath) => {
            res.setHeader('X-Served-File', basename(filePath));
          },
        })
      );

      const srv = trackServer(await startServer(app));

      const rIndex = await fetch(`${srv.baseUrl}/`);
      expect(rIndex.status).toBe(200);
      expect(await rIndex.text()).toBe('<h1>Index</h1>');
      expect(rIndex.headers.get('x-served-file')).toBe('index.html');

      const rPage = await fetch(`${srv.baseUrl}/page`);
      expect(rPage.status).toBe(200);
      expect(await rPage.text()).toBe('<p>Page</p>');
      expect(rPage.headers.get('x-served-file')).toBe('page.html');

      const rJs = await fetch(`${srv.baseUrl}/app.js`);
      expect(rJs.status).toBe(200);
      expect(await rJs.text()).toBe('console.log(1);');
      expect(rJs.headers.get('etag')).toBeTruthy();
      expect(rJs.headers.get('last-modified')).toBeTruthy();
      const cacheControl = rJs.headers.get('cache-control') ?? '';
      expect(cacheControl).toContain('max-age=86400');
      expect(cacheControl).toContain('immutable');
      expect(rJs.headers.get('x-served-file')).toBe('app.js');
    }
  );

  it(
    'cors 3rd-party middleware handles OPTIONS preflight and GET with Origin and credentials',
    async () => {
      const app = createApp();
      app.use(
        cors({
          origin: 'https://app.test',
          credentials: true,
          methods: ['GET', 'POST'],
        }) as unknown as E2ERequestHandler
      );
      app.get('/cors', (_req, res) => {
        res.json({ ok: true });
      });

      const srv = trackServer(await startServer(app));

      const preflight = await fetch(`${srv.baseUrl}/cors`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.test',
          'Access-Control-Request-Method': 'POST',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.test');
      expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
      expect(preflight.headers.get('vary')).toContain('Origin');

      const simple = await fetch(`${srv.baseUrl}/cors`, {
        headers: { Origin: 'https://app.test' },
      });
      expect(simple.status).toBe(200);
      expect(await simple.json()).toEqual({ ok: true });
      expect(simple.headers.get('access-control-allow-origin')).toBe('https://app.test');
      expect(simple.headers.get('access-control-allow-credentials')).toBe('true');
    }
  );

  it(
    'helmet 3rd-party middleware sets security headers and removes X-Powered-By',
    async () => {
      const app = createApp();
      app.use(helmet() as unknown as E2ERequestHandler);
      app.get('/secure-headers', (_req, res) => {
        res.json({ ok: true });
      });

      const srv = trackServer(await startServer(app));
      const res = await fetch(`${srv.baseUrl}/secure-headers`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(res.headers.get('content-security-policy')).toBeTruthy();
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      expect(res.headers.get('strict-transport-security')).toBeTruthy();
      expect(res.headers.get('x-powered-by')).toBeNull();
    }
  );

  it(
    'morgan 3rd-party middleware writes formatted combined and tiny request logs after response finish',
    async () => {
      const combinedLogs: string[] = [];
      const tinyLogs: string[] = [];

      const app = createApp();
      app.use(
        morgan('combined', {
          stream: {
            write: (line: string) => {
              combinedLogs.push(line.trim());
            },
          },
        }) as unknown as E2ERequestHandler
      );
      app.use(
        morgan('tiny', {
          stream: {
            write: (line: string) => {
              tinyLogs.push(line.trim());
            },
          },
        }) as unknown as E2ERequestHandler
      );
      app.get('/log', (_req, res) => {
        res.status(200).send('hello-log');
      });

      const srv = trackServer(await startServer(app));
      const res = await fetch(`${srv.baseUrl}/log?x=1`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hello-log');

      await waitForCondition(() => combinedLogs.length >= 1 && tinyLogs.length >= 1, 500);

      expect(combinedLogs.length).toBe(1);
      expect(combinedLogs[0]).toContain('GET /log?x=1');
      expect(combinedLogs[0]).toContain(' 200 9 ');

      expect(tinyLogs.length).toBe(1);
      expect(tinyLogs[0]).toMatch(/^GET \/log\?x=1 200 9 - \d+(\.\d+)? ms$/);
    }
  );

  it(
    'jsonMiddleware enforces exact byte limit boundary (16 OK, 17 -> 413 without invoking handler)',
    async () => {
      let handlerHits = 0;
      const app = createApp();
      app.use('/limit', jsonMiddleware({ limit: 16 }));
      app.post('/limit', (req, res) => {
        handlerHits++;
        res.json({ body: req.body });
      });

      const srv = trackServer(await startServer(app));

      const okPayload = '{"a":"12345678"}';
      expect(Buffer.byteLength(okPayload)).toBe(16);
      const rOk = await fetch(`${srv.baseUrl}/limit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: okPayload,
      });
      expect(rOk.status).toBe(200);
      expect(handlerHits).toBe(1);

      const overPayload = '{"a":"123456789"}';
      expect(Buffer.byteLength(overPayload)).toBe(17);
      const rOver = await fetch(`${srv.baseUrl}/limit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: overPayload,
      });
      expect(rOver.status).toBe(413);
      expect(handlerHits).toBe(1);
    }
  );

  it(
    'jsonMiddleware rejects malformed JSON and respects strict: true vs strict: false',
    async () => {
      const app = createApp();
      app.use('/strict', jsonMiddleware());
      app.post('/strict', (req, res) => {
        res.json({ body: req.body });
      });

      app.use('/nonstrict', jsonMiddleware({ strict: false }));
      app.post('/nonstrict', (req, res) => {
        res.json({ body: req.body });
      });

      const errHandler: E2EErrorRequestHandler = (err, _req, res, _next) => {
        const e = err as { status?: number; statusCode?: number; message?: string };
        res.status(e.status ?? e.statusCode ?? 500).json({ error: e.message ?? 'bad json' });
      };
      app.use(errHandler);

      const srv = trackServer(await startServer(app));

      const badRes = await fetch(`${srv.baseUrl}/strict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad',
      });
      expect(badRes.status).toBe(400);

      const strictPrim = await fetch(`${srv.baseUrl}/strict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '"hello"',
      });
      expect(strictPrim.status).toBe(400);

      const nonStrictPrim = await fetch(`${srv.baseUrl}/nonstrict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '"hello"',
      });
      expect(nonStrictPrim.status).toBe(200);
      expect(await nonStrictPrim.json()).toEqual({ body: 'hello' });
    }
  );

  it(
    'jsonMiddleware verify hook throwing 401 aborts parsing and skips route handler',
    async () => {
      let hits = 0;
      const app = createApp();
      app.use(
        '/verify',
        jsonMiddleware({
          verify: () => {
            throw Object.assign(new Error('bad sig'), { status: 401 });
          },
        })
      );
      app.post('/verify', (_req, res) => {
        hits++;
        res.json({ ok: true });
      });

      const errHandler: E2EErrorRequestHandler = (err, _req, res, _next) => {
        const e = err as { status?: number; statusCode?: number; message?: string };
        res.status(e.status ?? e.statusCode ?? 500).json({ error: e.message ?? 'error' });
      };
      app.use(errHandler);

      const srv = trackServer(await startServer(app));
      const res = await fetch(`${srv.baseUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"ok":true}',
      });
      expect(res.status).toBe(401);
      expect(hits).toBe(0);
    }
  );

  it(
    'staticMiddleware blocks path traversal and encoded dot-segments (and symlinks escaping root on rxpress)',
    async () => {
      const ws = makeWorkspace('rxpress-fg03-t2-04-');
      const outsideSecret = ws.writeFile('outside/secret.txt', 'TOP_SECRET');
      const pubDir = ws.mkdir('pub');
      ws.writeFile('pub/ok.txt', 'PUBLIC');
      ws.writeSymlink('pub/evil-link.txt', outsideSecret);

      const app = createApp();
      app.use('/fall', staticMiddleware(pubDir, { fallthrough: true }));
      app.use('/strict', staticMiddleware(pubDir, { fallthrough: false }));

      const srv = trackServer(await startServer(app));

      const okRes = await fetch(`${srv.baseUrl}/fall/ok.txt`);
      expect(okRes.status).toBe(200);
      expect(await okRes.text()).toBe('PUBLIC');

      const traversalPaths = [
        '/fall/../outside/secret.txt',
        '/strict/../outside/secret.txt',
        '/strict/%2e%2e/outside/secret.txt',
        '/strict/..%2foutside%2fsecret.txt',
        '/fall/%2e%2e/outside/secret.txt',
      ];

      for (const reqPath of traversalPaths) {
        const rawRes = await sendRawHttp(
          srv.host,
          srv.port,
          `GET ${reqPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`
        );
        expect([400, 403, 404]).toContain(rawRes.statusCode);
        expect(rawRes.body.toString('utf8')).not.toContain('TOP_SECRET');
      }

      if (!isExpressBaseline()) {
        for (const symPath of ['/strict/evil-link.txt', '/fall/evil-link.txt']) {
          const symRes = await fetch(`${srv.baseUrl}${symPath}`);
          expect([403, 404]).toContain(symRes.status);
          expect(await symRes.text()).not.toContain('TOP_SECRET');
        }
      }
    }
  );

  it(
    'staticMiddleware dotfiles ignore (404), deny (403), allow (200) for dotfiles and dot-directories',
    async () => {
      const ws = makeWorkspace('rxpress-fg03-t2-05-');
      ws.writeFile('.env', 'SECRET_ENV=1');
      ws.writeFile('.git/config', '[core]\n');

      const app = createApp();
      app.use('/ign', staticMiddleware(ws.dir, { dotfiles: 'ignore' }));
      app.use('/den', staticMiddleware(ws.dir, { dotfiles: 'deny', fallthrough: false }));
      app.use('/all', staticMiddleware(ws.dir, { dotfiles: 'allow' }));

      const srv = trackServer(await startServer(app));

      for (const target of ['/.env', '/.git/config']) {
        const rIgn = await fetch(`${srv.baseUrl}/ign${target}`);
        expect(rIgn.status).toBe(404);

        const rDen = await fetch(`${srv.baseUrl}/den${target}`);
        expect(rDen.status).toBe(403);
      }

      const rAllEnv = await fetch(`${srv.baseUrl}/all/.env`);
      expect(rAllEnv.status).toBe(200);
      expect(await rAllEnv.text()).toBe('SECRET_ENV=1');

      const rAllGit = await fetch(`${srv.baseUrl}/all/.git/config`);
      expect(rAllGit.status).toBe(200);
      expect(await rAllGit.text()).toBe('[core]\n');
    }
  );

  it(
    'staticMiddleware handles directory redirect: true vs false and POST 405 when fallthrough: false',
    async () => {
      const ws = makeWorkspace('rxpress-fg03-t2-06-');
      ws.writeFile('subdir/index.html', 'sub-index');
      ws.writeFile('file.txt', 'hello');

      const app = createApp();
      app.use('/redir', staticMiddleware(ws.dir, { redirect: true }));
      app.use('/noredir', staticMiddleware(ws.dir, { redirect: false }));
      app.use('/nofall', staticMiddleware(ws.dir, { fallthrough: false }));

      const srv = trackServer(await startServer(app));

      const rRedir = await fetch(`${srv.baseUrl}/redir/subdir`, { redirect: 'manual' });
      expect(rRedir.status).toBe(301);
      expect(rRedir.headers.get('location')).toBe('/redir/subdir/');

      const rNoRedir = await fetch(`${srv.baseUrl}/noredir/subdir`);
      expect(rNoRedir.status).toBe(404);

      const rPost = await fetch(`${srv.baseUrl}/nofall/file.txt`, { method: 'POST' });
      expect(rPost.status).toBe(405);
      const allow = rPost.headers.get('allow') ?? '';
      expect(allow).toContain('GET');
      expect(allow).toContain('HEAD');
    }
  );

  it(
    'staticMiddleware mounted after JS middleware runs middleware and omits ETag and Last-Modified when disabled',
    async () => {
      const ws = makeWorkspace('rxpress-fg03-t2-07-');
      ws.writeFile('hello.txt', 'hello-static');

      let hits = 0;
      const app = createApp();
      app.use((_req, res, next) => {
        hits++;
        res.setHeader('X-Logged', 'yes');
        next();
      });
      app.use('/pub', staticMiddleware(ws.dir, { etag: false, lastModified: false }));

      const srv = trackServer(await startServer(app));
      const res = await fetch(`${srv.baseUrl}/pub/hello.txt`);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hello-static');
      expect(res.headers.get('x-logged')).toBe('yes');
      expect(hits).toBe(1);
      expect(res.headers.get('etag')).toBeNull();
      expect(res.headers.get('last-modified')).toBeNull();
    }
  );
});
