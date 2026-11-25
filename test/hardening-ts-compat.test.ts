import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import http from 'node:http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { afterEach, describe, expect, it } from 'vitest';
import rxpress, {
  type ErrorRequestHandler,
  type MiddlewareLike,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type ServerHandle,
} from '../js/index.js';
import {
  countFormParameters,
  parseQueryString,
  parseTrustProxy,
  safeJsonParse,
  serializeCookie,
  signCookieValue,
  unsignCookieValue,
} from '../js/security.js';

let activeServers: ServerHandle[] = [];

function startApp(app: ReturnType<typeof rxpress>): {
  handle: ServerHandle;
  port: number;
  base: string;
} {
  const handle = app.listen(0, '127.0.0.1');
  activeServers.push(handle);
  const port = handle.address()!.port;
  return { handle, port, base: `http://127.0.0.1:${port}` };
}

function rawHttp(
  port: number,
  rawReq: string
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const client = createConnection({ host: '127.0.0.1', port }, () => {
      client.write(rawReq);
    });
    const chunks: Buffer[] = [];
    client.on('data', (c) => chunks.push(c));
    client.on('end', () => {
      const raw = Buffer.concat(chunks).toString('latin1');
      const sep = raw.indexOf('\r\n\r\n');
      const head = sep === -1 ? raw : raw.slice(0, sep);
      const body = sep === -1 ? '' : raw.slice(sep + 4);
      const lines = head.split('\r\n');
      const statusMatch = /^HTTP\/\S+\s+(\d+)/.exec(lines[0] || '');
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      const headers: Record<string, string> = {};
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].indexOf(':');
        if (c !== -1) {
          const k = lines[i].slice(0, c).trim().toLowerCase();
          const v = lines[i].slice(c + 1).trim();
          headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
        }
      }
      resolve({ status, headers, body });
    });
    client.on('error', reject);
  });
}

afterEach(async () => {
  for (const s of activeServers) {
    s.closeAllConnections();
    await s.close();
  }
  activeServers = [];
});

describe('M3 Hardening — Feature #8: Cross-Request Pooling Isolation', () => {
  it('isolates custom properties, Symbols, prototypes, and wrapped res.end/writeHead across pooled keep-alive requests', async () => {
    const sym = Symbol('custom');
    let wrappedCalls = 0;

    const app = rxpress();
    app.get('/dirty', (req, res) => {
      req.user = 'alice';
      (req as unknown as Record<symbol, unknown>)[sym] = 'secret-sym';
      res.customTag = 'leaked';
      res.locals.token = 'tok-123';
      const origEnd = res.end.bind(res);
      res.end = ((...args: unknown[]) => {
        wrappedCalls++;
        if (!res.headersSent) res.setHeader('X-Wrap', '1');
        return (origEnd as (...a: unknown[]) => typeof res)(...args);
      }) as typeof res.end;
      res.status(200).send('dirty');
    });

    app.get('/clean', (req, res) => {
      res.json({
        user: req.user ?? null,
        hasSym: Object.getOwnPropertySymbols(req).includes(sym),
        customTag: res.customTag ?? null,
        token: res.locals.token ?? null,
      });
    });

    const { port } = startApp(app);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const reqOnce = (path: string) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((res, rej) => {
        const r = http.request({ host: '127.0.0.1', port, path, agent }, (resp) => {
          const bufs: Buffer[] = [];
          resp.on('data', (c) => bufs.push(c));
          resp.on('end', () =>
            res({
              status: resp.statusCode || 0,
              headers: resp.headers,
              body: Buffer.concat(bufs).toString('utf8'),
            })
          );
        });
        r.on('error', rej);
        r.end();
      });

    try {
      const r1 = await reqOnce('/dirty');
      expect(r1.status).toBe(200);
      expect(r1.headers['x-wrap']).toBe('1');
      expect(wrappedCalls).toBe(1);

      const r2 = await reqOnce('/clean');
      expect(r2.status).toBe(200);
      expect(r2.headers['x-wrap']).toBeUndefined();
      expect(JSON.parse(r2.body)).toEqual({
        user: null,
        hasSym: false,
        customTag: null,
        token: null,
      });
      expect(wrappedCalls).toBe(1);
    } finally {
      agent.destroy();
    }
  });
});

describe('M3 Hardening — Feature #9: Security, Query, Prototype & Trust Proxy', () => {
  it('enforces null-prototype maps, query parser modes, parameterLimit, maxDepth, and safeJsonParse', async () => {
    const parsedExt = parseQueryString('user[name]=alice&__proto__[p]=1&constructor[prototype][p]=1&a=1&a=2');
    expect(Object.getPrototypeOf(parsedExt)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(parsedExt, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).p).toBeUndefined();
    expect(parsedExt.a).toEqual(['1', '2']);

    const parsedSimple = parseQueryString('user[name]=alice&tags[]=a&tags[]=b', { mode: 'simple' });
    expect(parsedSimple['user[name]']).toBe('alice');
    expect(parsedSimple['tags[]']).toEqual(['a', 'b']);

    const deep = parseQueryString(`a${'[b]'.repeat(20)}=1`, { maxDepth: 5 });
    expect(Object.getPrototypeOf(deep)).toBeNull();
    expect(countFormParameters('a=1&b=2&c=3&d=4', 3)).toBeUndefined();

    const safeJson = safeJsonParse('{"__proto__":{"polluted":1},"ok":true}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(safeJson, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(safeJson.ok).toBe(true);

    const app = rxpress();
    app.set('query parser', 'simple');
    app.use('/form', rxpress.urlencoded({ extended: false, parameterLimit: 3 }));
    app.get('/q', (req, res) => res.json({ query: req.query }));
    app.post('/form', (req, res) => res.json({ body: req.body }));
    app.get('/cookies', (req, res) => {
      res.json({
        protoNull: Object.getPrototypeOf(req.cookies) === null,
        ok: req.cookies.ok,
        hasProto: Object.prototype.hasOwnProperty.call(req.cookies, '__proto__'),
      });
    });

    const { base, port } = startApp(app);

    const qRes = await fetch(`${base}/q?user[name]=bob`);
    expect(await qRes.json()).toEqual({ query: { 'user[name]': 'bob' } });

    const fOk = await fetch(`${base}/form`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'user[name]=bob&a=1',
    });
    expect(fOk.status).toBe(200);
    expect(await fOk.json()).toEqual({ body: { 'user[name]': 'bob', a: '1' } });

    const fTooMany = await fetch(`${base}/form`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=2&c=3&d=4',
    });
    expect(fTooMany.status).toBe(413);

    const cookieResp = await rawHttp(
      port,
      'GET /cookies HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: __proto__=bad; ok=first; ok=second\r\nConnection: close\r\n\r\n'
    );
    expect(cookieResp.status).toBe(200);
    expect(JSON.parse(cookieResp.body)).toEqual({
      protoNull: true,
      ok: 'first',
      hasProto: false,
    });
  });

  it('evaluates trust proxy (hops, CIDR, presets, arrays, fn) and production finalhandler hardening', async () => {
    const tpHop1 = parseTrustProxy(1)!;
    expect(tpHop1('127.0.0.1', 0)).toBe(true);
    expect(tpHop1('10.0.0.1', 1)).toBe(false);

    const tpLoopback = parseTrustProxy('loopback')!;
    expect(tpLoopback('127.0.0.5', 0)).toBe(true);
    expect(tpLoopback('::1', 0)).toBe(true);
    expect(tpLoopback('::ffff:127.0.0.1', 0)).toBe(true);
    expect(tpLoopback('203.0.113.1', 0)).toBe(false);

    const app = rxpress();
    app.set('trust proxy', 1);
    app.set('env', 'production');
    app.get('/who', (req, res) => {
      res.json({
        ip: req.ip,
        ips: req.ips,
        protocol: req.protocol,
        peer: req.socket.remoteAddress,
      });
    });
    app.get('/boom', () => {
      throw Object.assign(new Error('SECRET_INTERNAL_MSG'), {
        status: 429,
        headers: { 'Retry-After': '60' },
      });
    });

    const { base } = startApp(app);

    const whoRes = await fetch(`${base}/who`, {
      headers: {
        'X-Forwarded-For': '203.0.113.9, 10.0.0.2',
        'X-Forwarded-Proto': 'https',
      },
    });
    expect(await whoRes.json()).toEqual({
      ip: '10.0.0.2',
      ips: ['10.0.0.2'],
      protocol: 'https',
      peer: '127.0.0.1',
    });

    const boomRes = await fetch(`${base}/boom`);
    expect(boomRes.status).toBe(429);
    expect(boomRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(boomRes.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(boomRes.headers.get('retry-after')).toBe('60');
    const boomText = await boomRes.text();
    expect(boomText).toContain('<pre>Too Many Requests</pre>');
    expect(boomText).not.toContain('SECRET_INTERNAL_MSG');
  });
});

describe('M3 Hardening — Feature #10: Dispatch, Sub-Apps, Patterns & Lifecycle', () => {
  it('supports async directFn next() after await, error normalization, precedence, req.route, OPTIONS Allow, sub-apps, and Express 5 patterns', async () => {
    const app = rxpress();
    app.set('title', 'Root');

    // Async directFn calling next() after await
    app.get('/async-direct', async (req, _res, next) => {
      await Promise.resolve();
      req.asyncFlag = true;
      next();
    });
    app.use('/async-direct', (req, res) => {
      res.json({ asyncFlag: req.asyncFlag, hasRoute: Boolean(req.route) });
    });

    // Registration-order precedence: param before static
    app.get('/items/:id', (req, res) => {
      res.json({ kind: 'param-first', id: req.params.id, hasRoute: Boolean(req.route) });
    });
    app.get('/items/special', (_req, res) => {
      res.json({ kind: 'static-second' });
    });

    // Multi-param and Express 5 {/:opt}
    app.get('/flights/:from-:to', (req, res) => res.json(req.params));
    app.get('/opt{/:opt}', (req, res) => res.json(req.params));

    // OPTIONS auto-Allow target
    app.get('/res', (_req, res) => res.send('ok'));
    app.post('/res', (_req, res) => res.status(201).send('created'));

    // Error normalization for reject(undefined/null) and throw null
    app.get('/rej-undef', async () => Promise.reject(undefined));
    app.get('/throw-null', () => {
      throw null;
    });

    // Sub-router param(array) + recursive body rule
    const subRouter = rxpress.Router();
    subRouter.param(['a', 'b'], (req, _res, next, val, name) => {
      req[`p_${name}`] = val;
      next();
    });
    subRouter.use(rxpress.json({ limit: '2mb' }));
    subRouter.post('/big/:a/:b', (req, res) => {
      res.json({ a: req.p_a, b: req.p_b, len: JSON.stringify(req.body).length });
    });
    app.use('/sub', subRouter);

    // Sub-app mount event, mountpath, path(), req.app
    let mountedParent: unknown = null;
    const admin = rxpress();
    admin.set('title', 'Admin');
    admin.on('mount', (parent) => {
      mountedParent = parent;
    });
    admin.get('/info', (req, res) => {
      res.json({
        title: req.app.get('title'),
        mountpath: admin.mountpath,
        path: admin.path(),
      });
    });
    app.use('/admin', admin);

    const errMw: ErrorRequestHandler = (err, _req, res, _next) => {
      res.status(500).json({ err: err instanceof Error ? err.message : String(err) });
    };
    app.use(errMw);

    const { base } = startApp(app);
    expect(mountedParent).toBe(app);

    expect(await (await fetch(`${base}/async-direct`)).json()).toEqual({
      asyncFlag: true,
      hasRoute: true,
    });
    expect(await (await fetch(`${base}/items/special`)).json()).toEqual({
      kind: 'param-first',
      id: 'special',
      hasRoute: true,
    });
    expect(await (await fetch(`${base}/flights/NYC-LON`)).json()).toEqual({
      from: 'NYC',
      to: 'LON',
    });
    expect(await (await fetch(`${base}/opt`)).json()).toEqual({});
    expect(await (await fetch(`${base}/opt/42`)).json()).toEqual({ opt: '42' });

    const optRes = await fetch(`${base}/res`, { method: 'OPTIONS' });
    expect(optRes.status).toBe(200);
    const allowMethods = (optRes.headers.get('allow') || '').split(', ');
    expect(allowMethods).toContain('GET');
    expect(allowMethods).toContain('HEAD');
    expect(allowMethods).toContain('POST');

    expect((await fetch(`${base}/rej-undef`)).status).toBe(500);
    expect((await fetch(`${base}/throw-null`)).status).toBe(500);

    const bigBody = JSON.stringify({ data: 'x'.repeat(1200 * 1024) });
    const subRes = await fetch(`${base}/sub/big/one/two`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bigBody,
    });
    expect(subRes.status).toBe(200);
    expect(await subRes.json()).toEqual({ a: 'one', b: 'two', len: bigBody.length });

    expect(await (await fetch(`${base}/admin/info`)).json()).toEqual({
      title: 'Admin',
      mountpath: '/admin',
      path: '/admin',
    });
  });

  it('supports optional-port app.listen(), ServerHandle EventEmitter, closeAllConnections, and EADDRINUSE', async () => {
    const app = rxpress();
    app.get('/ping', (_req, res) => res.send('pong'));

    const events: string[] = [];
    const srv = app.listen(() => {
      events.push('cb');
    });
    activeServers.push(srv);
    srv.on('listening', () => events.push('listening'));
    srv.on('close', () => events.push('close'));

    expect(typeof srv.closeAllConnections).toBe('function');
    expect(typeof srv.ref).toBe('function');
    expect(typeof srv.unref).toBe('function');
    expect(srv.setTimeout(5000).timeout).toBe(5000);

    await new Promise((r) => setTimeout(r, 20));
    expect(events).toContain('listening');
    expect(events).toContain('cb');

    const port = srv.address()!.port;
    expect(port).toBeGreaterThan(0);

    // EADDRINUSE on second server bound to same port
    const app2 = rxpress();
    let caughtCode: string | undefined;
    try {
      const s2 = app2.listen(port, '0.0.0.0');
      await s2.close();
    } catch (err) {
      caughtCode = (err as NodeJS.ErrnoException).code;
    }
    expect(caughtCode).toBe('EADDRINUSE');

    await srv.close();
    expect(events.filter((e) => e === 'close').length).toBe(1);
    expect(srv.listening).toBe(false);
  });
});

describe('M3 Hardening — Feature #11: Express 4/5 req/res & 3rd-Party Compat', () => {
  it('supports req.range, req.is(*+json), signedCookies, accepts specificity, fresh/no-cache, headersSent, status validation, and morgan content-length', async () => {
    const logs: string[] = [];
    const SECRET = 'm3-cookie-secret';
    const signed = signCookieValue('val', SECRET);
    expect(unsignCookieValue(signed, SECRET)).toBe('val');
    expect(unsignCookieValue(signed + 'x', SECRET)).toBe(false);
    expect(() => serializeCookie('a', 'b', { maxAge: Number.NaN })).toThrow(TypeError);
    expect(() => serializeCookie('a', 'b', { domain: 'bad\r\n' })).toThrow(TypeError);

    const app = rxpress();
    app.set('cookie secret', SECRET);
    app.use(
      morgan('tiny', {
        stream: { write: (line: string) => logs.push(line.trim()) },
      })
    );
    app.use(helmet());
    app.use(cors());

    app.get('/range', (req, res) => res.json({ range: req.range(100, { combine: true }) }));
    app.post('/is-vendor', (req, res) => {
      res.json({ plusJson: req.is('application/*+json') });
    });
    app.get('/sign', (_req, res) => {
      res.cookie('sid', 'u1', { signed: true }).send('ok');
    });
    app.get('/verify', (req, res) => {
      res.json({ sid: req.signedCookies.sid ?? null });
    });
    app.get('/accepts', (req, res) => {
      res.json({ best: req.accepts('text/plain', 'text/html') });
    });
    app.get('/fresh', (req, res) => {
      res.set('ETag', '"v1"').set('Last-Modified', 'Wed, 21 Oct 2015 07:28:00 GMT');
      const fresh = req.fresh;
      res.removeHeader('ETag');
      res.removeHeader('Last-Modified');
      res.json({ fresh, stale: !fresh });
    });
    app.get('/wire-etag', (_req, res) => {
      res.send('fresh-wire-body');
    });
    app.get('/jsonp-empty', (_req, res) => {
      res.jsonp({ ok: 1 });
    });
    app.get('/bad-status', (_req, res) => {
      res.status(99).send('nope');
    });
    app.get('/after-flush', (_req, res) => {
      res.status(200);
      res.setHeader('content-type', 'application/json');
      res.flushHeaders();
      let code = '';
      try {
        res.setHeader('X-Late', '1');
      } catch (e) {
        code = (e as NodeJS.ErrnoException).code || '';
      }
      res.end(JSON.stringify({ code }));
    });
    app.get('/log-len', (_req, res) => {
      res.status(200).send('hello-log');
    });

    app.use(((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ msg: err instanceof Error ? err.message : String(err) });
    }) as ErrorRequestHandler);

    const { base, port } = startApp(app);

    const rngRes = await fetch(`${base}/range`, { headers: { Range: 'bytes=0-10, 5-20' } });
    expect(await rngRes.json()).toEqual({ range: [{ start: 0, end: 20 }] });

    const vendorRes = await fetch(`${base}/is-vendor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.api+json' },
      body: '{}',
    });
    expect(await vendorRes.json()).toEqual({ plusJson: 'application/vnd.api+json' });

    const signRes = await fetch(`${base}/sign`);
    const sc = signRes.headers.getSetCookie()[0];
    const verifyRes = await fetch(`${base}/verify`, { headers: { Cookie: sc.split(';')[0] } });
    expect(await verifyRes.json()).toEqual({ sid: 'u1' });

    const accRes = await fetch(`${base}/accepts`, { headers: { Accept: 'text/*, text/html' } });
    expect(await accRes.json()).toEqual({ best: 'text/html' });

    const freshRes = await rawHttp(
      port,
      'GET /fresh HTTP/1.1\r\nHost: 127.0.0.1\r\nIf-Modified-Since: Thu, 22 Oct 2015 07:28:00 GMT\r\nConnection: close\r\n\r\n'
    );
    expect(JSON.parse(freshRes.body)).toEqual({ fresh: true, stale: false });

    const wire1 = await rawHttp(
      port,
      'GET /wire-etag HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
    );
    const wireEtag = wire1.headers.etag;
    const wire304 = await rawHttp(
      port,
      `GET /wire-etag HTTP/1.1\r\nHost: 127.0.0.1\r\nIf-None-Match: ${wireEtag}\r\nConnection: close\r\n\r\n`
    );
    expect(wire304.status).toBe(304);
    const wireNoCache = await rawHttp(
      port,
      `GET /wire-etag HTTP/1.1\r\nHost: 127.0.0.1\r\nIf-None-Match: ${wireEtag}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n`
    );
    expect(wireNoCache.status).toBe(200);
    expect(wireNoCache.body).toBe('fresh-wire-body');

    const jsonpRes = await fetch(`${base}/jsonp-empty?callback=!!!`);
    expect(jsonpRes.headers.get('content-type')).toContain('application/json');
    expect(await jsonpRes.json()).toEqual({ ok: 1 });

    expect((await fetch(`${base}/bad-status`)).status).toBe(500);
    expect(await (await fetch(`${base}/after-flush`)).json()).toEqual({
      code: 'ERR_HTTP_HEADERS_SENT',
    });

    await fetch(`${base}/log-len`);
    await new Promise((r) => setTimeout(r, 20));
    expect(logs.some((l) => /^GET \/log-len 200 9 - /.test(l))).toBe(true);
  });
});

describe('M3 Hardening — Feature #12: Strict TypeScript Types & Dual Packaging', () => {
  it('provides callable CJS module.exports with named exports and clean .d.ts / .d.cts without leaked internal symbols', () => {
    const req = createRequire(import.meta.url);
    const cjs = req(join(process.cwd(), 'dist', 'index.cjs'));
    expect(typeof cjs).toBe('function');
    expect(cjs.default).toBe(cjs);
    expect(cjs.__esModule).toBe(true);
    expect(typeof cjs.Router).toBe('function');
    expect(typeof cjs.json).toBe('function');
    expect(cjs.rxpress).toBe(cjs);

    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      exports: { '.': { import: { types: string; default: string }; require: { types: string; default: string } } };
    };
    expect(pkg.exports['.'].import).toEqual({
      types: './dist/index.d.ts',
      default: './dist/index.mjs',
    });
    expect(pkg.exports['.'].require).toEqual({
      types: './dist/index.d.cts',
      default: './dist/index.cjs',
    });

    const dts = readFileSync(join(process.cwd(), 'dist', 'index.d.ts'), 'utf8');
    const dcts = readFileSync(join(process.cwd(), 'dist', 'index.d.cts'), 'utf8');
    for (const content of [dts, dcts]) {
      expect(content).not.toContain('ResponseBatchWriter');
      expect(content).not.toContain('NativeServerInstance');
      expect(content).not.toContain('NativeMiddlewareMeta');
      expect(content).not.toMatch(/\b_[a-zA-Z0-9]+\b/);
    }

    // Compile-time check for nested MiddlewareLike arrays & 3rd-party middlewares
    const app = rxpress();
    const mw1: RequestHandler = (_req, _res, next) => next();
    const nested: MiddlewareLike = [mw1, [rxpress.Router()]];
    app.use(nested);
    app.use(cors());
    app.use(helmet());
    app.use(morgan('tiny'));
  });
});

describe('regressions: TypeScript and Express compatibility', () => {
  it('isolates req.res overwrite and Object.freeze(req) across pipelined requests without hanging', async () => {
    const app = rxpress();
    app.get('/poison-res', (req, res) => {
      (req as unknown as { res: unknown }).res = { fake: true };
      res.send('poisoned-res');
    });
    app.get('/poison-freeze', (req, res) => {
      Object.freeze(req);
      res.send('frozen');
    });
    app.get('/poison-readonly', (req, res) => {
      Object.defineProperty(req, 'app', { value: req.app, writable: false });
      res.send('readonly');
    });
    app.get('/check', (req, res) => {
      res.json({ resMatches: req.res === res, extensible: Object.isExtensible(req) });
    });

    const { port } = startApp(app);
    const pipelineRaw =
      'GET /poison-res HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
      'GET /check HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
      'GET /poison-freeze HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
      'GET /check HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
      'GET /poison-readonly HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
      'GET /check HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n';

    const raw = await new Promise<string>((resolve, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.write(pipelineRaw);
      });
      const chunks: Buffer[] = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      sock.on('error', reject);
    });

    expect(raw).toContain('poisoned-res');
    expect(raw).toContain('frozen');
    expect(raw).toContain('readonly');
    const matches = raw.match(/\{"resMatches":true,"extensible":true\}/g) || [];
    expect(matches.length).toBe(3);
  });

  it('does not overwrite downstream req.next after sync next() in async directFn (sendFile missing)', async () => {
    const app = rxpress();
    app.get('/trap', async (_req, _res, next) => {
      next();
    });
    app.use('/trap', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 10));
      res.sendFile('/tmp/rxpress_definitely_missing_file_iter2_check_99999');
    });
    app.use(((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status || 404).json({ caught: true });
    }) as ErrorRequestHandler);

    const { base } = startApp(app);
    const r = await fetch(`${base}/trap`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ caught: true });
  });

  it('scopes dynamic sub-router body rules without sibling bleed and registers shared routers on all mounts', async () => {
    const app = rxpress();

    const dynUpload = rxpress.Router();
    dynUpload.use(rxpress.json({ limit: '5mb' }));
    dynUpload.post('/', (req, res) => {
      res.json({ uploaded: JSON.stringify(req.body).length });
    });
    app.use('/tenants/:tid/upload', dynUpload);
    app.post('/tenants/:tid/default-limit', rxpress.json(), (req, res) => {
      res.json({ len: JSON.stringify(req.body).length });
    });

    const shared = rxpress.Router();
    shared.use(rxpress.json({ limit: '5mb' }));
    shared.post('/big', (req, res) => {
      res.json({ len: JSON.stringify(req.body).length });
    });
    app.use('/api/v1', shared);
    app.use('/api/v2', shared);

    const { base, port } = startApp(app);
    const twoMbBody = JSON.stringify({ payload: 'a'.repeat(1600 * 1024) });

    const rUpload = await fetch(`${base}/tenants/acme/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: twoMbBody,
    });
    expect(rUpload.status).toBe(200);

    const siblingResp = await rawHttp(
      port,
      `POST /tenants/acme/default-limit HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(twoMbBody)}\r\nConnection: close\r\n\r\n`
    );
    expect(siblingResp.status).toBe(413);

    const rV1 = await fetch(`${base}/api/v1/big`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: twoMbBody,
    });
    expect(rV1.status).toBe(200);

    const rV2 = await fetch(`${base}/api/v2/big`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: twoMbBody,
    });
    expect(rV2.status).toBe(200);
  });

  it('guards _processParams nextCb against async rejection after next()', async () => {
    const app = rxpress();
    app.param('race', async (_req, _res, next) => {
      await new Promise((r) => setTimeout(r, 5));
      next();
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('param-after-next');
    });
    app.get('/race/:race', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 25));
      if (!res.writableEnded) res.send('route-won');
    });
    app.use(((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ err: err.message });
    }) as ErrorRequestHandler);

    const { base } = startApp(app);
    const r = await fetch(`${base}/race/123`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('route-won');
  });

  it('supports req.is(*/*+json), query/urlencoded array[length]/array[toString], q=0 Accept exclusion, and single _triggerWriteHeadHook', async () => {
    const app = rxpress();
    app.set('query parser', 'extended'); // Express 5 defaults to 'simple'
    let writeHeadCalls = 0;

    app.post('/is-star-plus', (req, res) => {
      res.json({ match: req.is('*/*+json') });
    });
    app.get('/q', (req, res) => {
      res.json({ query: req.query });
    });
    app.post('/form-ext', rxpress.urlencoded({ extended: true }), (req, res) => {
      res.json({ body: req.body });
    });
    app.get('/accepts-q0', (req, res) => {
      res.json({ best: req.accepts(['text/html', 'application/json']) });
    });
    app.get('/wh-hook', (_req, res) => {
      const orig = res.writeHead.bind(res);
      res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
        writeHeadCalls++;
        return orig(...args);
      }) as typeof res.writeHead;
      (res as unknown as { _implicitHeader: () => void })._implicitHeader();
      res.end('ok');
    });

    const { base } = startApp(app);

    const rIs = await fetch(`${base}/is-star-plus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.api+json' },
      body: '{}',
    });
    expect(await rIs.json()).toEqual({ match: 'application/vnd.api+json' });

    const rQ1 = await fetch(`${base}/q?a[]=1&a[length]=foo`);
    expect(rQ1.status).toBe(200);
    expect(await rQ1.json()).toEqual({ query: { a: { '0': '1', length: 'foo' } } });

    const rQ2 = await fetch(`${base}/q?a[]=1&a[toString]=bar`);
    expect(rQ2.status).toBe(200);
    expect(await rQ2.json()).toEqual({ query: { a: { '0': '1', toString: 'bar' } } });

    const rForm = await fetch(`${base}/form-ext`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a[]=1&a[length]=foo',
    });
    expect(rForm.status).toBe(200);
    expect(await rForm.json()).toEqual({ body: { a: { '0': '1', length: 'foo' } } });

    const rAcc = await fetch(`${base}/accepts-q0`, {
      headers: { Accept: 'text/html;q=0, */*;q=0.8' },
    });
    expect(await rAcc.json()).toEqual({ best: 'application/json' });

    const rWh = await fetch(`${base}/wh-hook`);
    expect(rWh.status).toBe(200);
    expect(await rWh.text()).toBe('ok');
    expect(writeHeadCalls).toBe(1);
  });
});
