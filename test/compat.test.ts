import http from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import rxpress, {
  type NextFunction,
  type Request,
  type Response,
  type ServerHandle,
} from '../js/index.js';

let activeServers: ServerHandle[] = [];

async function startApp(app: ReturnType<typeof rxpress>): Promise<string> {
  const srv = app.listen(0, '127.0.0.1');
  activeServers.push(srv);
  const addr = srv.address()!;
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  for (const srv of activeServers) {
    await srv.close();
  }
  activeServers = [];
});

describe('Express 4 & 5 Core Compatibility', () => {
  it('handles all HTTP methods and HEAD fallback to GET', async () => {
    const app = rxpress();
    app.get('/item', (_req, res) => res.json({ method: 'GET' }));
    app.post('/item', (_req, res) => res.status(201).json({ method: 'POST' }));
    app.put('/item', (_req, res) => res.json({ method: 'PUT' }));
    app.patch('/item', (_req, res) => res.json({ method: 'PATCH' }));
    app.delete('/item', (_req, res) => res.sendStatus(204));
    app.options('/item', (_req, res) => res.set('Allow', 'GET,POST').sendStatus(200));

    const base = await startApp(app);

    const rGet = await fetch(`${base}/item`);
    expect(rGet.status).toBe(200);
    expect(await rGet.json()).toEqual({ method: 'GET' });
    expect(rGet.headers.get('x-powered-by')).toBe('Express');

    const rHead = await fetch(`${base}/item`, { method: 'HEAD' });
    expect(rHead.status).toBe(200);
    expect(await rHead.text()).toBe('');
    expect(Number(rHead.headers.get('content-length'))).toBeGreaterThan(0);

    const rPost = await fetch(`${base}/item`, { method: 'POST' });
    expect(rPost.status).toBe(201);
    expect(await rPost.json()).toEqual({ method: 'POST' });

    const rPut = await fetch(`${base}/item`, { method: 'PUT' });
    expect(await rPut.json()).toEqual({ method: 'PUT' });

    const rPatch = await fetch(`${base}/item`, { method: 'PATCH' });
    expect(await rPatch.json()).toEqual({ method: 'PATCH' });

    const rDel = await fetch(`${base}/item`, { method: 'DELETE' });
    expect(rDel.status).toBe(204);

    const rOpt = await fetch(`${base}/item`, { method: 'OPTIONS' });
    expect(rOpt.status).toBe(200);
    expect(rOpt.headers.get('allow')).toBe('GET,POST');
  });

  it('extracts route params, query strings (nested + arrays), and wildcards', async () => {
    const app = rxpress();
    app.set('query parser', 'extended'); // Express 5 defaults to 'simple'
    app.get('/users/:userId/posts/:postId', (req, res) => {
      res.json({
        params: req.params,
        query: req.query,
        path: req.path,
        originalUrl: req.originalUrl,
      });
    });
    app.get('/files/*filepath', (req, res) => {
      res.json({ filepath: req.params.filepath });
    });
    app.get('/optional/:id?', (req, res) => {
      res.json({ id: req.params.id ?? null });
    });
    app.get(/^\/commits\/(\w+)$/, (req, res) => {
      res.json({ sha: req.params['0'] });
    });

    const base = await startApp(app);

    const r1 = await fetch(
      `${base}/users/42/posts/hello%20world?tag=a&tag=b&filter[active]=true`
    );
    expect(await r1.json()).toEqual({
      params: { userId: '42', postId: 'hello world' },
      query: { tag: ['a', 'b'], filter: { active: 'true' } },
      path: '/users/42/posts/hello%20world',
      originalUrl: '/users/42/posts/hello%20world?tag=a&tag=b&filter[active]=true',
    });

    const r2 = await fetch(`${base}/files/docs/2026/readme.md`);
    // Express 5 (path-to-regexp v8): a named wildcard is an array of decoded segments.
    expect(await r2.json()).toEqual({ filepath: ['docs', '2026', 'readme.md'] });

    const r3a = await fetch(`${base}/optional`);
    expect(await r3a.json()).toEqual({ id: null });
    const r3b = await fetch(`${base}/optional/99`);
    expect(await r3b.json()).toEqual({ id: '99' });

    const r4 = await fetch(`${base}/commits/abc123`);
    expect(await r4.json()).toEqual({ sha: 'abc123' });
  });

  it('supports express.Router, nested mounting, mergeParams, route(), and param()', async () => {
    const app = rxpress();
    const api = rxpress.Router();
    const users = rxpress.Router({ mergeParams: true });

    const paramLog: string[] = [];
    api.param('orgId', (_req, _res, next, val) => {
      paramLog.push(`org:${val}`);
      next();
    });

    users.get('/profile', (req, res) => {
      res.json({
        orgId: req.params.orgId,
        baseUrl: req.baseUrl,
        path: req.path,
        originalUrl: req.originalUrl,
        paramLog,
      });
    });

    api.use('/orgs/:orgId/users', users);
    api
      .route('/books')
      .get((_req, res) => res.json({ action: 'list' }))
      .post((_req, res) => res.status(201).json({ action: 'create' }));

    app.use('/api/v1', api);

    const base = await startApp(app);

    const r1 = await fetch(`${base}/api/v1/orgs/acme/users/profile`);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({
      orgId: 'acme',
      baseUrl: '/api/v1/orgs/acme/users',
      path: '/profile',
      originalUrl: '/api/v1/orgs/acme/users/profile',
      paramLog: ['org:acme'],
    });

    const r2 = await fetch(`${base}/api/v1/books`);
    expect(await r2.json()).toEqual({ action: 'list' });
    const r3 = await fetch(`${base}/api/v1/books`, { method: 'POST' });
    expect(r3.status).toBe(201);
    expect(await r3.json()).toEqual({ action: 'create' });
  });

  it('supports next(), next("route"), next("router"), and Express 5 async error handling', async () => {
    const app = rxpress();

    app.get(
      '/skip/:id',
      (req, _res, next) => {
        if (req.params.id === '0') return next('route');
        next();
      },
      (_req, res) => res.json({ branch: 'regular' })
    );
    app.get('/skip/:id', (_req, res) => res.json({ branch: 'special' }));

    const sub = rxpress.Router();
    sub.use((req, _res, next) => {
      if (req.query.bypass === '1') return next('router');
      next();
    });
    sub.get('/check', (_req, res) => res.json({ from: 'sub' }));
    app.use('/sub', sub);
    app.get('/sub/check', (_req, res) => res.json({ from: 'parent' }));

    // Express 5 async handler rejection auto-forwarded to error middleware!
    app.get('/async-boom', async () => {
      await Promise.resolve();
      const err = Object.assign(new Error('Async failure!'), { status: 422 });
      throw err;
    });

    app.get('/sync-boom', () => {
      throw Object.assign(new Error('Sync failure!'), { status: 400 });
    });

    app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status || 500).json({ error: err.message });
    });

    const base = await startApp(app);

    expect(await (await fetch(`${base}/skip/5`)).json()).toEqual({ branch: 'regular' });
    expect(await (await fetch(`${base}/skip/0`)).json()).toEqual({ branch: 'special' });

    expect(await (await fetch(`${base}/sub/check`)).json()).toEqual({ from: 'sub' });
    expect(await (await fetch(`${base}/sub/check?bypass=1`)).json()).toEqual({ from: 'parent' });

    const rAsync = await fetch(`${base}/async-boom`);
    expect(rAsync.status).toBe(422);
    expect(await rAsync.json()).toEqual({ error: 'Async failure!' });

    const rSync = await fetch(`${base}/sync-boom`);
    expect(rSync.status).toBe(400);
    expect(await rSync.json()).toEqual({ error: 'Sync failure!' });

    const r404 = await fetch(`${base}/nonexistent`);
    expect(r404.status).toBe(404);
    expect(await r404.text()).toContain('<pre>Cannot GET /nonexistent</pre>');
  });

  it('supports cookies, redirects, ETag 304, JSONP, settings, and trust proxy', async () => {
    const app = rxpress();
    app.disable('x-powered-by');
    app.set('trust proxy', true);
    expect(app.get('x-powered-by')).toBe(false);
    expect(app.enabled('trust proxy')).toBe(true);

    app.get('/cookie', (req, res) => {
      res
        .cookie('session', 'xyz123', { httpOnly: true, sameSite: 'lax' })
        .cookie('theme', 'dark')
        .json({ incoming: req.cookies });
    });

    app.get('/old', (_req, res) => res.redirect(301, '/new'));
    app.get('/etag-test', (_req, res) => res.json({ stable: true }));
    app.get('/jsonp-test', (_req, res) => res.jsonp({ ok: 1 }));
    app.get('/proxy-info', (req, res) => {
      res.json({
        ip: req.ip,
        ips: req.ips,
        protocol: req.protocol,
        secure: req.secure,
        hostname: req.hostname,
      });
    });

    const base = await startApp(app);

    const rCookie = await fetch(`${base}/cookie`, {
      headers: { Cookie: 'a=1; b=hello%20world' },
    });
    expect(rCookie.headers.get('x-powered-by')).toBeNull();
    const setCookies = rCookie.headers.getSetCookie();
    expect(setCookies.length).toBe(2);
    expect(setCookies[0]).toContain('session=xyz123');
    expect(setCookies[0]).toContain('HttpOnly');
    expect(setCookies[0]).toContain('SameSite=Lax');
    expect(await rCookie.json()).toEqual({ incoming: { a: '1', b: 'hello world' } });

    const rRedir = await fetch(`${base}/old`, { redirect: 'manual' });
    expect(rRedir.status).toBe(301);
    expect(rRedir.headers.get('location')).toBe('/new');

    const rEtag1 = await fetch(`${base}/etag-test`);
    const etag = rEtag1.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(etag!.startsWith('W/"')).toBe(true);

    const rEtag2 = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        `${base}/etag-test`,
        { headers: { 'If-None-Match': etag! } },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(rEtag2.status).toBe(304);

    const rJsonp = await fetch(`${base}/jsonp-test?callback=myCb`);
    expect(await rJsonp.text()).toContain('myCb({"ok":1})');

    const rProxy = await fetch(`${base}/proxy-info`, {
      headers: {
        'X-Forwarded-For': '203.0.113.5, 10.0.0.1',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'api.example.com:443',
      },
    });
    expect(await rProxy.json()).toEqual({
      ip: '203.0.113.5',
      ips: ['203.0.113.5', '10.0.0.1'],
      protocol: 'https',
      secure: true,
      hostname: 'api.example.com',
    });
  });
});
