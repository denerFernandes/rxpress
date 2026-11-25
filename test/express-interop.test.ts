// The request is a real readable stream over the buffered body, the
// connection is a `net.Socket`-shaped emitter, and the app exposes the `net.Server` bits that
// supertest's `listen(0)` flow uses. Third-party middleware here comes straight from node_modules.
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import rxpress, { RxServer } from '../js/index.js';

const require = createRequire(import.meta.url);
type Mw = (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
const bodyParser = require('body-parser') as {
  json(o?: object): Mw;
  urlencoded(o?: object): Mw;
  text(o?: object): Mw;
  raw(o?: object): Mw;
};
const getRawBody = require('raw-body') as (
  stream: unknown,
  opts: object,
  cb: (err: (Error & { status?: number; type?: string }) | null, body?: Buffer | string) => void
) => void;
const onFinished = require('on-finished') as {
  (msg: unknown, cb: (err: unknown, msg: unknown) => void): void;
  isFinished(msg: unknown): boolean;
};

type App = ReturnType<typeof rxpress>;
type Server = { close(): Promise<void> | void; address(): { port: number } };
const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function listen(app: App): Promise<string> {
  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s as unknown as Server)) as unknown as Server;
  });
  servers.push(srv);
  return `http://127.0.0.1:${srv.address().port}`;
}

function post(base: string, path: string, body: string, type = 'application/json') {
  return fetch(base + path, { method: 'POST', headers: { 'content-type': type }, body });
}

describe('app as a net.Server (supertest listen(0) flow)', () => {
  it('address()/listening/close() work on the app itself, repeatedly', async () => {
    const app = rxpress();
    app.use(rxpress.json());
    app.post('/b', (req, res) => res.status(201).json(req.body));

    for (let i = 0; i < 3; i++) {
      expect(app.address()).toBeNull();
      await new Promise<void>((resolve, reject) => {
        app.once('listening', () => resolve());
        app.once('error', reject);
        app.listen(0, '127.0.0.1');
      });
      const addr = app.address()!;
      expect(addr.port).toBeGreaterThan(0);
      const r = await post(`http://127.0.0.1:${addr.port}`, '/b', `{"i":${i}}`);
      expect(r.status).toBe(201);
      expect(await r.json()).toEqual({ i });
      let closeEvents = 0;
      app.once('close', () => closeEvents++);
      await new Promise<void>((resolve) => app.close(() => resolve()));
      expect(closeEvents).toBe(1);
      expect(app.address()).toBeNull();
    }
  });

  it('close() without a running server reports ERR_SERVER_NOT_RUNNING', async () => {
    const err = await new Promise<NodeJS.ErrnoException | undefined>((resolve) =>
      rxpress().close((e) => resolve(e as NodeJS.ErrnoException))
    );
    expect(err?.code).toBe('ERR_SERVER_NOT_RUNNING');
  });
});

describe('npm body-parser / raw-body on rxpress requests', () => {
  it('body-parser json, urlencoded, text and raw parse the body', async () => {
    const app = rxpress();
    app.post('/json', bodyParser.json() as never, (req, res) => res.json({ body: req.body }));
    app.post('/form', bodyParser.urlencoded({ extended: true }) as never, (req, res) =>
      res.json({ body: req.body })
    );
    app.post('/text', bodyParser.text() as never, (req, res) => res.json({ body: req.body }));
    app.post('/raw', bodyParser.raw() as never, (req, res) =>
      res.json({ isBuf: Buffer.isBuffer(req.body), len: (req.body as Buffer).length })
    );
    const base = await listen(app);

    expect(await (await post(base, '/json', '{"k":[1,2]}')).json()).toEqual({ body: { k: [1, 2] } });
    expect(
      await (await post(base, '/form', 'a[b]=1&c=2', 'application/x-www-form-urlencoded')).json()
    ).toEqual({ body: { a: { b: '1' }, c: '2' } });
    expect(await (await post(base, '/text', 'hello', 'text/plain')).json()).toEqual({ body: 'hello' });
    expect(
      await (await post(base, '/raw', 'abcd', 'application/octet-stream')).json()
    ).toEqual({ isBuf: true, len: 4 });
  });

  it('body-parser errors (bad JSON, over limit) reach error middleware like in Express', async () => {
    const app = rxpress();
    app.post('/j', bodyParser.json({ limit: 10 }) as never, (_req, res) => res.send('no'));
    app.use(((err: { status: number; type: string }, _req: unknown, res: { status(n: number): { json(v: unknown): void } }, _next: unknown) => {
      void _next;
      res.status(err.status).json({ type: err.type });
    }) as never);
    const base = await listen(app);

    const bad = await post(base, '/j', '{bad');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ type: 'entity.parse.failed' });
    const big = await post(base, '/j', JSON.stringify({ k: 'x'.repeat(50) }));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ type: 'entity.too.large' });
  });

  it('body-parser after rxpress.json() sees the body as already read (no hang, body kept)', async () => {
    const app = rxpress();
    app.use(rxpress.json());
    app.post('/x', bodyParser.json() as never, (req, res) =>
      res.json({ body: req.body, finished: onFinished.isFinished(req) })
    );
    const base = await listen(app);
    const r = await post(base, '/x', '{"a":1}');
    expect(await r.json()).toEqual({ body: { a: 1 }, finished: true });
  });

  it('raw-body reads the request and enforces length/limit', async () => {
    const app = rxpress();
    app.post('/rb', (req, res) => {
      getRawBody(req, { length: req.headers['content-length'], limit: '1kb', encoding: 'utf8' }, (err, body) => {
        if (err) return void res.status(err.status ?? 500).send(err.type ?? 'err');
        res.send(`got:${body}`);
      });
    });
    const base = await listen(app);
    expect(await (await post(base, '/rb', 'payload', 'text/x-custom')).text()).toBe('got:payload');
    const big = await post(base, '/rb', 'x'.repeat(2000), 'text/x-custom');
    expect(big.status).toBe(413);
    expect(await big.text()).toBe('entity.too.large');
  });
});

describe('req as a Readable', () => {
  it("on('data')/on('end') deliver the body; empty bodies just end", async () => {
    const app = rxpress();
    app.all('/d', (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () =>
        res.json({ body: Buffer.concat(chunks).toString(), ended: req.readableEnded, readable: req.readable })
      );
    });
    const base = await listen(app);
    expect(await (await post(base, '/d', 'abc', 'text/x-custom')).json()).toEqual({
      body: 'abc',
      ended: true,
      readable: false,
    });
    expect(await (await fetch(base + '/d')).json()).toEqual({ body: '', ended: true, readable: false });
  });

  it('pipe() into a PassThrough, into res (echo) and into a slow writable (backpressure)', async () => {
    const app = rxpress();
    app.post('/pt', (req, res) => {
      const pt = new PassThrough();
      const out: Buffer[] = [];
      pt.on('data', (c: Buffer) => out.push(c));
      pt.on('end', () => res.send(`pt:${Buffer.concat(out).toString()}`));
      req.pipe(pt);
    });
    app.post('/echo', (req, res) => {
      res.type('text/plain');
      req.pipe(res as never);
    });
    app.post('/slow', (req, res) => {
      let n = 0;
      const sink = new Writable({
        highWaterMark: 1,
        write(chunk: Buffer, _enc, cb) {
          n += chunk.length;
          setTimeout(cb, 5);
        },
      });
      sink.on('finish', () => res.send(`slow:${n}`));
      req.pipe(sink);
    });
    const base = await listen(app);
    expect(await (await post(base, '/pt', 'hello', 'text/x-custom')).text()).toBe('pt:hello');
    expect(await (await post(base, '/echo', 'mirror', 'text/x-custom')).text()).toBe('mirror');
    expect(await (await post(base, '/slow', 'x'.repeat(5000), 'text/x-custom')).text()).toBe(
      'slow:5000'
    );
  });

  it("for await, setEncoding and the paused-mode 'readable'/read() loop", async () => {
    const app = rxpress();
    app.post('/iter', async (req, res) => {
      let s = '';
      for await (const c of req) s += (c as Buffer).toString();
      res.send(`iter:${s}`);
    });
    app.post('/enc', (req, res) => {
      req.setEncoding('utf8');
      let s = '';
      req.on('data', (c) => (s += typeof c === 'string' ? `[str]${c}` : '[buf]'));
      req.on('end', () => res.send(s));
    });
    app.post('/readable', (req, res) => {
      let s = '';
      req.on('readable', () => {
        let c: Buffer | string | null;
        while ((c = req.read()) !== null) s += c.toString();
      });
      req.on('end', () => res.send(`r:${s}`));
    });
    const base = await listen(app);
    expect(await (await post(base, '/iter', 'abc', 'text/x-custom')).text()).toBe('iter:abc');
    expect(await (await post(base, '/enc', 'héllo', 'text/x-custom')).text()).toBe('[str]héllo');
    expect(await (await post(base, '/readable', 'xyz', 'text/x-custom')).text()).toBe('r:xyz');
  });

  it('late async reads still see this request’s own bytes under concurrent load', async () => {
    const app = rxpress();
    app.post('/late', async (req, res) => {
      await new Promise((r) => setTimeout(r, 15));
      let s = '';
      for await (const c of req) s += (c as Buffer).toString();
      res.send(s);
    });
    const base = await listen(app);
    const bodies = Array.from({ length: 40 }, (_, i) => `body-${i}-${'z'.repeat(i * 7)}`);
    const got = await Promise.all(
      bodies.map((b) => post(base, '/late', b, 'text/x-custom').then((r) => r.text()))
    );
    expect(got).toEqual(bodies);
  });

  it('on-finished(req) fires after the body is drained with resume()', async () => {
    const app = rxpress();
    app.post('/of', (req, res) => {
      const before = onFinished.isFinished(req);
      onFinished(req, () => res.json({ before, after: onFinished.isFinished(req) }));
      req.resume();
    });
    const base = await listen(app);
    expect(await (await post(base, '/of', 'data', 'text/x-custom')).json()).toEqual({
      before: false,
      after: true,
    });
  });
});

describe("Node's OutgoingMessage header methods called on res (cookies / cookie-session)", () => {
  it('setHeader/getHeader/removeHeader from http.OutgoingMessage.prototype act on res', async () => {
    const { OutgoingMessage } = require('node:http') as typeof import('node:http');
    const app = rxpress();
    app.get('/h', (_req, res) => {
      OutgoingMessage.prototype.setHeader.call(res, 'Set-Cookie', ['a=1', 'b=2']);
      OutgoingMessage.prototype.setHeader.call(res, 'X-Gone', 'x');
      OutgoingMessage.prototype.removeHeader.call(res, 'x-gone');
      const seen = OutgoingMessage.prototype.getHeader.call(res, 'set-cookie');
      res.json({ seen, own: res.getHeader('set-cookie'), gone: res.getHeader('x-gone') ?? null });
    });
    const base = await listen(app);
    const r = await fetch(base + '/h');
    expect(r.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(r.headers.get('x-gone')).toBeNull();
    expect(await r.json()).toEqual({ seen: ['a=1', 'b=2'], own: ['a=1', 'b=2'], gone: null });
  });
});

describe('app.request / app.response are per app', () => {
  it('extend only their app and the apps mounted under it', async () => {
    const parent = rxpress();
    const child = rxpress();
    const other = rxpress();
    (parent.request as unknown as { who(): string }).who = () => 'parent';
    (child.request as unknown as { who(): string }).who = () => 'child';
    (parent.response as unknown as { tag(): string }).tag = () => 'p';
    const who = (req: unknown) => {
      const r = req as { who?: () => string };
      return typeof r.who === 'function' ? r.who() : 'none';
    };
    child.get('/', (req, res) => {
      res.send(who(req) + ':' + (res as unknown as { tag(): string }).tag());
    });
    parent.use('/child', child);
    parent.get('/', (req, res) => res.send(who(req)));
    other.get('/', (req, res) => res.send(who(req)));
    const base = await listen(parent);
    const otherBase = await listen(other);
    expect(await (await fetch(base + '/')).text()).toBe('parent');
    expect(await (await fetch(base + '/child/')).text()).toBe('child:p');
    expect(await (await fetch(otherBase + '/')).text()).toBe('none');
  });
});

describe('req.socket / res.socket', () => {
  it('is a shared EventEmitter with the net.Socket basics', async () => {
    const app = rxpress();
    app.get('/s', (req, res) => {
      const s = req.socket;
      res.json({
        emitter: s instanceof EventEmitter,
        same: res.socket === s && req.connection === s && res.connection === s,
        readable: s.readable,
        writable: s.writable,
        remoteAddress: s.remoteAddress,
        family: s.remoteFamily,
        encrypted: s.encrypted,
        chain: s.setTimeout(1000) === s && s.setNoDelay(true) === s && s.setKeepAlive(true) === s,
      });
    });
    const base = await listen(app);
    expect(await (await fetch(base + '/s')).json()).toEqual({
      emitter: true,
      same: true,
      readable: true,
      writable: true,
      remoteAddress: '127.0.0.1',
      family: 'IPv4',
      encrypted: false,
      chain: true,
    });
  });

  it("emits 'close' when the client disconnects before the response", async () => {
    const app = rxpress();
    let resolveClosed!: (v: string) => void;
    const closed = new Promise<string>((r) => (resolveClosed = r));
    app.get('/hang', (req, res) => {
      onFinished(res, () => resolveClosed(`res-finished socketWritable=${req.socket.writable}`));
      req.socket.on('close', () => void 0);
    });
    const base = await listen(app);
    const port = Number(new URL(base).port);
    const sock = createConnection(port, '127.0.0.1');
    sock.write('GET /hang HTTP/1.1\r\nHost: x\r\n\r\n');
    await new Promise((r) => setTimeout(r, 100));
    sock.destroy();
    expect(await closed).toBe('res-finished socketWritable=false');
  });
});

// ---------------------------------------------------------------------------------------------
// Callable app, http/https.createServer on the native engine, engine bridge
// ---------------------------------------------------------------------------------------------

const expressMod = require('express') as (() => {
  use(...a: unknown[]): unknown;
  get(...a: unknown[]): unknown;
  listen(port: number, host: string): import('node:http').Server;
}) & { json(): unknown };

function demoApp(): App {
  const app = rxpress();
  app.use(rxpress.json());
  app.get('/hi', (req, res) =>
    res.json({
      ip: req.ip,
      url: req.url,
      orig: req.originalUrl,
      base: req.baseUrl,
      same: req.app === app,
    })
  );
  app.post('/echo', (req, res) => res.json(req.body));
  app.get('/boom', () => {
    throw Object.assign(new Error('kaboom'), { status: 418 });
  });
  return app;
}

async function listenNode(server: import('node:http').Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  servers.push(server as unknown as Server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('app is a request listener', () => {
  it('is a function and an Application; req.app is the app itself', async () => {
    const app = demoApp();
    expect(typeof app).toBe('function');
    expect(app instanceof rxpress.application.constructor).toBe(true);
    expect(Object.getPrototypeOf(app)).toBe(rxpress.application);
    expect(typeof app.call).toBe('function');
    const base = await listen(app);
    expect(await (await fetch(base + '/hi')).json()).toMatchObject({ url: '/hi', same: true });
  });

  it('a callable sub-app mounts (directly and wrapped in a function)', async () => {
    const sub = rxpress();
    sub.get('/x', (req, res) => res.json({ base: req.baseUrl, url: req.url, subApp: req.app === sub }));
    const app = rxpress();
    app.use('/direct', sub);
    app.use('/wrapped', (req, res, next) => sub(req, res, next));
    app.use((_req, res) => res.status(404).send('parent-404'));
    const base = await listen(app);
    expect(await (await fetch(base + '/direct/x')).json()).toEqual({ base: '/direct', url: '/x', subApp: true });
    expect(await (await fetch(base + '/wrapped/x')).json()).toMatchObject({ url: '/x', subApp: true });
    expect(await (await fetch(base + '/wrapped/nope')).text()).toBe('parent-404');
  });

  it('express.request/response/application are the prototypes (extensible like Express)', async () => {
    const ext = rxpress.response as unknown as Record<string, unknown>;
    ext.__phase1Ok = function (this: { status(n: number): { send(s: string): void } }) {
      this.status(200).send('ext-ok');
    };
    try {
      const app = rxpress();
      app.get('/e', (_req, res) => (res as unknown as { __phase1Ok(): void }).__phase1Ok());
      const base = await listen(app);
      expect(await (await fetch(base + '/e')).text()).toBe('ext-ok');
    } finally {
      delete ext.__phase1Ok;
    }
  });
});

describe('http/https.createServer(app) runs on the native engine', () => {
  it('returns an RxServer for rxpress apps and a Node server otherwise', async () => {
    const http = await import('node:http');
    const s = http.createServer(demoApp());
    expect(s).toBeInstanceOf(RxServer);
    const plain = http.createServer(() => undefined);
    expect(plain).toBeInstanceOf(http.Server);
    const { createServer } = await import('node:http');
    expect(createServer(demoApp())).toBeInstanceOf(RxServer);
  });

  it('follows the NestJS ExpressAdapter lifecycle (listen cb, address, EADDRINUSE, close)', async () => {
    const http = await import('node:http');
    const app = rxpress();
    app.set('x-powered-by', false);
    const server = http.createServer(app);
    app.use(bodyParser.json({ verify: (req: { rawBody?: Buffer }, _res: unknown, buf: Buffer) => void (req.rawBody = buf) }) as never);
    app.post('/shop-api', (req, res) => res.json({ data: req.body, raw: (req.rawBody as Buffer).length }));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => (server.address() ? resolve() : reject(new Error('no address'))));
    });
    const port = (server.address() as { port: number }).port;
    const r = await post(`http://127.0.0.1:${port}`, '/shop-api', '{"query":"{ me }"}');
    expect(r.headers.get('x-powered-by')).toBeNull();
    expect(await r.json()).toEqual({ data: { query: '{ me }' }, raw: 18 });

    const clash = http.createServer(rxpress());
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      clash.once('error', resolve);
      clash.once('listening', () => resolve(null));
      clash.listen(port, '127.0.0.1');
    });
    expect(err?.code).toBe('EADDRINUSE');

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(server.listening).toBe(false);
    expect(server.address()).toBeNull();
    // supertest(server) on a closed server: listen(0) again
    await new Promise<void>((resolve) => {
      server.once('listening', () => resolve());
      server.listen(0, '127.0.0.1');
    });
    expect(server.address()).not.toBeNull();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('https.createServer({ key, cert }, app) serves TLS natively', async () => {
    const { execSync } = await import('node:child_process');
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const https = await import('node:https');
    const dir = mkdtempSync(join(tmpdir(), 'rxpress-p1-'));
    try {
      execSync(
        `openssl req -x509 -newkey rsa:2048 -keyout "${dir}/k.pem" -out "${dir}/c.pem" -days 1 -nodes -subj "/CN=127.0.0.1"`,
        { stdio: 'ignore' }
      );
      const app = rxpress();
      app.get('/s', (req, res) => res.json({ secure: req.secure }));
      const server = https.createServer({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) }, app);
      expect(server).toBeInstanceOf(RxServer);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      servers.push(server as unknown as Server);
      const port = (server.address() as { port: number }).port;
      const body = await new Promise<string>((resolve, reject) => {
        https
          .get({ host: '127.0.0.1', port, path: '/s', rejectUnauthorized: false }, (res) => {
            let s = '';
            res.on('data', (c) => (s += c));
            res.on('end', () => resolve(s));
          })
          .on('error', reject);
      });
      expect(JSON.parse(body)).toEqual({ secure: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Node req/res through the engine bridge', () => {
  it('mounted in a real Express app: urls, ip, body, next() and errors behave like a sub-app', async () => {
    const ex = expressMod();
    ex.use(expressMod.json());
    ex.use('/rx', demoApp());
    ex.get('/after', (_q: unknown, s: { send(v: string): void }) => s.send('express-after'));
    ex.use((err: { status?: number; message: string }, _q: unknown, s: { status(n: number): { send(v: string): void } }, _n: unknown) =>
      s.status(err.status ?? 500).send(`express-err:${err.message}`)
    );
    const base = await listenNode(ex.listen(0, '127.0.0.1'));
    expect(await (await fetch(base + '/rx/hi?x=1')).json()).toEqual({
      ip: '127.0.0.1',
      url: '/hi?x=1',
      orig: '/rx/hi?x=1',
      base: '/rx',
      same: true,
    });
    expect(await (await post(base, '/rx/echo', '{"b":2}')).json()).toEqual({ b: 2 });
    const boom = await fetch(base + '/rx/boom');
    expect([boom.status, await boom.text()]).toEqual([418, 'express-err:kaboom']);
    const miss = await fetch(base + '/rx/nope');
    expect(miss.status).toBe(404);
    expect(await miss.text()).toContain('Cannot GET /rx/nope');
  });

  it("app.set('native server', false) keeps Node's server and still answers through the engine", async () => {
    const http = await import('node:http');
    const app = demoApp();
    app.set('native server', false);
    const server = http.createServer(app);
    expect(server).toBeInstanceOf(http.Server);
    const base = await listenNode(server);
    expect(await (await fetch(base + '/hi')).json()).toMatchObject({ url: '/hi', same: true });
    expect(await (await post(base, '/echo', '{"c":3}')).json()).toEqual({ c: 3 });
    const miss = await fetch(base + '/zzz');
    expect(miss.status).toBe(404);
    expect(await miss.text()).toContain('Cannot GET /zzz');
  });

  it('the bridge engine rejects requests without this process’s secret', async () => {
    const app = demoApp();
    const handle = app._startBridge();
    servers.push(handle as unknown as Server);
    const base = `http://127.0.0.1:${handle.address()!.port}`;
    expect((await fetch(base + '/hi')).status).toBe(403);
    const forged = await fetch(base + '/hi', {
      headers: { 'x-rxpress-bridge': 'forged;0;0;6.6.6.6;%2Fhi;' },
    });
    expect(forged.status).toBe(403);
  });

  it('the bridge engine does not keep the process alive', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = `
      import rxpress from ${JSON.stringify(new URL('../dist/index.mjs', import.meta.url).href)};
      import http from 'node:http';
      const app = rxpress(); app.set('native server', false);
      app.get('/', (req, res) => res.send('ok'));
      const s = http.createServer(app).listen(0, '127.0.0.1', async () => {
        const r = await fetch('http://127.0.0.1:' + s.address().port + '/');
        console.log(await r.text());
        s.close();
      });`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 10000,
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('ok');
  });
});

describe('Vendure/NestJS: body parser errors have the body-parser/http-errors shape', () => {
  it('invalid JSON is the native SyntaxError with status 400; 413 carries expose', async () => {
    const app = rxpress();
    app.use(rxpress.json({ limit: 20 }));
    app.post('/j', (_req, res) => res.send('no'));
    app.use(((err: Error & Record<string, unknown>, _req: unknown, res: { json(v: unknown): void }, _next: unknown) => {
      res.json({
        syntax: err instanceof SyntaxError,
        status: err.status,
        statusCode: err.statusCode,
        expose: err.expose,
        type: err.type,
        body: err.body,
        message: err.message,
      });
    }) as never);
    const base = await listen(app);
    const bad = await (await post(base, '/j', '{bad')).json();
    let native = '';
    try {
      JSON.parse('{bad');
    } catch (e) {
      native = (e as Error).message;
    }
    expect(bad).toEqual({
      syntax: true,
      status: 400,
      statusCode: 400,
      expose: true,
      type: 'entity.parse.failed',
      body: '{bad',
      message: native,
    });
    const strict = (await (await post(base, '/j', '"str"')).json()) as { message: string };
    expect(strict).toMatchObject({ syntax: true, status: 400, type: 'entity.parse.failed' });
    expect(strict.message).toMatch(/"/);
    const big = await (await post(base, '/j', JSON.stringify({ k: 'x'.repeat(40) }))).json();
    expect(big).toMatchObject({ syntax: false, status: 413, statusCode: 413, expose: true, type: 'entity.too.large' });
  });
});

describe('request bodies stream from the engine', () => {
  const { createHash, randomBytes } = require('node:crypto') as typeof import('node:crypto');
  const sha = (b: Buffer) => createHash('sha1').update(b).digest('hex');
  const big = randomBytes(5 * 1024 * 1024);

  function chunkedBody(buf: Buffer, piece = 100_000): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(c) {
        for (let i = 0; i < buf.length; i += piece) c.enqueue(buf.subarray(i, i + piece));
        c.close();
      },
    });
  }

  it("delivers a large body through on('data'), for await and pipe, intact", async () => {
    const app = rxpress();
    app.post('/data', (req, res) => {
      const h = createHash('sha1');
      let n = 0;
      let chunks = 0;
      expect(req.complete).toBe(false);
      req.on('data', (chunk) => {
        const c = chunk as Buffer;
        n += c.length;
        chunks++;
        h.update(c);
      });
      req.on('end', () => res.json({ n, chunks, sha: h.digest('hex'), complete: req.complete }));
    });
    app.post('/iter', async (req, res) => {
      const parts: Buffer[] = [];
      for await (const c of req) parts.push(c as Buffer);
      res.json({ sha: sha(Buffer.concat(parts)) });
    });
    app.post('/echo', (req, res) => {
      req.pipe(res as never);
    });
    const base = await listen(app);

    const r1 = (await (await fetch(base + '/data', { method: 'POST', body: big })).json()) as {
      n: number;
      chunks: number;
      sha: string;
      complete: boolean;
    };
    expect(r1).toMatchObject({ n: big.length, sha: sha(big), complete: true });
    expect(r1.chunks).toBeGreaterThan(1);

    const r2 = await fetch(base + '/iter', {
      method: 'POST',
      body: chunkedBody(big),
      duplex: 'half',
    } as RequestInit);
    expect(await r2.json()).toEqual({ sha: sha(big) });

    const r3 = Buffer.from(await (await fetch(base + '/echo', { method: 'POST', body: big })).arrayBuffer());
    expect(r3.equals(big)).toBe(true);
  });

  it('pipes an upload to a file', async () => {
    const { mkdtempSync, readFileSync, createWriteStream } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'rx-up-')), 'up.bin');
    const app = rxpress();
    app.put('/up', (req, res) => {
      const out = createWriteStream(file);
      req.pipe(out as never);
      out.on('finish', () => res.sendStatus(201));
    });
    const base = await listen(app);
    const r = await fetch(base + '/up', { method: 'PUT', body: big });
    expect(r.status).toBe(201);
    expect(readFileSync(file).equals(big)).toBe(true);
  });

  it('a paused request stops the engine reading the upload (backpressure)', async () => {
    const app = rxpress();
    let resumeReq: (() => void) | null = null;
    let peak = 0;
    app.post('/slow', (req, res) => {
      req.pause();
      let n = 0;
      req.on('data', (chunk) => {
        const c = chunk as Buffer;
        n += c.length;
        peak = Math.max(peak, req.readableLength);
      });
      req.on('end', () => res.json({ n }));
      resumeReq = () => req.resume();
    });
    const base = await listen(app);
    const port = Number(new URL(base).port);
    const total = 64 * 1024 * 1024;
    const sock = createConnection(port, '127.0.0.1');
    let reply = '';
    sock.on('data', (d) => (reply += d.toString()));
    await new Promise((r) => sock.once('connect', r));
    sock.write(`POST /slow HTTP/1.1\r\nHost: x\r\nContent-Length: ${total}\r\n\r\n`);
    const piece = Buffer.alloc(1024 * 1024, 7);
    for (let i = 0; i < 64; i++) sock.write(piece);
    await new Promise((r) => setTimeout(r, 400));
    // The engine holds a small window; the rest waits in the client's socket buffers.
    expect(sock.writableLength).toBeGreaterThan(8 * 1024 * 1024);
    resumeReq!();
    await new Promise<void>((r) => sock.on('data', () => reply.includes('"n"') && r()));
    expect(reply).toContain(`"n":${total}`);
    expect(peak).toBeLessThan(1024 * 1024);
    sock.destroy();
  });

  it('answering without reading the body closes the connection afterwards', async () => {
    const app = rxpress();
    app.post('/deny', (_req, res) => res.status(401).send('no'));
    const base = await listen(app);
    const port = Number(new URL(base).port);
    const sock = createConnection(port, '127.0.0.1');
    let reply = '';
    sock.on('data', (d) => (reply += d.toString()));
    const closed = new Promise<void>((r) => sock.on('close', () => r()));
    sock.on('error', () => {});
    sock.write(`POST /deny HTTP/1.1\r\nHost: x\r\nContent-Length: ${10 * 1024 * 1024}\r\n\r\n`);
    sock.write(Buffer.alloc(200_000));
    await closed;
    expect(reply).toMatch(/^HTTP\/1\.1 401/);
  });

  it("a client that aborts mid-upload surfaces as 'aborted' and a rejected for await", async () => {
    const app = rxpress();
    const seen: string[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    app.post('/a', async (req, res) => {
      req.on('aborted', () => seen.push('aborted'));
      req.on('close', () => seen.push('close'));
      try {
        for await (const _ of req) void _;
        seen.push('end');
      } catch (e) {
        seen.push('throw:' + (e as Error).message);
      }
      res.end();
      done();
    });
    const base = await listen(app);
    const sock = createConnection(Number(new URL(base).port), '127.0.0.1');
    sock.on('error', () => {});
    sock.write(`POST /a HTTP/1.1\r\nHost: x\r\nContent-Length: ${1024 * 1024}\r\n\r\n`);
    sock.write(Buffer.alloc(100_000));
    await new Promise((r) => setTimeout(r, 100));
    sock.destroy();
    await finished;
    expect(seen).toContain('aborted');
    expect(seen).toContain('throw:aborted');
    expect(seen).not.toContain('end');
  });

  it('an incomplete body hits requestTimeoutMs', async () => {
    const app = rxpress();
    app.set('requestTimeoutMs', 300);
    let outcome = '';
    app.post('/t', (req, res) => {
      req.on('aborted', () => (outcome = 'aborted'));
      req.on('end', () => (outcome = 'end'));
      req.resume();
      res.on('close', () => void 0);
    });
    const base = await listen(app);
    const sock = createConnection(Number(new URL(base).port), '127.0.0.1');
    sock.on('error', () => {});
    let reply = '';
    sock.on('data', (d) => (reply += d.toString()));
    const closed = new Promise<void>((r) => sock.on('close', () => r()));
    const t0 = Date.now();
    sock.write('POST /t HTTP/1.1\r\nHost: x\r\nContent-Length: 1000000\r\n\r\n');
    sock.write(Buffer.alloc(100_000));
    await closed;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(reply).toMatch(/^HTTP\/1\.1 408/);
    await new Promise((r) => setTimeout(r, 50));
    expect(outcome).toBe('aborted');
  });

  it('requestTimeoutMs also bounds the body while the response streams (req.pipe(res))', async () => {
    const app = rxpress();
    app.set('requestTimeoutMs', 300);
    let aborted = false;
    app.post('/echo', (req, res) => {
      req.on('aborted', () => (aborted = true));
      req.pipe(res as never);
    });
    const base = await listen(app);
    const sock = createConnection(Number(new URL(base).port), '127.0.0.1');
    sock.on('error', () => {});
    let reply = '';
    sock.on('data', (d) => (reply += d.toString('latin1')));
    const closed = new Promise<void>((r) => sock.on('close', () => r()));
    const t0 = Date.now();
    sock.write('POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 1000000\r\n\r\n');
    sock.write(Buffer.alloc(100_000, 120));
    await closed;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    expect(reply).not.toMatch(/0\r\n\r\n$/);
    await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBe(true);
  });

  it('an explicit defaultBodyLimitBytes still answers 413 before dispatch', async () => {
    const app = rxpress();
    app.set('defaultBodyLimitBytes', 1024);
    let called = false;
    app.post('/x', (_req, res) => {
      called = true;
      res.end();
    });
    const base = await listen(app);
    const r = await fetch(base + '/x', { method: 'POST', body: Buffer.alloc(4096) });
    expect(r.status).toBe(413);
    expect(called).toBe(false);
  });

  it('npm body-parser, raw-body and rxpress parsers read streamed bodies', async () => {
    const app = rxpress();
    const obj: Record<string, string> = {};
    for (let i = 0; i < 20_000; i++) obj['k' + i] = 'v'.repeat(10);
    const json = JSON.stringify(obj);
    app.post('/bp', bodyParser.json({ limit: '10mb' }) as never, (req, res) =>
      res.json({ keys: Object.keys(req.body as object).length })
    );
    app.post('/rb', (req, res, next) => {
      getRawBody(req, { limit: '1mb' }, (err) => (err ? next(err) : res.end('ok')));
    });
    // A custom type never matches a native body rule, so the body arrives streamed.
    app.post('/rx', rxpress.json({ type: 'application/x-thing', limit: '10mb' }), (req, res) =>
      res.json({ keys: Object.keys(req.body as object).length })
    );
    app.post('/rxsmall', rxpress.json({ type: () => true, limit: '100kb' }), (_req, res) => res.end());
    app.post('/rxraw', rxpress.raw({ type: '*/*', limit: '10mb' }), (req, res) =>
      res.json({ sha: sha(req.body as Buffer) })
    );
    app.use(((err: { status?: number; type?: string }, _req: unknown, res: { status(n: number): { json(o: unknown): void } }, _next: unknown) =>
      res.status(err.status ?? 500).json({ type: err.type })) as never);
    const base = await listen(app);

    expect(await (await post(base, '/bp', json)).json()).toEqual({ keys: 20_000 });
    const rb = await fetch(base + '/rb', { method: 'POST', body: big });
    expect(rb.status).toBe(413);
    expect(await rb.json()).toEqual({ type: 'entity.too.large' });
    expect(await (await post(base, '/rx', json, 'application/x-thing')).json()).toEqual({ keys: 20_000 });
    const chunkedJson = await fetch(base + '/rx', {
      method: 'POST',
      headers: { 'content-type': 'application/x-thing' },
      body: chunkedBody(Buffer.from(json), 7000),
      duplex: 'half',
    } as RequestInit);
    expect(await chunkedJson.json()).toEqual({ keys: 20_000 });
    const small = await fetch(base + '/rxsmall', {
      method: 'POST',
      headers: { 'content-type': 'text/x' },
      body: chunkedBody(big),
      duplex: 'half',
    } as RequestInit);
    expect(small.status).toBe(413);
    expect(await small.json()).toEqual({ type: 'entity.too.large' });
    expect(
      await (await fetch(base + '/rxraw', { method: 'POST', headers: { 'content-type': 'x/y' }, body: big })).json()
    ).toEqual({ sha: sha(big) });
  });
});

describe('apps and routers from a real Express copy mount in rxpress', () => {
  type ExpressFactory = {
    (): Record<string, unknown> & ((...a: unknown[]) => void);
    Router(): Record<string, unknown> & ((...a: unknown[]) => void);
    json(): Mw;
    static(root: string): Mw;
  };
  const realExpress = require('express') as ExpressFactory;
  // Real Express handlers see Express-shaped req/res; keep the tests free of type plumbing.
  type AnyApp = { [k: string]: (...a: any[]) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

  it('routes, params, urls, body parsing, nested routers, errors and fall-through', async () => {
    const sub = realExpress() as unknown as AnyApp;
    sub.get('/hello/:id', (req: any, res: any) =>
      res.json({
        id: req.params.id,
        baseUrl: req.baseUrl,
        originalUrl: req.originalUrl,
        url: req.url,
        query: req.query,
        subApp: req.app === sub,
        accepts: req.accepts('json'),
      })
    );
    sub.post('/body', realExpress.json(), (req: any, res: any) => res.json({ body: req.body }));
    const nested = realExpress.Router() as unknown as AnyApp;
    nested.get('/x', (req: any, res: any) => res.send('nested ' + req.baseUrl));
    sub.use('/r', nested);
    sub.get('/boom', () => {
      throw new Error('boom');
    });
    sub.get('/own-error', () => {
      throw new Error('mine');
    });
    sub.use((err: Error, req: any, res: any, next: (e?: unknown) => void) => {
      if (err.message === 'mine') return res.status(418).send('sub handled');
      next(err);
    });

    const app = rxpress();
    app.use('/sub', sub as never);
    app.use('/sub', (req, res) =>
      res.json({ fell: req.url, rxApp: req.app === app, rxProto: Object.getPrototypeOf(req) === rxpress.request })
    );
    app.use(((err: Error, _req: unknown, res: { status(n: number): { send(s: string): void } }, _next: unknown) =>
      res.status(500).send('rx ' + err.message)) as never);
    const base = await listen(app);

    expect(await (await fetch(base + '/sub/hello/7?a=1&b[c]=2')).json()).toEqual({
      id: '7',
      baseUrl: '/sub',
      originalUrl: '/sub/hello/7?a=1&b[c]=2',
      url: '/hello/7?a=1&b[c]=2',
      // The sub-app's own Express 5 default ('simple') applies inside it.
      query: { a: '1', 'b[c]': '2' },
      subApp: true,
      accepts: 'json',
    });
    expect(await (await post(base, '/sub/body', '{"k":[1]}')).json()).toEqual({ body: { k: [1] } });
    expect(await (await fetch(base + '/sub/r/x')).text()).toBe('nested /sub/r');
    const boom = await fetch(base + '/sub/boom');
    expect([boom.status, await boom.text()]).toEqual([500, 'rx boom']);
    const own = await fetch(base + '/sub/own-error');
    expect([own.status, await own.text()]).toEqual([418, 'sub handled']);
    expect(await (await fetch(base + '/sub/missing')).json()).toEqual({
      fell: '/missing',
      rxApp: true,
      rxProto: true,
    });
  });

  it('mount event, mountpath/parent and Express settings inheritance', async () => {
    const sub = realExpress() as unknown as AnyApp & { mountpath?: unknown; parent?: unknown };
    let mountedOn: unknown;
    sub.on('mount', (parent: unknown) => (mountedOn = parent));
    sub.set('json spaces', 2);
    sub.get('/ip', (req: any, res: any) => res.json({ ip: req.ip, proto: req.protocol }));
    sub.get('/j', (_req: any, res: any) => res.json({ a: 1 }));

    const app = rxpress();
    app.set('trust proxy', true);
    app.use('/s', sub as never);
    app.get('/j', (_req, res) => res.json({ a: 1 }));
    expect(mountedOn).toBe(app);
    expect(sub.mountpath).toBe('/s');
    expect(sub.parent).toBe(app);
    const base = await listen(app);

    // The parent's trust proxy reaches the sub-app (Express inherits it on mount).
    const ip = await fetch(base + '/s/ip', {
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' },
    });
    expect(await ip.json()).toEqual({ ip: '203.0.113.9', proto: 'https' });
    // The sub-app's own setting applies inside it only.
    expect(await (await fetch(base + '/s/j')).text()).toBe('{\n  "a": 1\n}');
    expect(await (await fetch(base + '/j')).text()).toBe('{"a":1}');
  });

  it('express.static and Router from the real Express, on the app and on an rxpress Router', async () => {
    const { mkdtempSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'rx-static-'));
    writeFileSync(join(dir, 'a.txt'), 'static file');

    const sub = realExpress() as unknown as AnyApp;
    sub.use('/files', realExpress.static(dir));
    const router = realExpress.Router() as unknown as AnyApp;
    router.get('/r/:k', (req: any, res: any) => res.send(`router ${req.params.k} ${req.baseUrl}`));
    const sub2 = realExpress() as unknown as AnyApp;
    sub2.get('/v', (req: any, res: any) => res.send('on rx router ' + req.baseUrl + ' ' + (req.app === sub2)));

    const app = rxpress();
    app.use('/s', sub as never);
    app.use('/x', router as never);
    const rxRouter = rxpress.Router();
    rxRouter.use('/inner', sub2 as never);
    app.use('/rr', rxRouter);
    const base = await listen(app);

    const st = await fetch(base + '/s/files/a.txt');
    expect([st.status, await st.text()]).toEqual([200, 'static file']);
    expect(await (await fetch(base + '/x/r/q')).text()).toBe('router q /x');
    expect(await (await fetch(base + '/rr/inner/v')).text()).toBe('on rx router /rr/inner true');
  });
});

describe('Express 5 parity: views and defaults', () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');

  // A tiny engine: "Hello {{name}}" with {{key}} lookups in the merged locals.
  const tpl = (path: string, opts: Record<string, unknown>, cb: (e: Error | null, s?: string) => void) => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    try {
      const src = readFileSync(path, 'utf8');
      cb(null, src.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(opts[k] ?? '')));
    } catch (e) {
      cb(e as Error);
    }
  };

  function viewsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'rx-views-'));
    writeFileSync(join(dir, 'page.tpl'), '<p>{{title}} {{who}} {{site}}</p>');
    mkdirSync(join(dir, 'blog'));
    writeFileSync(join(dir, 'blog', 'index.tpl'), 'blog index {{title}}');
    writeFileSync(join(dir, 'bad.tpl'), 'x');
    return dir;
  }

  it('the default query parser is the Express 5 "simple" one', async () => {
    const app = rxpress();
    expect(app.get('query parser')).toBe('simple');
    app.get('/q', (req, res) => res.json(req.query));
    const base = await listen(app);
    expect(await (await fetch(base + '/q?a[b]=1&c=2&c=3')).json()).toEqual({ 'a[b]': '1', c: ['2', '3'] });
  });

  it('app.engine, view engine, locals precedence, index lookup, callbacks and errors', async () => {
    const dir = viewsDir();
    const app = rxpress();
    app.engine('tpl', tpl);
    app.engine('.bad', (_p: string, _o: unknown, cb: (e: Error) => void) => cb(new Error('engine broke')));
    writeFileSync(join(dir, 'oops.bad'), '');
    app.set('views', dir);
    app.set('view engine', 'tpl');
    app.locals.site = 'S';
    app.locals.who = 'app';
    expect(app.get('views')).toBe(dir);

    app.get('/page', (_req, res) => {
      res.locals.who = 'res';
      res.render('page', { title: 'T' });
    });
    app.get('/blog', (_req, res) => res.render('blog', { title: 'B' }));
    app.get('/cb', (_req, res) => res.render('page.tpl', (err, html) => res.json({ err, html })));
    app.get('/missing', (_req, res) => res.render('nope'));
    app.get('/broken', (_req, res) => res.render('oops.bad'));
    app.use(((err: Error, _req: unknown, res: { status(n: number): { send(s: string): void } }, _next: unknown) =>
      res.status(500).send(err.message)) as never);
    const base = await listen(app);

    const page = await fetch(base + '/page');
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(await page.text()).toBe('<p>T res S</p>');
    expect(await (await fetch(base + '/blog')).text()).toBe('blog index B');
    expect(await (await fetch(base + '/cb')).json()).toEqual({ err: null, html: '<p> app S</p>' });
    expect(await (await fetch(base + '/missing')).text()).toBe(`Failed to lookup view "nope" in views directory "${dir}"`);
    expect(await (await fetch(base + '/broken')).text()).toBe('engine broke');

    const rendered = await new Promise<string>((resolve, reject) =>
      app.render('page', { title: 'direct' }, (err, html) => (err ? reject(err) : resolve(html!)))
    );
    expect(rendered).toBe('<p>direct app S</p>');
    expect(() => app.render('noext', () => {})).not.toThrow();
  });

  it('view cache keeps the resolved view; a mounted real Express app renders with its own views', async () => {
    const dir = viewsDir();
    const app = rxpress();
    app.engine('tpl', tpl);
    app.set('views', dir);
    app.enable('view cache');
    let renders = 0;
    app.get('/c', (_req, res) => res.render('page.tpl', { title: String(++renders) }));
    const realExpress = require('express') as () => Record<string, (...a: any[]) => any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const sub = realExpress();
    const subDir = mkdtempSync(join(tmpdir(), 'rx-subviews-'));
    writeFileSync(join(subDir, 'hi.tpl'), 'sub {{title}} {{site}}');
    sub.engine('tpl', tpl);
    sub.set('views', subDir);
    sub.get('/hi', (_req: any, res: any) => res.render('hi.tpl', { title: 'x' })); // eslint-disable-line @typescript-eslint/no-explicit-any
    app.locals.site = 'parent-local';
    app.use('/sub', sub as never);
    const base = await listen(app);

    expect(await (await fetch(base + '/c')).text()).toBe('<p>1  parent-local</p>');
    expect(await (await fetch(base + '/c')).text()).toBe('<p>2  parent-local</p>');
    expect(Object.keys(app.cache)).toEqual(['page.tpl']);
    expect(await (await fetch(base + '/sub/hi')).text()).toBe('sub x ');
  });
});

describe("'upgrade' hands the connection to Node as a real net.Socket", () => {
  const http = require('node:http') as typeof import('node:http');
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const net = require('node:net') as typeof import('node:net');
  type Sock = import('node:net').Socket;
  type UpReq = { url: string; method: string; headers: Record<string, string>; socket: unknown };

  /** Minimal RFC 6455 server side: handshake, then echo short masked text frames. */
  function acceptWebSocket(req: UpReq, socket: Sock, greeting: string): void {
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const frame = (s: string) => {
      const p = Buffer.from(s);
      return Buffer.concat([Buffer.from([0x81, p.length]), p]);
    };
    socket.write(frame(greeting));
    socket.on('data', (d: Buffer) => {
      const op = d[0] & 0x0f;
      if (op === 0x8) return socket.end(Buffer.from([0x88, 0]));
      const len = d[1] & 0x7f;
      const mask = d.subarray(2, 6);
      const msg = Buffer.from(d.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]));
      socket.write(frame('echo:' + msg.toString()));
    });
  }

  function wsRoundTrip(url: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const got: string[] = [];
      ws.onmessage = (e) => {
        got.push(String(e.data));
        if (got.length === 1) ws.send('hi');
        else ws.close();
      };
      ws.onclose = () => resolve(got);
      ws.onerror = () => reject(new Error('websocket error'));
    });
  }

  it("app.listen(): the handle's 'upgrade' listener gets (req, socket, head) and HTTP keeps working", async () => {
    const app = rxpress();
    app.get('/plain', (_req, res) => res.send('plain'));
    const base = await listen(app);
    const handle = (app as unknown as { _server: import('node:events').EventEmitter })._server;
    let seen: Record<string, unknown> = {};
    handle.on('upgrade', (req: UpReq, socket: Sock, head: Buffer) => {
      seen = {
        url: req.url,
        method: req.method,
        upgrade: req.headers.upgrade,
        isNetSocket: socket instanceof net.Socket,
        sameSocket: req.socket === socket,
        remote: socket.remoteAddress,
        head: head.length,
      };
      acceptWebSocket(req, socket, 'welcome');
    });
    await new Promise((r) => setImmediate(r));
    const got = await wsRoundTrip(base.replace('http', 'ws') + '/chat?room=1');
    expect(got).toEqual(['welcome', 'echo:hi']);
    expect(seen).toEqual({
      url: '/chat?room=1',
      method: 'GET',
      upgrade: 'websocket',
      isNetSocket: true,
      sameSocket: true,
      remote: '127.0.0.1',
      head: 0,
    });
    expect(await (await fetch(base + '/plain')).text()).toBe('plain');
  });

  it('bytes sent right after the request head arrive as head; without listeners it is a normal request', async () => {
    const app = rxpress();
    app.get('/up', (req, res) => res.status(426).send('no upgrade here ' + req.get('upgrade')));
    const srv = http.createServer(app);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    servers.push({ close: () => new Promise<void>((r) => srv.close(() => r())), address: () => srv.address() as { port: number } });
    const port = (srv.address() as { port: number }).port;
    const raw = (payload: string) =>
      new Promise<string>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(payload));
        let out = '';
        s.on('data', (d) => {
          out += d.toString();
          if (out.includes('\r\n\r\n') && /no upgrade|HEAD:/.test(out)) s.end();
        });
        s.on('close', () => resolve(out));
        s.on('error', () => resolve(out));
      });
    const upgradeReq = 'GET /up HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n';

    // Node 24: no 'upgrade' listener -> the request is handled like any other.
    expect(await raw(upgradeReq)).toMatch(/^HTTP\/1\.1 426[\s\S]*no upgrade here echo$/);

    const onUpgrade = (_req: unknown, socket: Sock, head: Buffer) => {
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\nHEAD:' + head.toString());
    };
    srv.on('upgrade', onUpgrade);
    await new Promise((r) => setImmediate(r));
    expect(await raw(upgradeReq + 'early-bytes')).toMatch(/^HTTP\/1\.1 101[\s\S]*HEAD:early-bytes$/);

    srv.off('upgrade', onUpgrade);
    expect(await raw(upgradeReq)).toMatch(/^HTTP\/1\.1 426/);
  });

  it('https.createServer(app): upgrades over TLS relay the decrypted stream both ways', async () => {
    const { mkdtempSync, readFileSync } = require('node:fs') as typeof import('node:fs');
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const tls = require('node:tls') as typeof import('node:tls');
    const https = require('node:https') as typeof import('node:https');
    const dir = mkdtempSync(join(tmpdir(), 'rx-wss-'));
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${join(dir, 'k.pem')}" -out "${join(dir, 'c.pem')}" -days 1 -nodes -subj "/CN=127.0.0.1"`,
      { stdio: 'ignore' }
    );
    const app = rxpress();
    const srv = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, app);
    expect(srv).toBeInstanceOf(RxServer);
    let encrypted: unknown;
    srv.on('upgrade', (req: UpReq, socket: Sock) => {
      encrypted = (socket as unknown as { encrypted?: boolean }).encrypted;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
      socket.on('data', (d: Buffer) => socket.write('echo:' + d.toString()));
      void req;
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    servers.push({ close: () => new Promise<void>((r) => srv.close(() => r())), address: () => srv.address() as { port: number } });
    const port = (srv.address() as { port: number }).port;

    const out = await new Promise<string>((resolve, reject) => {
      const c = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
        c.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n');
      });
      let buf = '';
      c.on('data', (d) => {
        buf += d.toString();
        if (buf.endsWith('\r\n\r\n')) c.write('ping');
        if (buf.includes('echo:ping')) {
          c.end();
          resolve(buf);
        }
      });
      c.on('error', reject);
    });
    expect(out).toMatch(/^HTTP\/1\.1 101[\s\S]*\r\n\r\necho:ping$/);
    expect(encrypted).toBe(true);
  });
});
