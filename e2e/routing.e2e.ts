import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTempWorkspace,
  setupConsumerPackage,
  type TempWorkspace,
} from './helpers/fixtures.js';
import {
  createApp,
  createRouter,
  getE2ETarget,
  isExpressBaseline,
  startServer,
  type E2EErrorRequestHandler,
  type E2ENextFunction,
  type E2ERequest,
  type E2ERequestHandler,
  type E2EResponse,
  type StartedServer,
} from './helpers/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const servers: StartedServer[] = [];
const workspaces: TempWorkspace[] = [];
const childProcesses: ChildProcess[] = [];

async function trackServer(srv: StartedServer): Promise<StartedServer> {
  servers.push(srv);
  return srv;
}

function trackWorkspace(prefix: string): TempWorkspace {
  const ws = createTempWorkspace(prefix);
  workspaces.push(ws);
  return ws;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
}

function httpRequest(
  baseUrl: string,
  path: string,
  opts?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    timeoutMs?: number;
  }
): Promise<HttpResult> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path,
        method: opts?.method ?? 'GET',
        headers: opts?.headers,
        timeout: opts?.timeoutMs ?? 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            text: body.toString('utf8'),
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`httpRequest timed out for ${opts?.method ?? 'GET'} ${path}`));
    });
    req.on('error', reject);
    if (opts?.body !== undefined) {
      req.write(opts.body);
    }
    req.end();
  });
}

interface PartialStreamResult {
  status: number;
  text: string;
  streamError?: Error;
}

function readPartialHttpStream(
  baseUrl: string,
  path: string,
  timeoutMs = 3000
): Promise<PartialStreamResult> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let status = 0;
    let streamError: Error | undefined;
    const chunks: Buffer[] = [];

    const finish = () => {
      if (settled || timedOut) return;
      settled = true;
      resolve({
        status,
        text: Buffer.concat(chunks).toString('utf8'),
        streamError,
      });
    };

    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        status = res.statusCode ?? 0;
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', (err: Error) => {
          if (settled || timedOut) return;
          streamError = err;
          finish();
        });
        res.on('end', finish);
        res.on('close', () => {
          if (settled || timedOut) return;
          finish();
        });
      }
    );

    req.on('timeout', () => {
      if (settled || timedOut) return;
      const timeoutErr = new Error(`readPartialHttpStream timed out for GET ${path}`);
      timedOut = true;
      settled = true;
      reject(timeoutErr);
      req.destroy(timeoutErr);
    });
    req.on('error', (err: Error) => {
      if (settled || timedOut) return;
      if (status > 0) {
        streamError = err;
        setImmediate(finish);
      } else {
        settled = true;
        reject(err);
      }
    });
    req.end();
  });
}

afterEach(async () => {
  while (childProcesses.length > 0) {
    const child = childProcesses.pop();
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore cleanup failure
      }
    }
  }
  while (servers.length > 0) {
    const srv = servers.pop();
    if (srv) {
      try {
        srv.closeAllConnections();
      } catch {
        // ignore cleanup failure
      }
      try {
        await srv.close();
      } catch {
        // ignore cleanup failure
      }
    }
  }
  while (workspaces.length > 0) {
    const ws = workspaces.pop();
    if (ws) {
      try {
        ws.cleanup();
      } catch {
        // ignore cleanup failure
      }
    }
  }
});

describe('Express 4/5 Routing, Params, Control Flow & Async Errors', () => {
  it('supports HTTP verbs, app.route() chaining, app.all(), and HEAD suppression', async () => {
    const app = createApp();

    app
      .route('/item')
      .get((_req: E2ERequest, res: E2EResponse) => res.json({ verb: 'GET' }))
      .post((_req: E2ERequest, res: E2EResponse) => res.json({ verb: 'POST' }))
      .put((_req: E2ERequest, res: E2EResponse) => res.json({ verb: 'PUT' }))
      .delete((_req: E2ERequest, res: E2EResponse) => res.json({ verb: 'DELETE' }))
      .patch((_req: E2ERequest, res: E2EResponse) => res.json({ verb: 'PATCH' }));

    app.options('/opts', (_req: E2ERequest, res: E2EResponse) => {
      res.status(200).send('options-ok');
    });

    app.all('/any', (req: E2ERequest, res: E2EResponse) => {
      res.json({ verb: 'ALL', method: req.method });
    });

    const srv = await trackServer(await startServer(app));

    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      const res = await httpRequest(srv.baseUrl, '/item', { method });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toEqual({ verb: method });
    }

    const headRes = await httpRequest(srv.baseUrl, '/item', { method: 'HEAD' });
    expect(headRes.status).toBe(200);
    expect(Number(headRes.headers['content-length'])).toBeGreaterThan(0);
    expect(headRes.body.length).toBe(0);

    const optRes = await httpRequest(srv.baseUrl, '/opts', { method: 'OPTIONS' });
    expect(optRes.status).toBe(200);
    expect(optRes.text).toBe('options-ok');

    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const anyRes = await httpRequest(srv.baseUrl, '/any', { method });
      expect(anyRes.status).toBe(200);
      expect(JSON.parse(anyRes.text)).toEqual({ verb: 'ALL', method });
    }
  });

  it('decodes route params, multi-param segments, and Express 5 optional {/:opt}', async () => {
    const app = createApp();

    app.get('/users/:id/posts/:postId', (req: E2ERequest, res: E2EResponse) => {
      res.json({ params: req.params });
    });

    app.get('/flights/:from-:to', (req: E2ERequest, res: E2EResponse) => {
      res.json({ params: req.params });
    });

    app.get('/opt{/:opt}', (req: E2ERequest, res: E2EResponse) => {
      res.json({ params: req.params });
    });

    const srv = await trackServer(await startServer(app));

    const userRes = await fetch(`${srv.baseUrl}/users/42/posts/abc%20def`);
    expect(userRes.status).toBe(200);
    expect(await userRes.json()).toEqual({
      params: { id: '42', postId: 'abc def' },
    });

    const flightRes = await fetch(`${srv.baseUrl}/flights/LAX-SFO`);
    expect(flightRes.status).toBe(200);
    expect(await flightRes.json()).toEqual({
      params: { from: 'LAX', to: 'SFO' },
    });

    const optEmpty = await fetch(`${srv.baseUrl}/opt`);
    expect(optEmpty.status).toBe(200);
    expect(await optEmpty.json()).toEqual({ params: {} });

    const optSet = await fetch(`${srv.baseUrl}/opt/1`);
    expect(optSet.status).toBe(200);
    expect(await optSet.json()).toEqual({ params: { opt: '1' } });
  });

  it('matches Express 5 *splat wildcards and RegExp capture routes', async () => {
    const app = createApp();

    app.get('/files/*splat', (req: E2ERequest, res: E2EResponse) => {
      res.json({ params: req.params });
    });

    app.get(/^\/commits\/(\w+)$/, (req: E2ERequest, res: E2EResponse) => {
      res.json({ params: req.params });
    });

    const srv = await trackServer(await startServer(app));

    const splatRes = await fetch(`${srv.baseUrl}/files/a/b/c.js`);
    expect(splatRes.status).toBe(200);
    const splatJson = (await splatRes.json()) as { params: Record<string, unknown> };
    const splat = splatJson.params.splat;
    if (isExpressBaseline()) {
      expect(splat).toEqual(['a', 'b', 'c.js']);
    } else {
      expect(Array.isArray(splat) ? splat.join('/') : splat).toBe('a/b/c.js');
    }

    const commitRes = await fetch(`${srv.baseUrl}/commits/deadbeef`);
    expect(commitRes.status).toBe(200);
    const commitJson = (await commitRes.json()) as { params: Record<string, unknown> };
    expect(commitJson.params['0']).toBe('deadbeef');

    const badCommitRes = await fetch(`${srv.baseUrl}/commits/dead-beef`);
    expect(badCommitRes.status).toBe(404);

    const emptyCommitRes = await fetch(`${srv.baseUrl}/commits/`);
    expect(emptyCommitRes.status).toBe(404);

    const otherPathRes = await fetch(`${srv.baseUrl}/other/a/b/c.js`);
    expect(otherPathRes.status).toBe(404);
  });

  it('supports sub-Router mergeParams, single router.param(), and app.param(array)', async () => {
    const app = createApp();
    const orgRouter = createRouter({ mergeParams: true });
    const isolatedRouter = createRouter();
    const paramCalls: Array<{ name: string; value: string }> = [];

    orgRouter.param('userId', (req: E2ERequest, _res: E2EResponse, next: E2ENextFunction, value: string, name: string) => {
      paramCalls.push({ name, value });
      req.paramUser = value;
      next();
    });

    orgRouter.use('/users/:userId', (req: E2ERequest, _res: E2EResponse, next: E2ENextFunction) => {
      req.sawFirstLayer = true;
      next();
    });

    orgRouter.get('/users/:userId', (req: E2ERequest, res: E2EResponse) => {
      res.json({
        params: req.params,
        baseUrl: req.baseUrl,
        paramUser: req.paramUser,
        sawFirstLayer: req.sawFirstLayer,
      });
    });

    app.use('/orgs/:orgId', orgRouter);

    isolatedRouter.get('/items/:itemId', (req: E2ERequest, res: E2EResponse) => {
      res.json({
        params: req.params,
        hasOrgId: Object.prototype.hasOwnProperty.call(req.params, 'orgId'),
      });
    });
    app.use('/isolated/:orgId', isolatedRouter);

    app.param(['tagA', 'tagB'], (_req: E2ERequest, _res: E2EResponse, next: E2ENextFunction, value: string, name: string) => {
      paramCalls.push({ name, value });
      next();
    });

    app.get('/tags/:tagA/:tagB', (req: E2ERequest, res: E2EResponse) => {
      res.json({ params: req.params });
    });

    const srv = await trackServer(await startServer(app));

    const orgRes = await fetch(`${srv.baseUrl}/orgs/acme/users/7`);
    expect(orgRes.status).toBe(200);
    expect(await orgRes.json()).toEqual({
      params: { orgId: 'acme', userId: '7' },
      baseUrl: '/orgs/acme',
      paramUser: '7',
      sawFirstLayer: true,
    });
    expect(paramCalls.filter((c) => c.name === 'userId')).toEqual([
      { name: 'userId', value: '7' },
    ]);

    const orgRes2 = await fetch(`${srv.baseUrl}/orgs/acme/users/8`);
    expect(orgRes2.status).toBe(200);
    expect(await orgRes2.json()).toEqual({
      params: { orgId: 'acme', userId: '8' },
      baseUrl: '/orgs/acme',
      paramUser: '8',
      sawFirstLayer: true,
    });
    expect(paramCalls.filter((c) => c.name === 'userId')).toEqual([
      { name: 'userId', value: '7' },
      { name: 'userId', value: '8' },
    ]);

    const isolatedRes = await fetch(`${srv.baseUrl}/isolated/acme/items/99`);
    expect(isolatedRes.status).toBe(200);
    expect(await isolatedRes.json()).toEqual({
      params: { itemId: '99' },
      hasOrgId: false,
    });

    const tagRes = await fetch(`${srv.baseUrl}/tags/alpha/beta`);
    expect(tagRes.status).toBe(200);
    expect(await tagRes.json()).toEqual({
      params: { tagA: 'alpha', tagB: 'beta' },
    });
    expect(paramCalls.filter((c) => c.name === 'tagA')).toEqual([
      { name: 'tagA', value: 'alpha' },
    ]);
    expect(paramCalls.filter((c) => c.name === 'tagB')).toEqual([
      { name: 'tagB', value: 'beta' },
    ]);
  });

  it("handles next('route') and next('router') control flow", async () => {
    const app = createApp();

    const skipRouteHandler: E2ERequestHandler = (_req, _res, next) => {
      next('route');
    };
    const unreachableRouteHandler: E2ERequestHandler = (_req, res) => {
      res.status(500).send('should-not-run-route');
    };

    app.get('/skip-route', skipRouteHandler, unreachableRouteHandler);
    app.get('/skip-route', (_req: E2ERequest, res: E2EResponse) => {
      res.json({ hit: 'second-route' });
    });

    const sub = createRouter();
    sub.use((_req: E2ERequest, _res: E2EResponse, next: E2ENextFunction) => {
      next('router');
    });
    sub.get('/bail', (_req: E2ERequest, res: E2EResponse) => {
      res.status(500).send('should-not-run-subrouter');
    });

    app.use('/sub', sub);
    app.get('/sub/bail', (_req: E2ERequest, res: E2EResponse) => {
      res.json({ hit: 'parent-fallback' });
    });

    const srv = await trackServer(await startServer(app));

    const skipRes = await fetch(`${srv.baseUrl}/skip-route`);
    expect(skipRes.status).toBe(200);
    expect(await skipRes.json()).toEqual({ hit: 'second-route' });

    const bailRes = await fetch(`${srv.baseUrl}/sub/bail`);
    expect(bailRes.status).toBe(200);
    expect(await bailRes.json()).toEqual({ hit: 'parent-fallback' });
  });

  it('supports async middleware, single-handler async next(), and async rejection error forwarding', async () => {
    const app = createApp();

    // Register unique single-handler routes before path-scoped app.use() layers
    // so both direct fast-path and router-fallback async next() are exercised.
    app.get('/single-async-next', async (req: E2ERequest, _res: E2EResponse, next: E2ENextFunction) => {
      await delay(5);
      req.asyncTag = 'ok';
      next();
    });

    app.get('/single-async-next-err', async (_req: E2ERequest, _res: E2EResponse, next: E2ENextFunction) => {
      await delay(5);
      next(new Error('async-next-boom'));
    });

    app.get('/boom', async () => {
      await delay(5);
      const err = Object.assign(new Error('async fail'), { status: 422 });
      throw err;
    });

    app.use('/single-async-next', (req: E2ERequest, res: E2EResponse) => {
      res.json({ tag: req.asyncTag });
    });

    app.use('/mw-chain', async (req: E2ERequest, _res: E2EResponse, next: E2ENextFunction) => {
      await delay(5);
      req.asyncMwRan = true;
      next();
    });
    app.get('/mw-chain', (req: E2ERequest, res: E2EResponse) => {
      res.json({ asyncMwRan: Boolean(req.asyncMwRan) });
    });

    app.get('/async-next', async (req: E2ERequest, _res: E2EResponse, next: E2ENextFunction) => {
      await delay(5);
      req.asyncRouteNextRan = true;
      next();
    });
    app.get('/async-next', (req: E2ERequest, res: E2EResponse) => {
      res.json({ asyncRouteNextRan: Boolean(req.asyncRouteNextRan) });
    });

    const errHandler: E2EErrorRequestHandler = (err, _req, res, _next) => {
      const typedErr = err as Error & { status?: number };
      res.status(typedErr.status ?? 500).json({ error: typedErr.message });
    };
    app.use(errHandler);

    const srv = await trackServer(await startServer(app));

    const mwRes = await fetch(`${srv.baseUrl}/mw-chain`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(mwRes.status).toBe(200);
    expect(await mwRes.json()).toEqual({ asyncMwRan: true });

    const asyncNextRes = await fetch(`${srv.baseUrl}/async-next`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(asyncNextRes.status).toBe(200);
    expect(await asyncNextRes.json()).toEqual({ asyncRouteNextRan: true });

    const singleAsyncNextRes = await fetch(`${srv.baseUrl}/single-async-next`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(singleAsyncNextRes.status).toBe(200);
    expect(await singleAsyncNextRes.json()).toEqual({ tag: 'ok' });

    const singleAsyncNextErrRes = await fetch(`${srv.baseUrl}/single-async-next-err`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(singleAsyncNextErrRes.status).toBe(500);
    expect(await singleAsyncNextErrRes.json()).toEqual({ error: 'async-next-boom' });

    const boomRes = await fetch(`${srv.baseUrl}/boom`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(boomRes.status).toBe(422);
    expect(await boomRes.json()).toEqual({ error: 'async fail' });
  });

  it('returns auto OPTIONS Allow header, HEAD fallback from GET, and default 404', async () => {
    const app = createApp();

    app.get('/res', (_req: E2ERequest, res: E2EResponse) => {
      res.send('resource-body');
    });
    app.post('/res', (_req: E2ERequest, res: E2EResponse) => {
      res.status(201).send('created');
    });

    const srv = await trackServer(await startServer(app));

    const optRes = await httpRequest(srv.baseUrl, '/res', { method: 'OPTIONS' });
    expect(optRes.status).toBe(200);
    const allow = String(optRes.headers.allow ?? '');
    const methods = allow.split(',').map((m) => m.trim().toUpperCase());
    expect(methods).toContain('GET');
    expect(methods).toContain('HEAD');
    expect(methods).toContain('POST');

    const headRes = await httpRequest(srv.baseUrl, '/res', { method: 'HEAD' });
    expect(headRes.status).toBe(200);
    expect(Number(headRes.headers['content-length'])).toBe(Buffer.byteLength('resource-body'));
    expect(headRes.body.length).toBe(0);

    const missingRes = await httpRequest(srv.baseUrl, '/missing', { method: 'GET' });
    expect(missingRes.status).toBe(404);
    expect(missingRes.text).toContain('Cannot GET /missing');
  });

  it('suppresses stack traces in default final error handler under NODE_ENV=production', async () => {
    const ws = trackWorkspace('rxpress-fg01-t2-01-');
    const target = getE2ETarget();
    setupConsumerPackage(ws, REPO_ROOT, {
      type: 'module',
      linkDeps: isExpressBaseline() ? ['express'] : [],
    });

    const appScript = ws.writeFile(
      'app.mjs',
      `const pkg = ${JSON.stringify(target)};
const { default: createTargetApp } = await import(pkg);
const app = createTargetApp();
app.get('/secret-crash', () => {
  throw new Error('SECRET_DB_PWD');
});
const srv = app.listen(0, '127.0.0.1', () => {
  const addr = srv.address();
  process.stdout.write(JSON.stringify({ port: addr.port }) + '\\n');
});
process.on('SIGTERM', () => {
  Promise.resolve(srv.close()).finally(() => process.exit(0));
});
`
    );

    const child = spawn(process.execPath, [appScript], {
      cwd: ws.dir,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    childProcesses.push(child);

    try {
      const port = await new Promise<number>((resolve, reject) => {
        let out = '';
        let errOut = '';
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for child server port. stdout=${out} stderr=${errOut}`));
        }, 10000);

        child.stdout?.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8');
          const nl = out.indexOf('\n');
          if (nl !== -1) {
            clearTimeout(timer);
            try {
              const parsed = JSON.parse(out.slice(0, nl)) as { port: number };
              resolve(parsed.port);
            } catch (err) {
              reject(err);
            }
          }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          errOut += chunk.toString('utf8');
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Child exited early with code ${code}. stderr=${errOut}`));
        });
      });

      const res = await fetch(`http://127.0.0.1:${port}/secret-crash`, {
        signal: AbortSignal.timeout(3000),
      });
      const body = await res.text();
      expect(res.status).toBe(500);
      expect(body).toContain('Internal Server Error');
      expect(body).not.toContain('SECRET_DB_PWD');
      expect(body).not.toMatch(/\bat\s+/);
      expect(body).not.toContain('app.mjs');
    } finally {
      child.kill('SIGTERM');
    }
  });

  it('enforces registration-order precedence across static, param, and middleware layers', async () => {
    const app = createApp();

    const markMiddleware: E2ERequestHandler = (req, _res, next) => {
      req.mwRan = true;
      next();
    };

    app.get('/before', (req: E2ERequest, res: E2EResponse) => {
      res.json({ mwRan: Boolean(req.mwRan) });
    });

    app.get('/users/me', (_req: E2ERequest, res: E2EResponse) => {
      res.json({ matched: 'me' });
    });
    app.get('/users/:id', (req: E2ERequest, res: E2EResponse) => {
      res.json({ matched: 'param', id: req.params.id });
    });

    app.use(markMiddleware);

    app.get('/after', (req: E2ERequest, res: E2EResponse) => {
      res.json({ mwRan: Boolean(req.mwRan) });
    });

    app.get('/items/:id', (req: E2ERequest, res: E2EResponse) => {
      res.json({ matched: 'param-first', id: req.params.id });
    });
    app.get('/items/special', (_req: E2ERequest, res: E2EResponse) => {
      res.json({ matched: 'static-second' });
    });

    const srv = await trackServer(await startServer(app));

    const beforeRes = await fetch(`${srv.baseUrl}/before`);
    expect(beforeRes.status).toBe(200);
    expect(await beforeRes.json()).toEqual({ mwRan: false });

    const afterRes = await fetch(`${srv.baseUrl}/after`);
    expect(afterRes.status).toBe(200);
    expect(await afterRes.json()).toEqual({ mwRan: true });

    const meRes = await fetch(`${srv.baseUrl}/users/me`);
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toEqual({ matched: 'me' });

    const paramRes = await fetch(`${srv.baseUrl}/users/99`);
    expect(paramRes.status).toBe(200);
    expect(await paramRes.json()).toEqual({ matched: 'param', id: '99' });

    const itemsRes = await fetch(`${srv.baseUrl}/items/special`);
    expect(itemsRes.status).toBe(200);
    expect(await itemsRes.json()).toEqual({ matched: 'param-first', id: 'special' });
  });

  it('handles Promise.reject(undefined), Promise.reject(null), and non-Error throw without hanging', async () => {
    const app = createApp();

    app.get('/reject-undef', async () => Promise.reject(undefined));
    app.get('/reject-null', async () => Promise.reject(null));
    app.get('/throw-str', () => {
      throw 'bad';
    });
    app.get('/ok', (_req: E2ERequest, res: E2EResponse) => {
      res.status(200).send('healthy');
    });

    const srv = await trackServer(await startServer(app));

    for (const path of ['/reject-undef', '/reject-null', '/throw-str']) {
      const res = await fetch(`${srv.baseUrl}${path}`, {
        signal: AbortSignal.timeout(3000),
      });
      expect(res.status).toBe(500);
    }

    const okRes = await fetch(`${srv.baseUrl}/ok`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(okRes.status).toBe(200);
    expect(await okRes.text()).toBe('healthy');
  });

  it('enforces caseSensitive and strict routing options vs defaults', async () => {
    const defaultApp = createApp();
    defaultApp.get('/Case', (_req: E2ERequest, res: E2EResponse) => res.send('default-case'));
    defaultApp.get('/trail', (_req: E2ERequest, res: E2EResponse) => res.send('default-trail'));

    const strictApp = createApp({ caseSensitive: true, strictRouting: true });
    strictApp.get('/Case', (_req: E2ERequest, res: E2EResponse) => res.send('strict-case'));
    strictApp.get('/trail', (_req: E2ERequest, res: E2EResponse) => res.send('strict-trail'));

    const strictRouter = createRouter({ caseSensitive: true, strict: true });
    strictRouter.get('/Exact', (_req: E2ERequest, res: E2EResponse) => res.send('router-exact'));
    defaultApp.use('/r', strictRouter);

    const defaultSrv = await trackServer(await startServer(defaultApp));
    const strictSrv = await trackServer(await startServer(strictApp));

    expect((await fetch(`${defaultSrv.baseUrl}/case`)).status).toBe(200);
    expect((await fetch(`${defaultSrv.baseUrl}/trail/`)).status).toBe(200);

    expect((await fetch(`${defaultSrv.baseUrl}/r/Exact`)).status).toBe(200);
    expect((await fetch(`${defaultSrv.baseUrl}/r/exact`)).status).toBe(404);
    expect((await fetch(`${defaultSrv.baseUrl}/r/Exact/`)).status).toBe(404);

    expect((await fetch(`${strictSrv.baseUrl}/Case`)).status).toBe(200);
    expect((await fetch(`${strictSrv.baseUrl}/case`)).status).toBe(404);
    expect((await fetch(`${strictSrv.baseUrl}/trail`)).status).toBe(200);
    expect((await fetch(`${strictSrv.baseUrl}/trail/`)).status).toBe(404);
  });

  it('handles malformed percent-encoding in route params without crashing', async () => {
    const app = createApp();

    app.get('/users/:id', (req: E2ERequest, res: E2EResponse) => {
      res.json({ id: req.params.id });
    });

    const srv = await trackServer(await startServer(app));

    const malformed = await httpRequest(srv.baseUrl, '/users/%E0%A4%A');
    expect([200, 400]).toContain(malformed.status);

    const healthy = await httpRequest(srv.baseUrl, '/users/ok');
    expect(healthy.status).toBe(200);
    expect(JSON.parse(healthy.text)).toEqual({ id: 'ok' });
  });

  it('supports sub-app mounting req.app, mountpath, path(), and error bubbling', async () => {
    const app = createApp();
    app.set('title', 'Root');

    const adminApp = createApp();
    adminApp.set('title', 'Admin');

    adminApp.get('/info', (req: E2ERequest, res: E2EResponse) => {
      res.json({
        title: req.app.get('title'),
        mountpath: adminApp.mountpath,
        appPath: typeof adminApp.path === 'function' ? adminApp.path() : undefined,
        baseUrl: req.baseUrl,
      });
    });

    adminApp.get('/err', () => {
      throw Object.assign(new Error('sub-app-boom'), { status: 502 });
    });

    app.use('/admin', adminApp);
    app.get('/root-info', (req: E2ERequest, res: E2EResponse) => {
      res.json({ title: req.app.get('title') });
    });

    const parentErrMw: E2EErrorRequestHandler = (err, _req, res, _next) => {
      const typedErr = err as Error & { status?: number };
      res.status(typedErr.status ?? 500).json({ bubbled: typedErr.message });
    };
    app.use(parentErrMw);

    const srv = await trackServer(await startServer(app));

    const infoRes = await fetch(`${srv.baseUrl}/admin/info`);
    expect(infoRes.status).toBe(200);
    expect(await infoRes.json()).toEqual({
      title: 'Admin',
      mountpath: '/admin',
      appPath: '/admin',
      baseUrl: '/admin',
    });

    const errRes = await fetch(`${srv.baseUrl}/admin/err`);
    expect(errRes.status).toBe(502);
    expect(await errRes.json()).toEqual({ bubbled: 'sub-app-boom' });

    const rootRes = await fetch(`${srv.baseUrl}/root-info`);
    expect(rootRes.status).toBe(200);
    expect(await rootRes.json()).toEqual({ title: 'Root' });
  });

  it('preserves response integrity when next(err) or throw occurs after headersSent', async () => {
    const app = createApp();

    app.get('/after-send-next', (_req: E2ERequest, res: E2EResponse, next: E2ENextFunction) => {
      res.status(200).send('ok');
      next(new Error('late-next'));
    });

    app.get('/after-send-throw', (_req: E2ERequest, res: E2EResponse) => {
      res.status(200).send('ok');
      throw new Error('late-throw');
    });

    app.get('/mid-stream-next', (_req: E2ERequest, res: E2EResponse, next: E2ENextFunction) => {
      res.status(200);
      res.flushHeaders();
      res.write('chunk1');
      next(new Error('mid-stream-secret'));
    });

    app.get('/mid-stream-throw', (_req: E2ERequest, res: E2EResponse) => {
      res.status(200);
      res.flushHeaders();
      res.write('chunk1');
      throw new Error('mid-stream-secret');
    });

    app.get('/health', (_req: E2ERequest, res: E2EResponse) => {
      res.status(200).send('alive');
    });

    const errMw: E2EErrorRequestHandler = (err, _req, res, next) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      res.status(500).send('unexpected-error-response');
    };
    app.use(errMw);

    const srv = await trackServer(await startServer(app));

    const r1 = await fetch(`${srv.baseUrl}/after-send-next`);
    expect(r1.status).toBe(200);
    expect(await r1.text()).toBe('ok');

    const r2 = await fetch(`${srv.baseUrl}/after-send-throw`);
    expect(r2.status).toBe(200);
    expect(await r2.text()).toBe('ok');

    const midNext = await readPartialHttpStream(srv.baseUrl, '/mid-stream-next');
    expect(midNext.status).toBe(200);
    expect(midNext.text.startsWith('chunk1')).toBe(true);
    expect(midNext.text).not.toContain('mid-stream-secret');
    expect(midNext.text).not.toContain('Error:');
    expect(midNext.text).not.toMatch(/\bat\s+/);

    const midThrow = await readPartialHttpStream(srv.baseUrl, '/mid-stream-throw');
    expect(midThrow.status).toBe(200);
    expect(midThrow.text.startsWith('chunk1')).toBe(true);
    expect(midThrow.text).not.toContain('mid-stream-secret');
    expect(midThrow.text).not.toContain('Error:');
    expect(midThrow.text).not.toMatch(/\bat\s+/);

    const health = await fetch(`${srv.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('alive');
  });
});
