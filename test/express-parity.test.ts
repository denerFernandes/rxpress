// Express 5 parity and hardening regressions.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import rxpress from '../js/index.js';
import { parseQueryString, parseUrlencodedBody, safeJsonParse } from '../js/security.js';

const require = createRequire(import.meta.url);
const qs = require('qs') as { parse(s: string, o?: object): unknown };

type Server = { close(): Promise<void> | void; address(): { port: number } };
const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function listen(app: ReturnType<typeof rxpress>): Promise<number> {
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s as unknown as Server)) as unknown as Server;
  });
  servers.push(srv);
  return srv.address().port;
}

function raw(port: number, payload: string, waitMs = 400): Promise<string> {
  return new Promise((resolve) => {
    const sock = createConnection(port, '127.0.0.1');
    let out = '';
    sock.on('data', (d) => (out += d.toString('latin1')));
    sock.on('error', () => resolve(out));
    sock.on('close', () => resolve(out));
    sock.write(payload);
    setTimeout(() => {
      sock.destroy();
      resolve(out);
    }, waitMs);
  });
}

/** Deep-compare ignoring prototypes (rxpress uses null-prototype containers). */
function plain(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v));
}

describe('qs parity (extended query/body parser)', () => {
  const cases = [
    'a[0]=x&a[1]=y',
    'a[0]=x&a[]=z',
    'a[]=z&a[0]=x',
    'a[1]=x&a[]=z',
    'a=1&a[]=2',
    'a[]=1&a=2',
    'a=1&a[b]=2',
    'a[b]=1&a=2',
    'a[b]=1&a[b]=2&a[c]=3',
    'a[0][b]=1&a[0][c]=2&a[1][b]=3',
    'a[20]=x',
    'a[19]=x',
    'a[1]=b&a[15]=c',
    'a[b][c][d][e][f][g][h]=1',
    'a[]=1&a[]=2&a[0]=3',
    'a%5B0%5D=x&a%5b1%5d=y',
    'a[=1',
    'a]=1',
    '[a]=1&[]=2',
    'a[b=1',
    'a[][b]=1&a[][c]=2',
    'x=1&x=2&x=3',
    Array.from({ length: 25 }, (_, i) => `a=${i}`).join('&'),
    Array.from({ length: 25 }, (_, i) => `a[]=${i}`).join('&'),
    'a=&b&=c&&d=1',
    'a+b=c+d&e%20f=%2',
  ];

  for (const c of cases) {
    it(`query ${JSON.stringify(c.length > 40 ? c.slice(0, 40) + '…' : c)} matches qs`, () => {
      const ours = parseQueryString(c, { mode: 'extended', parameterLimit: 1000, maxDepth: 5 });
      expect(plain(ours)).toEqual(plain(qs.parse(c, { allowPrototypes: true })));
    });
  }

  it('randomised bracket keys match qs (query and body option sets)', () => {
    let seed = 1234567;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const atoms = ['a', 'b', '0', '1', '2', '19', '20', '21', '', 'x'];
    for (let iter = 0; iter < 3000; iter++) {
      const parts: string[] = [];
      const np = 1 + rnd(6);
      for (let p = 0; p < np; p++) {
        let key = ['a', 'b', 'a'][rnd(3)];
        const depth = rnd(4);
        for (let d = 0; d < depth; d++) key += `[${atoms[rnd(atoms.length)]}]`;
        parts.push(`${key}=${rnd(10)}`);
      }
      const s = parts.join('&');
      const ours = parseQueryString(s, { mode: 'extended', parameterLimit: 1000, maxDepth: 5 });
      expect(plain(ours), s).toEqual(plain(qs.parse(s, { allowPrototypes: true })));
      const body = parseUrlencodedBody(s, true, 1000, np);
      const ref = qs.parse(s, {
        allowPrototypes: true,
        arrayLimit: Math.max(100, np),
        depth: 32,
        parameterLimit: 1000,
        strictDepth: true,
      });
      expect(plain(body), s).toEqual(plain(ref));
    }
  });

  it('handles prototype keys exactly like qs: only __proto__ is dropped, nothing is polluted', () => {
    const s = '__proto__[x]=1&a[constructor][prototype]=2&b[__proto__]=3&c=ok&hasOwnProperty=4';
    const q = parseQueryString(s, { mode: 'extended' });
    expect(plain(q)).toEqual(plain(qs.parse(s, { allowPrototypes: true })));
    expect(plain(q)).toEqual({ a: { constructor: { prototype: '2' } }, b: {}, c: 'ok', hasOwnProperty: '4' });
    expect(Object.getPrototypeOf(q)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(q, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('JSON bodies keep __proto__ as an own key like body-parser (JSON.parse)', () => {
    const src = '{"__proto__":{"polluted":1},"a":{"__proto__":{"y":2}},"ok":true}';
    const ours = safeJsonParse(src) as Record<string, unknown>;
    expect(plain(ours)).toEqual(plain(JSON.parse(src)));
    expect(Object.prototype.hasOwnProperty.call(ours, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(ours)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('urlencoded bodies deeper than 32 levels are a 400 (body-parser strictDepth)', () => {
    const key = 'a' + '[b]'.repeat(40);
    expect(() => parseUrlencodedBody(`${key}=1`, true, 1000, 1)).toThrow(
      expect.objectContaining({ status: 400, type: 'querystring.parse.rangeError' })
    );
  });

  it('req.query yields arrays for indexed keys end-to-end', async () => {
    const app = rxpress();
    app.set('query parser', 'extended'); // Express 5 defaults to 'simple'
    app.get('/q', (req, res) => {
      res.json(req.query);
    });
    const port = await listen(app);
    const r = await fetch(`http://127.0.0.1:${port}/q?a[0]=x&a[1]=y&b=1&b[]=2`);
    expect(await r.json()).toEqual({ a: ['x', 'y'], b: ['1', '2'] });
  });
});

describe('route params', () => {
  it('malformed percent-encoding in a param is a 400 on both the fast path and the router', async () => {
    const app = rxpress();
    app.get('/p/:id', (req, res) => {
      res.json(req.params);
    });
    app.use((req, res, next) => next()); // forces later routes through the JS router
    app.get('/r/:id', (req, res) => {
      res.json(req.params);
    });
    let seen: { status?: number; message?: string } | undefined;
    app.use(
      (
        err: { status?: number; message?: string },
        _req: unknown,
        res: { status(n: number): { send(s: string): void } },
        _next: unknown
      ) => {
        seen = err;
        res.status(err.status ?? 500).send('bad');
      }
    );
    const port = await listen(app);
    for (const base of ['/p/', '/r/']) {
      for (const bad of ['%', '%E0%A4%A', '%zz', '%FF']) {
        const r = await fetch(`http://127.0.0.1:${port}${base}${bad}`);
        expect(r.status, base + bad).toBe(400);
        expect(seen?.message).toBe(`Failed to decode param '${bad}'`);
      }
      const ok = await fetch(`http://127.0.0.1:${port}${base}a%20b`);
      expect(await ok.json()).toEqual({ id: 'a b' });
    }
  });

  it('named wildcards are arrays of decoded segments (Express 5)', async () => {
    const app = rxpress();
    app.get('/w/*rest', (req, res) => {
      res.json(req.params);
    });
    const sub = rxpress.Router();
    sub.get('/x/*rest', (req, res) => {
      res.json(req.params);
    });
    app.use('/sub', sub);
    const port = await listen(app);
    const get = async (p: string) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
    expect(await get('/w/a')).toEqual({ rest: ['a'] });
    expect(await get('/w/a/b')).toEqual({ rest: ['a', 'b'] });
    expect(await get('/w/a/b%2Fc')).toEqual({ rest: ['a', 'b/c'] });
    expect(await get('/sub/x/a/b')).toEqual({ rest: ['a', 'b'] });
  });
});

describe('engine', () => {
  it('a client that disconnects mid-handler fires req aborted/close and res close', async () => {
    const app = rxpress();
    const events: string[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    app.get('/poll', (req, res) => {
      req.on('aborted', () => events.push('req.aborted'));
      req.on('close', () => events.push('req.close'));
      res.on('close', () => {
        events.push('res.close');
        done();
      });
      setTimeout(() => {
        if (!res.headersSent) res.send('late');
      }, 1500);
    });
    const port = await listen(app);
    await raw(port, 'GET /poll HTTP/1.1\r\nHost: a\r\n\r\n', 100);
    await finished;
    expect(events).toEqual(expect.arrayContaining(['req.aborted', 'req.close', 'res.close']));
  });

  it('chunks written before destroy() reach the client, without a chunked terminator', async () => {
    const app = rxpress();
    app.get('/s', (_req, res) => {
      res.status(200);
      res.flushHeaders();
      res.write('chunk1');
      res.destroy();
    });
    const port = await listen(app);
    const out = await raw(port, 'GET /s HTTP/1.1\r\nHost: a\r\n\r\n');
    expect(out).toContain('chunk1');
    expect(out).not.toContain('\r\n0\r\n\r\n');
  });

  it('rejects bare-LF request heads with 400', async () => {
    const app = rxpress();
    app.get('/', (_req, res) => {
      res.send('ok');
    });
    const port = await listen(app);
    const out = await raw(port, 'GET / HTTP/1.1\nHost: a\n\n');
    expect(out.startsWith('HTTP/1.1 400')).toBe(true);
  });

  it('routes absolute-form request targets on their path', async () => {
    const app = rxpress();
    app.get('/abs', (req, res) => {
      res.send(req.path);
    });
    const port = await listen(app);
    const out = await raw(
      port,
      'GET http://example.com/abs HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'
    );
    expect(out.startsWith('HTTP/1.1 200')).toBe(true);
    expect(out.endsWith('/abs')).toBe(true);
  });
});

describe('body parsers (body-parser@2 parity)', () => {
  async function bodyApp() {
    const app = rxpress();
    app.use(rxpress.json({ limit: '1kb' }));
    app.use(rxpress.text());
    app.use(rxpress.urlencoded({ extended: true }));
    app.post('/b', (req, res) => {
      res.json({ b: req.body });
    });
    app.use(
      (
        err: { status?: number; type?: string },
        _req: unknown,
        res: { status(n: number): { json(v: unknown): void } },
        _next: unknown
      ) => {
        res.status(err.status ?? 500).json({ err: err.type });
      }
    );
    return `http://127.0.0.1:${await listen(app)}/b`;
  }
  const post = (url: string, body: Buffer | string, headers: Record<string, string>) =>
    fetch(url, { method: 'POST', body, headers });

  it('inflates gzip, deflate and br bodies', async () => {
    const url = await bodyApp();
    const json = Buffer.from('{"a":1}');
    for (const [enc, data] of [
      ['gzip', gzipSync(json)],
      ['deflate', deflateSync(json)],
      ['br', brotliCompressSync(json)],
    ] as const) {
      const r = await post(url, data, {
        'Content-Type': 'application/json',
        'Content-Encoding': enc,
      });
      expect(await r.json(), enc).toEqual({ b: { a: 1 } });
    }
  });

  it('unknown Content-Encoding is a 415, corrupt data a 400, a bomb a 413', async () => {
    const url = await bodyApp();
    const ct = { 'Content-Type': 'application/json' };
    let r = await post(url, '{"a":1}', { ...ct, 'Content-Encoding': 'compress' });
    expect([r.status, await r.json()]).toEqual([415, { err: 'encoding.unsupported' }]);
    r = await post(url, 'not gzip', { ...ct, 'Content-Encoding': 'gzip' });
    expect(r.status).toBe(400);
    const bomb = gzipSync(Buffer.from('{"a":"' + 'x'.repeat(200_000) + '"}'));
    expect(bomb.length).toBeLessThan(1024);
    r = await post(url, bomb, { ...ct, 'Content-Encoding': 'gzip' });
    expect([r.status, await r.json()]).toEqual([413, { err: 'entity.too.large' }]);
  });

  it('JSON: non-UTF charsets are a 415 and a UTF-8 BOM is accepted', async () => {
    const url = await bodyApp();
    let r = await post(url, '{"a":1}', { 'Content-Type': 'application/json; charset=latin1' });
    expect([r.status, await r.json()]).toEqual([415, { err: 'charset.unsupported' }]);
    r = await post(url, '\uFEFF{"a":1}', { 'Content-Type': 'application/json' });
    expect(await r.json()).toEqual({ b: { a: 1 } });
  });

  it('text bodies are decoded with the declared charset', async () => {
    const url = await bodyApp();
    let r = await post(url, Buffer.from([0x63, 0x61, 0x66, 0xe9]), {
      'Content-Type': 'text/plain; charset=iso-8859-1',
    });
    expect(await r.json()).toEqual({ b: 'café' });
    r = await post(url, 'x', { 'Content-Type': 'text/plain; charset=nope-42' });
    expect([r.status, await r.json()]).toEqual([415, { err: 'charset.unsupported' }]);
  });

  it('urlencoded rejects charsets other than utf-8 / iso-8859-1 with 415', async () => {
    const url = await bodyApp();
    const r = await post(url, 'a=1', {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-16',
    });
    expect([r.status, await r.json()]).toEqual([415, { err: 'charset.unsupported' }]);
  });

  it('a verify hook that throws a plain Error is a 403 entity.verify.failed', async () => {
    const app = rxpress();
    app.use(
      rxpress.json({
        verify: () => {
          throw new Error('bad signature');
        },
      })
    );
    app.post('/v', (_req, res) => {
      res.send('unreachable');
    });
    app.use(
      (
        err: { status?: number; type?: string },
        _req: unknown,
        res: { status(n: number): { json(v: unknown): void } },
        _next: unknown
      ) => {
        res.status(err.status ?? 500).json({ err: err.type });
      }
    );
    const port = await listen(app);
    const r = await post(`http://127.0.0.1:${port}/v`, '{}', { 'Content-Type': 'application/json' });
    expect([r.status, await r.json()]).toEqual([403, { err: 'entity.verify.failed' }]);
  });
});

describe('response helpers (Express 5 parity)', () => {
  it('res.redirect negotiates text/html, sets Vary and never echoes the raw URL', async () => {
    const app = rxpress();
    app.get('/r', (req, res) => {
      res.redirect(String(req.query.to));
    });
    const port = await listen(app);
    const to = encodeURIComponent('/a"><img src=x>');
    const html = await fetch(`http://127.0.0.1:${port}/r?to=${to}`, {
      redirect: 'manual',
      headers: { Accept: 'text/html' },
    });
    expect(html.status).toBe(302);
    expect(html.headers.get('vary')).toBe('Accept');
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const body = await html.text();
    expect(body).not.toContain('<img');
    expect(body).toContain('Found. Redirecting to /a%22%3E%3Cimg%20src=x%3E');
    const none = await fetch(`http://127.0.0.1:${port}/r?to=/x`, {
      redirect: 'manual',
      headers: { Accept: 'image/png' },
    });
    expect(await none.text()).toBe('');
  });

  it('res.location does not double-encode existing escapes (encodeurl)', async () => {
    const app = rxpress();
    app.get('/l', (_req, res) => {
      res.location('/a%20b/ç?x=%zz').end();
    });
    const port = await listen(app);
    const r = await fetch(`http://127.0.0.1:${port}/l`, { redirect: 'manual' });
    expect(r.headers.get('location')).toBe('/a%20b/%C3%A7?x=%25zz');
  });

  it('writeHead accepts a flat raw header array and does not rewrite Content-Type', async () => {
    const app = rxpress();
    app.get('/w', (_req, res) => {
      res.writeHead(200, ['Content-Type', 'text/plain', 'X-A', '1', 'X-A', '2']);
      res.end('ok');
    });
    const port = await listen(app);
    const out = await raw(port, 'GET /w HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n');
    expect(out).toMatch(/content-type: text\/plain\r\n/i);
    expect(out).toMatch(/x-a: 1(\r\nx-a: 2|, 2)/i);
  });
});

describe.skipIf(process.platform === 'win32')('static files', () => {
  it('a FIFO under the static root is a 404 and does not pin the server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rx-fifo-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'hello');
      execFileSync('mkfifo', [join(dir, 'pipe')]);
      const app = rxpress();
      app.use('/s', rxpress.static(dir));
      const port = await listen(app);
      const t0 = Date.now();
      const r = await fetch(`http://127.0.0.1:${port}/s/pipe`);
      expect(r.status).toBe(404);
      expect(await (await fetch(`http://127.0.0.1:${port}/s/a.txt`)).text()).toBe('hello');
      expect(Date.now() - t0).toBeLessThan(2000);
      const closing = Date.now();
      await servers.pop()!.close();
      expect(Date.now() - closing).toBeLessThan(2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Express 5 parity follow-ups', () => {
  it('default 404 is the finalhandler HTML page with the encoded original URL', async () => {
    const app = rxpress();
    const port = await listen(app);
    const r = await fetch(`http://127.0.0.1:${port}/x%20y/<b>?q=1`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(await r.text()).toBe(
      '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n' +
        '</head>\n<body>\n<pre>Cannot GET /x%20y/%3Cb%3E</pre>\n</body>\n</html>\n'
    );
  });

  it('automatic OPTIONS answers like router@2 (sorted, ", "-joined Allow)', async () => {
    const app = rxpress();
    app.post('/o', (_req, res) => {
      res.end();
    });
    app.get('/o', (_req, res) => {
      res.end();
    });
    const port = await listen(app);
    const r = await fetch(`http://127.0.0.1:${port}/o`, { method: 'OPTIONS' });
    expect(r.headers.get('allow')).toBe('GET, HEAD, POST');
    expect(r.headers.get('content-type')).toBe('text/plain');
    expect(await r.text()).toBe('GET, HEAD, POST');
  });

  it('a custom statusMessage reaches the wire on buffered and streamed responses', async () => {
    const app = rxpress();
    app.get('/a', (_req, res) => {
      res.statusMessage = 'Custom Thing';
      res.send('x');
    });
    app.get('/b', (_req, res) => {
      res.writeHead(201, 'Made It');
      res.end('y');
    });
    app.get('/s', (_req, res) => {
      res.statusMessage = 'Streamy';
      res.write('a');
      res.end('b');
    });
    app.get('/d', (_req, res) => {
      res.statusCode = 418;
      res.end();
    });
    const port = await listen(app);
    const line = async (p: string) =>
      (await raw(port, `GET ${p} HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n`)).split('\r\n')[0];
    expect(await line('/a')).toBe('HTTP/1.1 200 Custom Thing');
    expect(await line('/b')).toBe('HTTP/1.1 201 Made It');
    expect(await line('/s')).toBe('HTTP/1.1 200 Streamy');
    expect(await line('/d')).toBe("HTTP/1.1 418 I'm a Teapot");
  });

  it('an over-limit body reaches the app error middleware as 413 entity.too.large', async () => {
    const app = rxpress();
    app.use(rxpress.json({ limit: '1kb' }));
    app.post('/j', (_req, res) => {
      res.send('unreachable');
    });
    app.use(
      (
        err: { status?: number; type?: string },
        _req: unknown,
        res: { status(n: number): { json(v: unknown): void } },
        _next: unknown
      ) => {
        res.status(err.status ?? 500).json({ err: err.type });
      }
    );
    const port = await listen(app);
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/j`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: 'x'.repeat(2_000_000) }),
      });
      expect([r.status, await r.json()]).toEqual([413, { err: 'entity.too.large' }]);
    }
  });

  it('HTTP/1.0 keep-alive requests get Connection: keep-alive and stay open', async () => {
    const app = rxpress();
    app.get('/k', (_req, res) => {
      res.send('ok');
    });
    const port = await listen(app);
    const out = await raw(
      port,
      'GET /k HTTP/1.0\r\nConnection: keep-alive\r\n\r\nGET /k HTTP/1.0\r\nConnection: keep-alive\r\n\r\n'
    );
    expect(out.match(/Connection: keep-alive/gi)?.length).toBe(2);
    expect(out.match(/\r\n\r\nok/g)?.length).toBe(2);
  });
});
