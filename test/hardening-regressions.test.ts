import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import rxpress from '../js/index.js';
const requireCjs = createRequire(import.meta.url);
const typeis = requireCjs('type-is');
const Negotiator = requireCjs('negotiator');

const servers: Array<{ close: () => unknown }> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function start(app: ReturnType<typeof rxpress>) {
  const s = app.listen(0, '127.0.0.1');
  servers.push(s);
  const port = s.address()!.port;
  return { port, base: `http://127.0.0.1:${port}` };
}

function raw(port: number, payload: string, ms = 3000): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const sock = createConnection({ host: '127.0.0.1', port }, () => sock.write(payload));
    const t = setTimeout(() => { sock.destroy(); resolve('TIMEOUT:' + Buffer.concat(chunks).toString()); }, ms);
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => { clearTimeout(t); resolve(Buffer.concat(chunks).toString()); });
    sock.on('error', () => { clearTimeout(t); resolve('ERR'); });
  });
}

describe('regressions: framing, lifecycle and parsing edge cases', () => {
  it('Object.freeze(res) before res.send() answers once and keeps the pipeline flowing', async () => {
    const app = rxpress();
    app.get('/f', (_q, res) => { Object.freeze(res); res.send('x'); });
    app.get('/ok', (_q, res) => res.send('ok'));
    const { port } = start(app);
    const r = await raw(port, 'GET /f HTTP/1.1\r\nHost: a\r\n\r\nGET /ok HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n');
    expect(r.startsWith('TIMEOUT')).toBe(false);
    expect(r).toContain('ok');
  });
  it('Object.freeze(req) before next() does not hang the request', async () => {
    const app = rxpress();
    app.use((req, _res, next) => { Object.freeze(req); next(); });
    app.get('/', (_q, res) => res.send('ok'));
    const { port } = start(app);
    const r = await raw(port, 'GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n');
    expect(r.startsWith('TIMEOUT')).toBe(false);
  });
  it('own accessor trap on req.app is not reused by the pool', async () => {
    const app = rxpress();
    app.get('/p', (req, res) => {
      Object.defineProperty(req, 'app', { configurable: true, get() { return { fake: true }; }, set() {} });
      res.send('p');
    });
    app.get('/c', (req, res) => res.send(String(req.app === app)));
    const { port } = start(app);
    const r = await raw(port, 'GET /p HTTP/1.1\r\nHost: a\r\n\r\nGET /c HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n');
    expect(r).toContain('true');
    expect(r).not.toMatch(/\r\n\r\nfalse/);
  });
  it('native body-limit rules honour case-insensitive routing', async () => {
    const app = rxpress();
    app.post('/upload', rxpress.json({ limit: '5mb' }), (req, res) => res.json({ n: JSON.stringify(req.body).length }));
    const { base } = start(app);
    const body = JSON.stringify({ a: 'x'.repeat(1700 * 1024) });
    const r = await fetch(`${base}/UPLOAD`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(r.status).toBe(200);
  });
  it('extended query appends [] after a[length] at the next free index (qs parity)', async () => {
    const app = rxpress();
    app.set('query parser', 'extended'); // Express 5 defaults to 'simple'
    app.get('/q', (req, res) => res.json(req.query));
    const { base } = start(app);
    const j = (await (await fetch(`${base}/q?a[]=1&a[length]=foo&a[]=2`)).json()) as any;
    expect(Object.keys(j.a)).not.toContain('');
  });
  it('req.is() +suffix/shorthand/no-content-type parity', async () => {
    const app = rxpress();
    app.post('/is', (req, res) => res.json({
      suffixOnPlain: req.is('+json'),
      jsonOnSuffix: req.is('json'),
      starOnSuffix: req.is('*/json'),
    }));
    app.post('/is2', (req, res) => res.json({ v: req.is('json') }));
    const { base, port } = start(app);
    const a = (await (await fetch(`${base}/is`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as any;
    expect(a.suffixOnPlain).toBe(false);
    const b = (await (await fetch(`${base}/is`, { method: 'POST', headers: { 'content-type': 'application/vnd.api+json' }, body: '{}' })).json()) as any;
    expect(b.jsonOnSuffix).toBe(false);
    expect(b.starOnSuffix).toBe(false);
    const r = await raw(port, 'POST /is2 HTTP/1.1\r\nHost: a\r\nContent-Length: 2\r\nConnection: close\r\n\r\nab');
    expect(r).toContain('{"v":false}');
  });
  it('hooked writeHead observes implied content-type and content-length', async () => {
    const app = rxpress();
    let seen: unknown[] = [];
    app.use((_req, res, next) => {
      const orig = res.writeHead;
      (res as any).writeHead = function (...args: unknown[]) {
        seen = [res.getHeader('content-type'), res.getHeader('content-length')];
        return (orig as any).apply(this, args);
      };
      next();
    });
    app.get('/', (_q, res) => res.send('hello'));
    const { base } = start(app);
    await (await fetch(base)).text();
    expect(String(seen[0])).toMatch(/text\/html/);
    expect(Number(seen[1])).toBe(5);
  });
  it('zero-arg req.accepts() drops q=0 and sorts by q', async () => {
    const app = rxpress();
    app.get('/', (req, res) => res.json(req.accepts()));
    const { base } = start(app);
    const j = (await (await fetch(base, { headers: { accept: 'text/html;q=0.5, application/json, image/png;q=0' } })).json()) as any;
    expect(j).toEqual(['application/json', 'text/html']);
  });

  it('req.is() matches type-is across shapes', async () => {
    const cases: Array<[string, string[]]> = [['application/json',['+json']],['application/vnd.api+json',['json']],['application/vnd.api+json',['*/json']],['application/vnd.api+json',['+json']],['application/vnd.api+json',['*/*+json']],['application/json',['json']],['text/html; charset=utf-8',['html']],['multipart/form-data; boundary=x',['multipart']],['application/x-www-form-urlencoded',['urlencoded']],['text/plain',['text/*']],['application/json',[]],['application/json',['application/*']],['image/svg+xml',['svg']],['application/json',['text','json']],['not a mime',['json']]];
    const app = rxpress();
    app.post('/', (req, res) => res.json({ v: req.is(JSON.parse(String(req.get('x-types')))) }));
    const { base } = start(app);
    for (const [ct, types] of cases) {
      const r = (await (await fetch(base, { method: 'POST', headers: { 'content-type': ct, 'x-types': JSON.stringify(types) }, body: 'x' })).json()) as any;
      expect([ct, types, r.v]).toEqual([ct, types, typeis.is(ct, types)]);
    }
  });

  it('req.accepts()/acceptsLanguages() match negotiator (invalid q = 0)', async () => {
    const headers = ['text/html;q=0.5, application/json, image/png;q=0', 'a/b;q=abc, c/d', '*/*;q=-1, text/plain', 'text/*;q=0.3, text/html;q=0.7, */*;q=0.1', 'application/json;q=1.0, text/html;q=1'];
    const app = rxpress();
    app.get('/', (req, res) => res.json({
      all: req.accepts(),
      pick: req.accepts(['json', 'html', 'text/plain', 'image/png', 'a/b', 'c/d']),
      enc: req.acceptsEncodings(),
      lang: req.acceptsLanguages(),
    }));
    const { base } = start(app);
    for (const h of headers) {
      const r = (await (await fetch(base, { headers: { accept: h, 'accept-encoding': 'gzip;q=x, br', 'accept-language': 'en;q=nan, pt' } })).json()) as any;
      const n = new Negotiator({ headers: { accept: h, 'accept-encoding': 'gzip;q=x, br', 'accept-language': 'en;q=nan, pt' } });
      expect([h, r.all]).toEqual([h, n.mediaTypes()]);
      const types = ['application/json', 'text/html', 'text/plain', 'image/png', 'a/b', 'c/d'];
      const best = n.mediaTypes(types)[0];
      const shorthand = ['json', 'html', 'text/plain', 'image/png', 'a/b', 'c/d'];
      expect([h, r.pick]).toEqual([h, best === undefined ? false : shorthand[types.indexOf(best)]]);
      expect(r.lang).toEqual(n.languages());
    }
  });

  it('CommonJS consumers type-check Router/Route/handler types from dist/index.d.cts', () => {
    const root = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'rxpress-cjs-dts-'));
    try {
      mkdirSync(join(dir, 'node_modules'));
      symlinkSync(root, join(dir, 'node_modules', 'rxpress'), 'dir');
      writeFileSync(join(dir, 'package.json'), '{"name":"consumer","type":"commonjs"}');
      writeFileSync(
        join(dir, 'a.ts'),
        [
          "import rxpress = require('rxpress');",
          "import type { Router, Route, Request, ErrorRequestHandler } from 'rxpress';",
          "import { createRouter } from 'rxpress';",
          'const app = rxpress();',
          'const r: Router = rxpress.Router();',
          'const r2: Router = createRouter();',
          "r.get('/x', (req: Request, res) => { res.send(req.path); });",
          "const route: Route = r.route('/y');",
          "const eh: ErrorRequestHandler<Error> = (e, _q, res, _n) => { res.status(500).send(e.message); };",
          "app.use('/r', r, r2);",
          "app.use(rxpress.json(), rxpress.static('.'));",
          'app.use(eh);',
          'void route;',
        ].join('\n')
      );
      execFileSync(
        process.execPath,
        [
          join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
          '--strict', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext',
          '--moduleResolution', 'NodeNext', '--skipLibCheck', 'false',
          '--typeRoots', join(root, 'node_modules', '@types'), '--types', 'node', 'a.ts',
        ],
        { cwd: dir, stdio: 'pipe' }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
