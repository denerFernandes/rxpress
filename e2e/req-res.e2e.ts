import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApp,
  createRouter,
  itRxpress,
  startServer,
  type E2EErrorRequestHandler,
  type E2ENextFunction,
  type E2ERequest,
  type E2EResponse,
  type StartedServer,
} from './helpers/server.js';

const servers: StartedServer[] = [];

async function trackServer(srv: StartedServer): Promise<StartedServer> {
  servers.push(srv);
  return srv;
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

function normalizeSetCookie(header: string | string[] | undefined): string[] {
  if (!header) return [];
  return Array.isArray(header) ? header : [header];
}

afterEach(async () => {
  while (servers.length > 0) {
    const srv = servers.pop();
    if (srv) {
      srv.closeAllConnections();
      await srv.close();
    }
  }
});

describe('req & res APIs, Content Negotiation, Cookies & App Settings', () => {
  it('exposes req URL, header, host, route, and app getters accurately', async () => {
    const app = createApp();
    app.set('appTag', 'fg02');
    const api = createRouter();

    api.get('/items', (req: E2ERequest, res: E2EResponse) => {
      res.json({
        path: req.path,
        originalUrl: req.originalUrl,
        baseUrl: req.baseUrl,
        host: req.host,
        hostname: req.hostname,
        getCustom: req.get('x-custom'),
        headerCustom: req.header('X-Custom'),
        getReferrer: req.get('referrer'),
        rawHeaderVal: req.headers['x-custom'],
        hasRoute: Boolean(req.route),
        appTag: req.app.get('appTag'),
      });
    });

    app.use('/api', api);

    const srv = await trackServer(await startServer(app));

    const res = await httpRequest(srv.baseUrl, '/api/items?x=1', {
      headers: {
        Host: 'api.example.com:8080',
        'X-Custom': 'a',
        Referer: 'https://prev.example/p',
      },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      path: '/items',
      originalUrl: '/api/items?x=1',
      baseUrl: '/api',
      host: 'api.example.com:8080',
      hostname: 'api.example.com',
      getCustom: 'a',
      headerCustom: 'a',
      getReferrer: 'https://prev.example/p',
      rawHeaderVal: 'a',
      hasRoute: true,
      appTag: 'fg02',
    });
  });

  it("supports query parser 'extended', 'simple', and false modes", async () => {
    const extApp = createApp();
    extApp.set('query parser', 'extended');
    extApp.get('/q', (req: E2ERequest, res: E2EResponse) => res.json({ query: req.query }));

    const simpleApp = createApp();
    simpleApp.set('query parser', 'simple');
    simpleApp.get('/q', (req: E2ERequest, res: E2EResponse) => res.json({ query: req.query }));

    const offApp = createApp();
    offApp.set('query parser', false);
    offApp.get('/q', (req: E2ERequest, res: E2EResponse) => res.json({ query: req.query }));

    const extSrv = await trackServer(await startServer(extApp));
    const simpleSrv = await trackServer(await startServer(simpleApp));
    const offSrv = await trackServer(await startServer(offApp));

    const qs = '/q?user[name]=alice&tags[]=a&tags[]=b&dup=1&dup=2';

    const extRes = await fetch(`${extSrv.baseUrl}${qs}`);
    expect(extRes.status).toBe(200);
    expect(await extRes.json()).toEqual({
      query: {
        user: { name: 'alice' },
        tags: ['a', 'b'],
        dup: ['1', '2'],
      },
    });

    const simpleRes = await fetch(`${simpleSrv.baseUrl}${qs}`);
    expect(simpleRes.status).toBe(200);
    expect(await simpleRes.json()).toEqual({
      query: {
        'user[name]': 'alice',
        'tags[]': ['a', 'b'],
        dup: ['1', '2'],
      },
    });

    const offRes = await fetch(`${offSrv.baseUrl}${qs}`);
    expect(offRes.status).toBe(200);
    const offBody = (await offRes.json()) as { query: Record<string, unknown> };
    expect(Object.keys(offBody.query).length).toBe(0);
  });

  it('supports res builders, res.locals isolation, json spaces, and jsonp', async () => {
    const app = createApp();
    app.set('json spaces', 2);

    app.use('/chain', (_req: E2ERequest, res: E2EResponse, next: E2ENextFunction) => {
      res.locals.traceId = 'tr-99';
      next();
    });

    app.get('/chain', (_req: E2ERequest, res: E2EResponse) => {
      res
        .status(201)
        .set('X-A', '1')
        .header('X-B', '2')
        .append('X-A', '2')
        .set('X-Temp', 'drop');
      const tempBefore = res.get('X-Temp');
      res.removeHeader('X-Temp');
      const tempAfter = res.get('X-Temp') ?? null;

      res.type('json').send(
        JSON.stringify({
          traceId: res.locals.traceId,
          tempBefore,
          tempAfter,
        })
      );
    });

    app.get('/locals-check', (_req: E2ERequest, res: E2EResponse) => {
      res.json({ hasTraceId: res.locals.traceId !== undefined });
    });

    app.get('/pretty', (_req: E2ERequest, res: E2EResponse) => {
      res.json({ ok: 1 });
    });

    app.get('/jsonp', (_req: E2ERequest, res: E2EResponse) => {
      res.jsonp({ ok: 1 });
    });

    const srv = await trackServer(await startServer(app));

    const chainRes = await fetch(`${srv.baseUrl}/chain`);
    expect(chainRes.status).toBe(201);
    expect(chainRes.headers.get('x-a')).toBe('1, 2');
    expect(chainRes.headers.get('x-b')).toBe('2');
    expect(chainRes.headers.get('x-temp')).toBeNull();
    expect(chainRes.headers.get('content-type')).toContain('application/json');
    expect(await chainRes.json()).toEqual({
      traceId: 'tr-99',
      tempBefore: 'drop',
      tempAfter: null,
    });

    const localsCheck = await fetch(`${srv.baseUrl}/locals-check`);
    expect(localsCheck.status).toBe(200);
    expect(await localsCheck.json()).toEqual({ hasTraceId: false });

    const prettyRes = await fetch(`${srv.baseUrl}/pretty`);
    expect(prettyRes.status).toBe(200);
    const prettyText = await prettyRes.text();
    expect(prettyText).toContain('\n  "ok": 1');

    const jsonpRes = await fetch(`${srv.baseUrl}/jsonp?callback=cb1`);
    expect(jsonpRes.status).toBe(200);
    expect(jsonpRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(jsonpRes.headers.get('content-type')).toContain('text/javascript');
    const jsonpBody = await jsonpRes.text();
    expect(jsonpBody).toContain("typeof cb1 === 'function'");
    expect(jsonpBody).toContain('cb1(');
    expect(jsonpBody).toContain('"ok"');
  });

  it('sets Location, Link, and Vary headers via redirect, location, links, and vary', async () => {
    const app = createApp();

    app.get('/redir-301', (_req: E2ERequest, res: E2EResponse) => {
      res.redirect(301, '/dest');
    });
    app.get('/redir-default', (_req: E2ERequest, res: E2EResponse) => {
      res.redirect('/fallback');
    });
    app.get('/loc', (_req: E2ERequest, res: E2EResponse) => {
      res.location('/next-page').status(204).end();
    });
    app.get('/meta', (_req: E2ERequest, res: E2EResponse) => {
      res
        .links({ next: '/p2', last: '/p5' })
        .vary('Origin')
        .vary('Accept-Encoding')
        .vary('Origin')
        .status(200)
        .send('meta-ok');
    });

    const srv = await trackServer(await startServer(app));

    const r301 = await fetch(`${srv.baseUrl}/redir-301`, { redirect: 'manual' });
    expect(r301.status).toBe(301);
    expect(r301.headers.get('location')).toBe('/dest');

    const r302 = await fetch(`${srv.baseUrl}/redir-default`, { redirect: 'manual' });
    expect(r302.status).toBe(302);
    expect(r302.headers.get('location')).toBe('/fallback');

    const locRes = await fetch(`${srv.baseUrl}/loc`);
    expect(locRes.status).toBe(204);
    expect(locRes.headers.get('location')).toBe('/next-page');

    const metaRes = await fetch(`${srv.baseUrl}/meta`);
    expect(metaRes.status).toBe(200);
    const linkHeader = metaRes.headers.get('link') ?? '';
    expect(linkHeader).toContain('</p2>; rel="next"');
    expect(linkHeader).toContain('</p5>; rel="last"');
    const varyHeader = metaRes.headers.get('vary') ?? '';
    const varyParts = varyHeader.split(',').map((s) => s.trim().toLowerCase());
    expect(varyParts).toContain('origin');
    expect(varyParts).toContain('accept-encoding');
    expect(varyParts.filter((s) => s === 'origin').length).toBe(1);
  });

  itRxpress(
    "res.location('back') is the literal relative URL (Express 5 dropped the magic string)",
    async () => {
      const app = createApp();
      app.get('/back', (_req: E2ERequest, res: E2EResponse) => {
        res.location('back').status(204).end();
      });

      const srv = await trackServer(await startServer(app));

      const withRef = await httpRequest(srv.baseUrl, '/back', {
        headers: { Referer: '/prev' },
      });
      expect(withRef.status).toBe(204);
      expect(withRef.headers.location).toBe('back');

      const withoutRef = await httpRequest(srv.baseUrl, '/back');
      expect(withoutRef.status).toBe(204);
      expect(withoutRef.headers.location).toBe('back');
    }
  );

  it('negotiates content with res.format, req.accepts, and req.is', async () => {
    const app = createApp();

    app.get('/negotiate', (req: E2ERequest, res: E2EResponse) => {
      res.format({
        html: () => res.send(`<p>html:${String(req.accepts('html', 'json'))}</p>`),
        json: () => res.json({ kind: 'json', accepted: req.accepts('html', 'json') }),
        default: () => res.type('txt').send('plain'),
      });
    });

    app.all('/check-is', (req: E2ERequest, res: E2EResponse) => {
      res.json({
        isJson: req.is('json'),
        isHtml: req.is('html'),
        isPlusJson: req.is('application/*+json'),
      });
    });

    const srv = await trackServer(await startServer(app));

    const htmlRes = await fetch(`${srv.baseUrl}/negotiate`, {
      headers: { Accept: 'application/json;q=0.9, text/html;q=1.0' },
    });
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('content-type')).toContain('text/html');
    expect((htmlRes.headers.get('vary') ?? '').toLowerCase()).toContain('accept');
    expect(await htmlRes.text()).toBe('<p>html:html</p>');

    const jsonRes = await fetch(`${srv.baseUrl}/negotiate`, {
      headers: { Accept: 'application/json;q=1.0, text/html;q=0.5' },
    });
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get('content-type')).toContain('application/json');
    expect(await jsonRes.json()).toEqual({ kind: 'json', accepted: 'json' });

    const defRes = await fetch(`${srv.baseUrl}/negotiate`, {
      headers: { Accept: 'text/csv' },
    });
    expect(defRes.status).toBe(200);
    expect(await defRes.text()).toBe('plain');

    const postJson = await httpRequest(srv.baseUrl, '/check-is', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': '2',
      },
      body: '{}',
    });
    expect(postJson.status).toBe(200);
    expect(JSON.parse(postJson.text)).toMatchObject({
      isJson: 'json',
      isHtml: false,
    });

    const postVendor = await httpRequest(srv.baseUrl, '/check-is', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.api+json',
        'Content-Length': '2',
      },
      body: '{}',
    });
    expect(postVendor.status).toBe(200);
    expect(JSON.parse(postVendor.text)).toMatchObject({
      isPlusJson: 'application/vnd.api+json',
    });

    const getNoBody = await httpRequest(srv.baseUrl, '/check-is', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(getNoBody.status).toBe(200);
    expect(JSON.parse(getNoBody.text)).toEqual({
      isJson: null,
      isHtml: null,
      isPlusJson: null,
    });
  });

  it('supports res.cookie, res.clearCookie, and etag weak/strong/off 304 behavior', async () => {
    const weakApp = createApp({ etagMode: 'weak' });
    weakApp.get('/set-cookies', (_req: E2ERequest, res: E2EResponse) => {
      res
        .cookie('session', 'xyz', {
          httpOnly: true,
          sameSite: 'lax',
          path: '/app',
          maxAge: 60000,
        })
        .cookie('prefs', { theme: 'dark' })
        .send('cookies-set');
    });
    weakApp.get('/clear-cookie', (_req: E2ERequest, res: E2EResponse) => {
      res.clearCookie('session', { path: '/app' }).send('cleared');
    });
    weakApp.get('/etag', (_req: E2ERequest, res: E2EResponse) => {
      res.send('etag-payload');
    });

    const strongApp = createApp({ etagMode: 'strong' });
    strongApp.get('/etag', (_req: E2ERequest, res: E2EResponse) => {
      res.send('etag-payload');
    });

    const offApp = createApp({ etagMode: 'off' });
    offApp.get('/etag', (_req: E2ERequest, res: E2EResponse) => {
      res.send('etag-payload');
    });

    const weakSrv = await trackServer(await startServer(weakApp));
    const strongSrv = await trackServer(await startServer(strongApp));
    const offSrv = await trackServer(await startServer(offApp));

    const setRes = await httpRequest(weakSrv.baseUrl, '/set-cookies');
    expect(setRes.status).toBe(200);
    const setCookies = normalizeSetCookie(setRes.headers['set-cookie']);
    const sessionCookie = setCookies.find((c) => c.startsWith('session='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('session=xyz');
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).toContain('Path=/app');
    expect(sessionCookie).toContain('Max-Age=60');
    expect(sessionCookie).toContain('Expires=');

    const prefsCookie = setCookies.find((c) => c.startsWith('prefs='));
    expect(prefsCookie).toBeDefined();
    expect(prefsCookie).toContain('prefs=j%3A');

    const clearRes = await httpRequest(weakSrv.baseUrl, '/clear-cookie');
    expect(clearRes.status).toBe(200);
    const clearCookies = normalizeSetCookie(clearRes.headers['set-cookie']);
    const cleared = clearCookies.find((c) => c.startsWith('session='));
    expect(cleared).toBeDefined();
    expect(cleared).toContain('session=;');
    expect(cleared).toContain('Path=/app');
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(cleared).not.toContain('Max-Age=');

    const weakFirst = await httpRequest(weakSrv.baseUrl, '/etag');
    expect(weakFirst.status).toBe(200);
    const weakEtag = String(weakFirst.headers.etag ?? '');
    expect(weakEtag.startsWith('W/"')).toBe(true);
    const weak304 = await httpRequest(weakSrv.baseUrl, '/etag', {
      headers: { 'If-None-Match': weakEtag },
    });
    expect(weak304.status).toBe(304);

    const strongFirst = await httpRequest(strongSrv.baseUrl, '/etag');
    expect(strongFirst.status).toBe(200);
    const strongEtag = String(strongFirst.headers.etag ?? '');
    expect(strongEtag.startsWith('"')).toBe(true);
    expect(strongEtag.startsWith('W/')).toBe(false);
    const strong304 = await httpRequest(strongSrv.baseUrl, '/etag', {
      headers: { 'If-None-Match': strongEtag },
    });
    expect(strong304.status).toBe(304);

    const offFirst = await httpRequest(offSrv.baseUrl, '/etag');
    expect(offFirst.status).toBe(200);
    expect(offFirst.headers.etag).toBeUndefined();
    const offAgain = await httpRequest(offSrv.baseUrl, '/etag', {
      headers: { 'If-None-Match': weakEtag },
    });
    expect(offAgain.status).toBe(200);
  });

  it('a middleware error reaches the error handler registered before the route', async () => {
    const app = createApp();
    app.use((req: E2ERequest, _res: E2EResponse, next: E2ENextFunction) => {
      next(req.get('x-fail') ? Object.assign(new Error('boom'), { status: 418 }) : undefined);
    });
    app.use(
      (err: Error & { status?: number }, _req: E2ERequest, res: E2EResponse, _next: E2ENextFunction) => {
        res.status(err.status ?? 500).send(`handled: ${err.message}`);
      }
    );
    app.get('/thing', (_req: E2ERequest, res: E2EResponse) => {
      res.send('ok');
    });

    const srv = await trackServer(await startServer(app));
    const ok = await httpRequest(srv.baseUrl, '/thing');
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('ok');
    const failed = await httpRequest(srv.baseUrl, '/thing', { headers: { 'X-Fail': '1' } });
    expect(failed.status).toBe(418);
    expect(failed.text).toBe('handled: boom');
  });

  it('res.statusCode reports 304 when res.send answers a conditional request', async () => {
    const app = createApp();
    const finished: number[] = [];
    app.use((_req: E2ERequest, res: E2EResponse, next: E2ENextFunction) => {
      res.on('finish', () => finished.push(res.statusCode));
      next();
    });
    app.get('/json', (_req: E2ERequest, res: E2EResponse) => {
      res.json({ a: 1 });
    });
    app.get('/text', (_req: E2ERequest, res: E2EResponse) => {
      res.set('X-Extra', '1').send('hello');
    });

    const srv = await trackServer(await startServer(app));
    for (const path of ['/json', '/text']) {
      const first = await httpRequest(srv.baseUrl, path);
      const etag = String(first.headers.etag);
      const cached = await httpRequest(srv.baseUrl, path, { headers: { 'If-None-Match': etag } });
      expect(cached.status).toBe(304);
      expect(cached.headers.etag).toBe(etag);
      expect(cached.headers['content-type']).toBeUndefined();
      expect(cached.text).toBe('');
      const stale = await httpRequest(srv.baseUrl, path, { headers: { 'If-None-Match': '"other"' } });
      expect(stale.status).toBe(200);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(finished).toEqual([200, 304, 200, 200, 304, 200]);
  });

  itRxpress(
    'built-in req.cookies parses Cookie header without cookie-parser',
    async () => {
      const app = createApp();
      app.get('/cookies', (req: E2ERequest, res: E2EResponse) => {
        res.json({ cookies: req.cookies });
      });

      const srv = await trackServer(await startServer(app));
      const res = await httpRequest(srv.baseUrl, '/cookies', {
        headers: {
          Cookie: 'a=1; b=hello%20world; quoted="v"',
        },
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toEqual({
        cookies: {
          a: '1',
          b: 'hello world',
          quoted: 'v',
        },
      });
    }
  );

  it('evaluates trust proxy (false, true, hop count, CIDR, fn) for req.ip/ips/protocol/secure/host', async () => {
    const makeProxyApp = (trustSetting: unknown) => {
      const app = createApp();
      app.set('trust proxy', trustSetting);
      app.get('/who', (req: E2ERequest, res: E2EResponse) => {
        res.json({
          ip: req.ip,
          ips: req.ips,
          protocol: req.protocol,
          secure: req.secure,
          host: req.host,
        });
      });
      return app;
    };

    const offSrv = await trackServer(await startServer(makeProxyApp(false)));
    const trueSrv = await trackServer(await startServer(makeProxyApp(true)));
    const hop1Srv = await trackServer(await startServer(makeProxyApp(1)));
    const cidrSrv = await trackServer(await startServer(makeProxyApp('127.0.0.1/8')));
    const fnSrv = await trackServer(
      await startServer(
        makeProxyApp((ip: string) => ip === '127.0.0.1' || ip === '10.0.0.1')
      )
    );

    const forwardedHeaders = {
      'X-Forwarded-For': '203.0.113.9, 10.0.0.1',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'proxy.test:8443',
    };

    const offRes = await httpRequest(offSrv.baseUrl, '/who', { headers: forwardedHeaders });
    expect(offRes.status).toBe(200);
    const offData = JSON.parse(offRes.text) as {
      ip: string;
      ips: string[];
      protocol: string;
      secure: boolean;
    };
    expect(offData.ip).toMatch(/^(127\.0\.0\.1|::ffff:127\.0\.0\.1|::1)$/);
    expect(offData.ips).toEqual([]);
    expect(offData.protocol).toBe('http');
    expect(offData.secure).toBe(false);

    const trueRes = await httpRequest(trueSrv.baseUrl, '/who', { headers: forwardedHeaders });
    expect(trueRes.status).toBe(200);
    expect(JSON.parse(trueRes.text)).toEqual({
      ip: '203.0.113.9',
      ips: ['203.0.113.9', '10.0.0.1'],
      protocol: 'https',
      secure: true,
      host: 'proxy.test:8443',
    });

    const hop1Res = await httpRequest(hop1Srv.baseUrl, '/who', { headers: forwardedHeaders });
    expect(hop1Res.status).toBe(200);
    expect(JSON.parse(hop1Res.text)).toMatchObject({
      ip: '10.0.0.1',
      ips: ['10.0.0.1'],
      protocol: 'https',
      secure: true,
    });

    const cidrRes = await httpRequest(cidrSrv.baseUrl, '/who', {
      headers: {
        'X-Forwarded-For': '203.0.113.9',
        'X-Forwarded-Proto': 'https',
      },
    });
    expect(cidrRes.status).toBe(200);
    expect(JSON.parse(cidrRes.text)).toMatchObject({
      ip: '203.0.113.9',
      ips: ['203.0.113.9'],
      protocol: 'https',
      secure: true,
    });

    const fnRes = await httpRequest(fnSrv.baseUrl, '/who', { headers: forwardedHeaders });
    expect(fnRes.status).toBe(200);
    expect(JSON.parse(fnRes.text)).toMatchObject({
      ip: '203.0.113.9',
      ips: ['203.0.113.9', '10.0.0.1'],
      protocol: 'https',
      secure: true,
    });
  });

  it('returns 406 Not Acceptable when res.format has no matching Accept and no default', async () => {
    const app = createApp();
    app.get('/only-json-html', (_req: E2ERequest, res: E2EResponse) => {
      res.format({
        'application/json': () => res.json({ ok: true }),
        'text/html': () => res.send('<p>ok</p>'),
      });
    });

    const srv = await trackServer(await startServer(app));
    const res = await fetch(`${srv.baseUrl}/only-json-html`, {
      headers: { Accept: 'application/xml' },
    });
    expect(res.status).toBe(406);
  });

  it('sanitizes dangerous characters in res.jsonp callback parameter', async () => {
    const app = createApp();
    app.get('/jsonp', (_req: E2ERequest, res: E2EResponse) => {
      res.jsonp({ ok: 1 });
    });

    const srv = await trackServer(await startServer(app));

    const r1 = await fetch(`${srv.baseUrl}/jsonp?callback=${encodeURIComponent('alert(1)//')}`);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('x-content-type-options')).toBe('nosniff');
    const b1 = await r1.text();
    expect(b1).not.toContain('alert(1)');
    expect(b1).toContain('alert1({"ok":1})');

    const r2 = await fetch(`${srv.baseUrl}/jsonp?callback=${encodeURIComponent('cb(1);')}`);
    expect(r2.status).toBe(200);
    const b2 = await r2.text();
    expect(b2).not.toContain('cb(1);');
    expect(b2).toContain('cb1({"ok":1})');
  });

  itRxpress(
    'res.jsonp falls back to plain JSON when callback is empty after sanitization',
    async () => {
      const app = createApp();
      app.get('/jsonp', (_req: E2ERequest, res: E2EResponse) => {
        res.jsonp({ ok: 1 });
      });

      const srv = await trackServer(await startServer(app));
      const res = await fetch(`${srv.baseUrl}/jsonp?callback=!!!`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({ ok: 1 });
    }
  );

  it('rejects invalid res.status codes and invalid res.cookie attributes or NaN maxAge', async () => {
    const app = createApp();

    app.get('/bad-status-low', (_req: E2ERequest, res: E2EResponse) => {
      res.status(99).send('x');
    });
    app.get('/bad-status-high', (_req: E2ERequest, res: E2EResponse) => {
      res.status(1000).send('x');
    });
    app.get('/bad-cookie-maxage', (_req: E2ERequest, res: E2EResponse) => {
      res.cookie('a', 'b', { maxAge: Number.NaN }).send('x');
    });
    app.get('/bad-cookie-domain', (_req: E2ERequest, res: E2EResponse) => {
      res.cookie('a', 'b', { domain: 'evil.com\r\nX-Inject: 1' }).send('x');
    });

    const errHandler: E2EErrorRequestHandler = (err, _req, res, _next) => {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ rejected: true, message });
    };
    app.use(errHandler);

    const srv = await trackServer(await startServer(app));

    for (const path of [
      '/bad-status-low',
      '/bad-status-high',
      '/bad-cookie-maxage',
      '/bad-cookie-domain',
    ]) {
      const res = await httpRequest(srv.baseUrl, path);
      expect(res.status).toBe(500);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['x-inject']).toBeUndefined();
      expect(JSON.parse(res.text)).toMatchObject({ rejected: true });
    }
  });

  itRxpress(
    'signs and verifies req.signedCookies while rejecting missing secret or tampered signatures',
    async () => {
      const SECRET = 'e2e-super-secret-hmac-key';

      const noSecretApp = createApp();
      noSecretApp.get('/sign-no-secret', (_req: E2ERequest, res: E2EResponse) => {
        res.cookie('sid', 'user-42', { signed: true }).send('ok');
      });
      const noSecretErr: E2EErrorRequestHandler = (err, _req, res, _next) => {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      };
      noSecretApp.use(noSecretErr);

      const app = createApp();
      app.set('cookie secret', SECRET);
      app.use((req: E2ERequest, _res: E2EResponse, next: E2ENextFunction) => {
        if (!req.secret) {
          req.secret = SECRET;
        }
        next();
      });

      app.get('/issue', (_req: E2ERequest, res: E2EResponse) => {
        res.cookie('sid', 'user-42', { signed: true, httpOnly: true }).send('issued');
      });

      app.get('/verify', (req: E2ERequest, res: E2EResponse) => {
        res.json({
          signedSid: req.signedCookies?.sid ?? null,
          rawSid: req.cookies.sid ?? null,
        });
      });

      const noSecretSrv = await trackServer(await startServer(noSecretApp));
      const noSecretRes = await httpRequest(noSecretSrv.baseUrl, '/sign-no-secret');
      expect(noSecretRes.status).toBe(500);

      const srv = await trackServer(await startServer(app));
      const issueRes = await httpRequest(srv.baseUrl, '/issue');
      expect(issueRes.status).toBe(200);
      const setCookies = normalizeSetCookie(issueRes.headers['set-cookie']);
      const sidHeader = setCookies.find((c) => c.startsWith('sid='));
      expect(sidHeader).toBeDefined();
      expect(sidHeader).toContain('s%3A');

      const cookiePair = sidHeader!.split(';')[0]!;
      const validRes = await httpRequest(srv.baseUrl, '/verify', {
        headers: { Cookie: cookiePair },
      });
      expect(validRes.status).toBe(200);
      expect(JSON.parse(validRes.text)).toMatchObject({ signedSid: 'user-42' });

      const tamperedValueCookie = cookiePair.replace('user-42', 'user-99');
      const tamperedValRes = await httpRequest(srv.baseUrl, '/verify', {
        headers: { Cookie: tamperedValueCookie },
      });
      expect(tamperedValRes.status).toBe(200);
      const tamperedValJson = JSON.parse(tamperedValRes.text) as { signedSid: unknown };
      expect([false, null]).toContain(tamperedValJson.signedSid);

      const dotIdx = cookiePair.lastIndexOf('.');
      const tamperedSigCookie =
        dotIdx !== -1 ? `${cookiePair.slice(0, dotIdx + 1)}BADHMAC` : `${cookiePair}BAD`;
      const tamperedSigRes = await httpRequest(srv.baseUrl, '/verify', {
        headers: { Cookie: tamperedSigCookie },
      });
      expect(tamperedSigRes.status).toBe(200);
      const tamperedSigJson = JSON.parse(tamperedSigRes.text) as { signedSid: unknown };
      expect([false, null]).toContain(tamperedSigJson.signedSid);
    }
  );

  it('applies req.accepts specificity tie-breaking and req.fresh with Last-Modified and Cache-Control: no-cache', async () => {
    const diagApp = createApp();
    diagApp.disable('etag');

    diagApp.get('/accepts-tie', (req: E2ERequest, res: E2EResponse) => {
      res.json({ best: req.accepts('text/plain', 'text/html') });
    });

    diagApp.get('/fresh-diag', (req: E2ERequest, res: E2EResponse) => {
      res.set('ETag', '"v1"');
      res.set('Last-Modified', 'Wed, 21 Oct 2015 07:28:00 GMT');
      const fresh = req.fresh;
      const stale = req.stale;
      res.removeHeader('ETag');
      res.removeHeader('Last-Modified');
      res.json({ fresh, stale });
    });

    const wireApp = createApp({ etagMode: 'weak' });
    wireApp.get('/wire-fresh', (_req: E2ERequest, res: E2EResponse) => {
      res.send('fresh-body');
    });

    const diagSrv = await trackServer(await startServer(diagApp));
    const wireSrv = await trackServer(await startServer(wireApp));

    const tieRes = await httpRequest(diagSrv.baseUrl, '/accepts-tie', {
      headers: { Accept: 'text/*, text/html' },
    });
    expect(tieRes.status).toBe(200);
    expect(JSON.parse(tieRes.text)).toEqual({ best: 'text/html' });

    const etagMatch = await httpRequest(diagSrv.baseUrl, '/fresh-diag', {
      headers: { 'If-None-Match': '"v1"' },
    });
    expect(JSON.parse(etagMatch.text)).toEqual({ fresh: true, stale: false });

    const etagNoCache = await httpRequest(diagSrv.baseUrl, '/fresh-diag', {
      headers: {
        'If-None-Match': '"v1"',
        'Cache-Control': 'no-cache',
      },
    });
    expect(JSON.parse(etagNoCache.text)).toEqual({ fresh: false, stale: true });

    const imsMatch = await httpRequest(diagSrv.baseUrl, '/fresh-diag', {
      headers: { 'If-Modified-Since': 'Thu, 22 Oct 2015 07:28:00 GMT' },
    });
    expect(JSON.parse(imsMatch.text)).toEqual({ fresh: true, stale: false });

    const imsNoCache = await httpRequest(diagSrv.baseUrl, '/fresh-diag', {
      headers: {
        'If-Modified-Since': 'Thu, 22 Oct 2015 07:28:00 GMT',
        'Cache-Control': 'no-cache',
      },
    });
    expect(JSON.parse(imsNoCache.text)).toEqual({ fresh: false, stale: true });

    const wireFirst = await httpRequest(wireSrv.baseUrl, '/wire-fresh');
    expect(wireFirst.status).toBe(200);
    const wireEtag = String(wireFirst.headers.etag ?? '');
    expect(wireEtag.length).toBeGreaterThan(0);

    const wire304 = await httpRequest(wireSrv.baseUrl, '/wire-fresh', {
      headers: { 'If-None-Match': wireEtag },
    });
    expect(wire304.status).toBe(304);

    const wireNoCache = await httpRequest(wireSrv.baseUrl, '/wire-fresh', {
      headers: {
        'If-None-Match': wireEtag,
        'Cache-Control': 'no-cache',
      },
    });
    expect(wireNoCache.status).toBe(200);
    expect(wireNoCache.text).toBe('fresh-body');
  });

  it('disables x-powered-by & etag and throws ERR_HTTP_HEADERS_SENT on setHeader after flushHeaders', async () => {
    const app = createApp();
    app.disable('x-powered-by').disable('etag');

    app.get('/disabled', (_req: E2ERequest, res: E2EResponse) => {
      res.send('no-powered-no-etag');
    });

    app.get('/after-flush', (_req: E2ERequest, res: E2EResponse) => {
      res.status(200);
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.flushHeaders();
      const sentBefore = res.headersSent;
      let caughtCode: string | null = null;
      try {
        res.setHeader('X-Late', '1');
      } catch (err) {
        caughtCode = (err as NodeJS.ErrnoException).code ?? 'ERROR';
      }
      res.end(JSON.stringify({ sentBefore, caughtCode }));
    });

    const srv = await trackServer(await startServer(app));

    const disabledRes = await httpRequest(srv.baseUrl, '/disabled');
    expect(disabledRes.status).toBe(200);
    expect(disabledRes.headers['x-powered-by']).toBeUndefined();
    expect(disabledRes.headers.etag).toBeUndefined();

    const flushRes = await httpRequest(srv.baseUrl, '/after-flush');
    expect(flushRes.status).toBe(200);
    expect(flushRes.headers['x-late']).toBeUndefined();
    expect(JSON.parse(flushRes.text)).toEqual({
      sentBefore: true,
      caughtCode: 'ERR_HTTP_HEADERS_SENT',
    });
  });
});
