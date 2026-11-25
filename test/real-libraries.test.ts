// Real npm libraries, unmodified, running on rxpress. These are the ones an Express application
// is most likely to bring: sessions, authentication, file uploads, compression and Socket.IO.
// Each test drives a complete flow over HTTP; nothing here is mocked.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http, { type IncomingHttpHeaders, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import rxpress from '../js/index.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const session = require('express-session') as Any;
const passport = require('passport') as Any;
const { Strategy: LocalStrategy } = require('passport-local') as Any;
const multer = require('multer') as Any;
const compression = require('compression') as Any;
const cookieParser = require('cookie-parser') as Any;
const { Server: SocketIoServer } = require('socket.io') as Any;
const { io: socketIoClient } = require('socket.io-client') as Any;

type Closable = { close(): Promise<void> | void };
const open: Closable[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function serve(app: ReturnType<typeof rxpress>): Promise<string> {
  const srv = await new Promise<Closable & { address(): { port: number } }>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s as never)) as never;
  });
  open.push(srv);
  return `http://127.0.0.1:${srv.address().port}`;
}

/**
 * A plain HTTP request that keeps the raw bytes. `fetch` decodes gzip by itself and does not
 * surface a 304, so it cannot show what the server actually sent.
 */
function rawRequest(
  base: string,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET'
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = httpRequest(
      { host: url.hostname, port: url.port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** A minimal cookie jar: fetch does not keep cookies between calls. */
/**
 * The test server speaks plain HTTP, so apps here play the part of one behind a TLS-terminating
 * proxy: `trust proxy` plus an `X-Forwarded-Proto: https` header (the Jar adds it) is how
 * `req.secure` becomes true, and the sessions below use `Secure`, `HttpOnly` cookies.
 */
function behindProxy(app: ReturnType<typeof rxpress>): void {
  app.set('trust proxy', true);
}

class Jar {
  private cookies = new Map<string, string>();
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('x-forwarded-proto', 'https');
    if (this.cookies.size) {
      headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (/;\s*expires=Thu, 01 Jan 1970/i.test(line) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
  has(name: string): boolean {
    return this.cookies.has(name);
  }
}

describe('express-session', () => {
  it('keeps a counter per session cookie and a new session per client', async () => {
    const app = rxpress();
    behindProxy(app);
    app.use(session({ secret: 'k', resave: false, saveUninitialized: false, cookie: { secure: true, httpOnly: true, sameSite: 'lax' } }));
    app.get('/views', (req: Any, res: Any) => {
      req.session.views = (req.session.views || 0) + 1;
      res.json({ views: req.session.views });
    });
    const base = await serve(app);

    const a = new Jar();
    const b = new Jar();
    const first = await a.fetch(base + '/views');
    expect(await first.json()).toEqual({ views: 1 });
    const cookie = first.headers.getSetCookie()[0];
    expect(cookie).toMatch(/^connect\.sid=s%3A[^;]+; Path=\//);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(await (await a.fetch(base + '/views')).json()).toEqual({ views: 2 });
    expect(await (await a.fetch(base + '/views')).json()).toEqual({ views: 3 });
    expect(await (await b.fetch(base + '/views')).json()).toEqual({ views: 1 });
  });

  it('regenerate() and destroy() work, and an unmodified session sets no cookie', async () => {
    const app = rxpress();
    behindProxy(app);
    app.use(session({ secret: 'k', resave: false, saveUninitialized: false, cookie: { secure: true, httpOnly: true, sameSite: 'lax' } }));
    app.get('/untouched', (_req, res) => res.send('ok'));
    app.get('/set', (req: Any, res: Any) => {
      req.session.user = 'ana';
      res.send('set');
    });
    app.get('/regen', (req: Any, res: Any) => {
      const user = req.session.user;
      req.session.regenerate((err: Error | null) => {
        if (err) return res.status(500).send(String(err));
        req.session.user = user + '!';
        res.send('regenerated');
      });
    });
    app.get('/who', (req: Any, res: Any) => res.send(req.session.user ?? 'nobody'));
    app.get('/destroy', (req: Any, res: Any) => req.session.destroy(() => res.send('bye')));
    const base = await serve(app);

    const jar = new Jar();
    const untouched = await jar.fetch(base + '/untouched');
    expect(untouched.headers.getSetCookie()).toEqual([]);

    await jar.fetch(base + '/set');
    expect(await (await jar.fetch(base + '/who')).text()).toBe('ana');
    const before = [...(jar as Any).cookies.values()][0];
    expect(await (await jar.fetch(base + '/regen')).text()).toBe('regenerated');
    expect([...(jar as Any).cookies.values()][0]).not.toBe(before);
    expect(await (await jar.fetch(base + '/who')).text()).toBe('ana!');
    await jar.fetch(base + '/destroy');
    expect(await (await jar.fetch(base + '/who')).text()).toBe('nobody');
  });

  it('cookie options: Secure, HttpOnly, SameSite and maxAge reach the Set-Cookie header', async () => {
    const app = rxpress();
    behindProxy(app);
    app.use(
      session({
        secret: 'k',
        name: 'sid',
        resave: false,
        saveUninitialized: true,
        cookie: { secure: true, httpOnly: true, maxAge: 60_000, sameSite: 'strict', path: '/app' },
      })
    );
    app.get('/app', (_req, res) => res.send('ok'));
    const base = await serve(app);

    const res = await new Jar().fetch(base + '/app');
    const cookie = res.headers.getSetCookie()[0];
    expect(cookie).toMatch(/^sid=s%3A/);
    expect(cookie).toMatch(/; Path=\/app/);
    expect(cookie).toMatch(/; Expires=/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Strict/);
  });

  it('does not set a Secure cookie on a plain connection (no proxy header)', async () => {
    const app = rxpress();
    behindProxy(app);
    app.use(session({ secret: 'k', resave: false, saveUninitialized: true, cookie: { secure: true, httpOnly: true, sameSite: 'lax' } }));
    app.get('/', (_req, res) => res.send('ok'));
    const base = await serve(app);

    const plain = await fetch(base + '/');
    expect(plain.headers.getSetCookie()).toEqual([]);
    const proxied = await fetch(base + '/', { headers: { 'x-forwarded-proto': 'https' } });
    expect(proxied.headers.getSetCookie()).toHaveLength(1);
  });
});

describe('cookie-parser', () => {
  it('parses plain and signed cookies and rejects a tampered signature', async () => {
    const app = rxpress();
    app.use(cookieParser('s3cret'));
    app.get('/set', (_req, res) => {
      res.cookie('plain', 'a b', { httpOnly: true });
      res.cookie('signed', 'value', { signed: true });
      res.send('set');
    });
    app.get('/read', (req: Any, res: Any) =>
      res.json({ cookies: req.cookies, signed: req.signedCookies })
    );
    const base = await serve(app);

    const jar = new Jar();
    await jar.fetch(base + '/set');
    const read = (await (await jar.fetch(base + '/read')).json()) as Any;
    expect(read.cookies.plain).toBe('a b');
    expect(read.signed).toEqual({ signed: 'value' });

    const tampered = await fetch(base + '/read', {
      headers: { cookie: 'signed=s%3Avalue.AAAA' },
    });
    expect(await tampered.json()).toEqual({ cookies: {}, signed: { signed: false } });
  });
});

describe('passport (passport-local) with express-session', () => {
  function build() {
    const users: Record<string, { id: string; name: string; password: string }> = {
      u1: { id: 'u1', name: 'ana', password: 'pw' },
    };
    const authn = new passport.Passport();
    authn.use(
      new LocalStrategy((name: string, password: string, done: Any) => {
        const user = Object.values(users).find((u) => u.name === name && u.password === password);
        done(null, user || false);
      })
    );
    authn.serializeUser((user: Any, done: Any) => done(null, user.id));
    authn.deserializeUser((id: string, done: Any) => done(null, users[id] || false));

    const app = rxpress();
    app.use(rxpress.urlencoded({ extended: false }));
    app.use(rxpress.json());
    behindProxy(app);
    app.use(session({ secret: 'k', resave: false, saveUninitialized: false, cookie: { secure: true, httpOnly: true, sameSite: 'lax' } }));
    app.use(authn.initialize());
    app.use(authn.session());

    app.post('/login', authn.authenticate('local', { failureRedirect: '/login-failed' }), (req: Any, res: Any) =>
      res.json({ loggedIn: req.isAuthenticated(), user: req.user.name })
    );
    app.get('/login-failed', (_req, res) => res.status(401).json({ error: 'bad credentials' }));
    app.get('/me', (req: Any, res: Any) => {
      if (!req.isAuthenticated()) return res.status(401).json({ error: 'not logged in' });
      res.json({ user: req.user.name, unauth: req.isUnauthenticated() });
    });
    app.post('/logout', (req: Any, res: Any, next: Any) =>
      req.logout((err: Error | null) => (err ? next(err) : res.json({ loggedOut: true })))
    );
    return app;
  }

  it('logs in with a form post, keeps the session, and logs out', async () => {
    const base = await serve(build());
    const jar = new Jar();

    expect((await jar.fetch(base + '/me')).status).toBe(401);

    const form = new URLSearchParams({ username: 'ana', password: 'pw' });
    const login = await jar.fetch(base + '/login', { method: 'POST', body: form });
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ loggedIn: true, user: 'ana' });

    const me = await jar.fetch(base + '/me');
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ user: 'ana', unauth: false });

    const out = await jar.fetch(base + '/logout', { method: 'POST' });
    expect(await out.json()).toEqual({ loggedOut: true });
    expect((await jar.fetch(base + '/me')).status).toBe(401);
  });

  it('accepts a JSON login and redirects a failed login to the failure route', async () => {
    const base = await serve(build());
    const jar = new Jar();

    const bad = await jar.fetch(base + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ana', password: 'wrong' }),
    });
    expect(bad.status).toBe(302);
    expect(bad.headers.get('location')).toBe('/login-failed');

    const ok = await jar.fetch(base + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ana', password: 'pw' }),
    });
    expect(ok.status).toBe(200);
    expect((await jar.fetch(base + '/me')).status).toBe(200);
  });
});

describe('multer', () => {
  it('stores an uploaded file and text fields in memory', async () => {
    const app = rxpress();
    const upload = multer({ storage: multer.memoryStorage() });
    app.post('/upload', upload.single('avatar'), (req: Any, res: Any) => {
      res.json({
        field: req.body.title,
        name: req.file.originalname,
        type: req.file.mimetype,
        size: req.file.size,
        sha: createHash('sha256').update(req.file.buffer).digest('hex'),
      });
    });
    const base = await serve(app);

    const bytes = randomBytes(300_000);
    const form = new FormData();
    form.set('title', 'hello');
    form.set('avatar', new Blob([bytes], { type: 'application/octet-stream' }), 'a.bin');
    const res = await fetch(base + '/upload', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      field: 'hello',
      name: 'a.bin',
      type: 'application/octet-stream',
      size: 300_000,
      sha: createHash('sha256').update(bytes).digest('hex'),
    });
  });

  it('streams a multi-megabyte upload to disk intact and handles several files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rxpress-multer-'));
    dirs.push(dir);
    const app = rxpress();
    const upload = multer({ dest: dir });
    app.post('/upload', upload.array('files', 3), (req: Any, res: Any) => {
      res.json(
        req.files.map((f: Any) => ({
          name: f.originalname,
          size: f.size,
          sha: createHash('sha256').update(readFileSync(f.path)).digest('hex'),
        }))
      );
    });
    const base = await serve(app);

    const big = randomBytes(5 * 1024 * 1024);
    const small = randomBytes(1000);
    const form = new FormData();
    form.append('files', new Blob([big]), 'big.bin');
    form.append('files', new Blob([small]), 'small.bin');
    const res = await fetch(base + '/upload', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { name: 'big.bin', size: big.length, sha: createHash('sha256').update(big).digest('hex') },
      { name: 'small.bin', size: small.length, sha: createHash('sha256').update(small).digest('hex') },
    ]);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('enforces limits and reports the error to the error handler', async () => {
    const app = rxpress();
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1000 } });
    app.post('/upload', upload.single('f'), (_req, res) => res.send('stored'));
    app.use((err: Any, _req: Any, res: Any, _next: Any) => {
      res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 500).json({ code: err.code });
    });
    const base = await serve(app);

    const form = new FormData();
    form.set('f', new Blob([randomBytes(5000)]), 'x.bin');
    const res = await fetch(base + '/upload', { method: 'POST', body: form });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: 'LIMIT_FILE_SIZE' });

    // The connection is still usable afterwards.
    const ok = new FormData();
    ok.set('f', new Blob([randomBytes(10)]), 'y.bin');
    expect(await (await fetch(base + '/upload', { method: 'POST', body: ok })).text()).toBe('stored');
  });
});

describe('compression', () => {
  const payload = { rows: Array.from({ length: 500 }, (_, i) => ({ id: i, name: 'row-' + i })) };

  it('gzips a large JSON body and leaves a small one alone', async () => {
    const app = rxpress();
    app.use(compression());
    app.get('/big', (_req, res) => res.json(payload));
    app.get('/small', (_req, res) => res.send('tiny'));
    const base = await serve(app);

    const big = await rawRequest(base, '/big', { 'accept-encoding': 'gzip' });
    expect(big.headers['content-encoding']).toBe('gzip');
    expect(big.headers.vary).toMatch(/Accept-Encoding/i);
    expect(big.headers['content-length']).toBeUndefined();
    expect(JSON.parse(gunzipSync(big.body).toString())).toEqual(payload);

    const small = await rawRequest(base, '/small', { 'accept-encoding': 'gzip' });
    expect(small.headers['content-encoding']).toBeUndefined();
    expect(small.body.toString()).toBe('tiny');

    const plain = await rawRequest(base, '/big', { 'accept-encoding': 'identity' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(plain.body.toString())).toEqual(payload);
  });

  it('compresses a streamed response written in pieces', async () => {
    const app = rxpress();
    app.use(compression());
    app.get('/stream', (_req, res) => {
      res.setHeader('content-type', 'text/plain');
      for (let i = 0; i < 50; i++) res.write('line '.repeat(40) + i + '\n');
      res.end('done\n');
    });
    const base = await serve(app);

    const res = await rawRequest(base, '/stream', { 'accept-encoding': 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
    const text = gunzipSync(res.body).toString();
    expect(text.split('\n')).toHaveLength(52);
    expect(text.endsWith('done\n')).toBe(true);
  });

  it('answers HEAD without a body and a matching ETag with 304', async () => {
    const app = rxpress();
    app.use(compression());
    app.get('/data', (_req, res) => res.json(payload));
    const base = await serve(app);

    const first = await rawRequest(base, '/data', { 'accept-encoding': 'gzip' });
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    const cached = await rawRequest(base, '/data', { 'accept-encoding': 'gzip', 'if-none-match': etag });
    expect(cached.status).toBe(304);
    expect(cached.body.length).toBe(0);
    const head = await rawRequest(base, '/data', { 'accept-encoding': 'gzip' }, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
  });
});

describe('Socket.IO', () => {
  type Attach = (app: ReturnType<typeof rxpress>) => Promise<{ server: Any; port: number }>;

  /** `const server = app.listen(); new Server(server)`, the usual Express pattern. */
  const viaAppListen: Attach = async (app) => {
    const server = app.listen(0, '127.0.0.1') as Any;
    await new Promise((r) => server.once('listening', r));
    return { server, port: server.address().port };
  };
  /** `http.createServer(app)`, as NestJS and Vendure create their servers. */
  const viaCreateServer: Attach = async (app) => {
    const server = http.createServer(app as never) as Any;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { server, port: server.address().port };
  };

  // The 'upgrade' hand-off to Node is Unix only (see the README), so on Windows only polling runs.
  const upgrades = process.platform !== 'win32';
  const withUpgrade = upgrades ? ['polling', 'websocket'] : ['polling'];

  const cases: Array<[string, Attach, string[]]> = [];
  for (const [name, attach] of [
    ['app.listen()', viaAppListen],
    ['http.createServer(app)', viaCreateServer],
  ] as Array<[string, Attach]>) {
    const variants = upgrades ? [['websocket'], ['polling'], ['polling', 'websocket']] : [['polling']];
    for (const transports of variants) {
      cases.push([`${name}, ${transports.join(' then ')}`, attach, transports]);
    }
  }

  async function connect(port: number, transports: string[], opts: object = {}): Promise<Any> {
    const socket = socketIoClient(`http://127.0.0.1:${port}`, {
      transports,
      reconnection: false,
      forceNew: true,
      ...opts,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    open.push({ close: () => socket.close() });
    return socket;
  }

  it.each(cases)('%s: events with acknowledgements, and the app keeps serving HTTP', async (_n, attach, transports) => {
    const app = rxpress();
    app.get('/hello', (_req, res) => res.send('still an express app'));
    const { server, port } = await attach(app);
    const io = new SocketIoServer(server, { pingInterval: 1000, pingTimeout: 2000 });
    open.push({ close: () => io.close() });
    io.on('connection', (s: Any) => {
      s.on('add', (a: number, b: number, ack: (n: number) => void) => ack(a + b));
    });

    const client = await connect(port, transports);
    const sum = await new Promise<number>((resolve) => client.emit('add', 2, 3, resolve));
    expect(sum).toBe(5);
    expect(await (await fetch(`http://127.0.0.1:${port}/hello`)).text()).toBe('still an express app');
  });

  it.each(cases)('%s: broadcasts, rooms and disconnects', async (_n, attach, transports) => {
    const app = rxpress();
    const { server, port } = await attach(app);
    const io = new SocketIoServer(server, { pingInterval: 1000, pingTimeout: 2000 });
    open.push({ close: () => io.close() });
    io.on('connection', (s: Any) => {
      s.on('join', (room: string, ack: () => void) => {
        s.join(room);
        ack();
      });
      s.on('say', (room: string, text: string) => io.to(room).emit('said', text));
    });

    const a = await connect(port, transports);
    const b = await connect(port, transports);
    const c = await connect(port, transports);
    await new Promise<void>((r) => a.emit('join', 'room1', r));
    await new Promise<void>((r) => b.emit('join', 'room1', r));
    const got: string[] = [];
    a.on('said', (t: string) => got.push('a:' + t));
    b.on('said', (t: string) => got.push('b:' + t));
    c.on('said', (t: string) => got.push('c:' + t));
    a.emit('say', 'room1', 'hi');
    await vi_waitFor(() => got.length >= 2);
    expect(got.sort()).toEqual(['a:hi', 'b:hi']);

    const gone = new Promise<string>((resolve) => b.on('disconnect', resolve));
    io.in('room1').disconnectSockets(true);
    expect(typeof (await gone)).toBe('string');
  });

  it('namespaces and per-socket data over the polling transport', async () => {
    const app = rxpress();
    const { server, port } = await viaAppListen(app);
    const io = new SocketIoServer(server, { pingInterval: 1000, pingTimeout: 2000 });
    open.push({ close: () => io.close() });
    io.of('/chat').on('connection', (s: Any) => {
      s.data.name = s.handshake.auth.name;
      s.on('whoami', (ack: (n: string) => void) => ack(s.data.name));
    });

    const client = socketIoClient(`http://127.0.0.1:${port}/chat`, {
      transports: ['polling'],
      reconnection: false,
      forceNew: true,
      auth: { name: 'ana' },
    });
    open.push({ close: () => client.close() });
    const who = await new Promise<string>((resolve) =>
      client.on('connect', () => client.emit('whoami', resolve))
    );
    expect(who).toBe('ana');
  });

  it('a large payload round-trips intact', async () => {
    const app = rxpress();
    const { server, port } = await viaCreateServer(app);
    const io = new SocketIoServer(server, { maxHttpBufferSize: 5e6 });
    open.push({ close: () => io.close() });
    io.on('connection', (s: Any) => s.on('echo', (data: string, ack: (d: string) => void) => ack(data)));

    const client = await connect(port, withUpgrade);
    const payload = randomBytes(400_000).toString('base64');
    const back = await new Promise<string>((resolve) => client.emit('echo', payload, resolve));
    expect(back).toBe(payload);
  });

  it('works next to express-session and an authenticated route', async () => {
    const app = rxpress();
    behindProxy(app);
    app.use(session({ secret: 'k', resave: false, saveUninitialized: true, cookie: { secure: true, httpOnly: true, sameSite: 'lax' } }));
    app.get('/count', (req: Any, res: Any) => {
      req.session.n = (req.session.n || 0) + 1;
      res.json({ n: req.session.n });
    });
    const { server, port } = await viaAppListen(app);
    const io = new SocketIoServer(server);
    open.push({ close: () => io.close() });
    io.on('connection', (s: Any) => s.on('ping2', (ack: (v: string) => void) => ack('pong')));

    const client = await connect(port, withUpgrade);
    expect(await new Promise((r) => client.emit('ping2', r))).toBe('pong');
    const jar = new Jar();
    expect(await (await jar.fetch(`http://127.0.0.1:${port}/count`)).json()).toEqual({ n: 1 });
    expect(await (await jar.fetch(`http://127.0.0.1:${port}/count`)).json()).toEqual({ n: 2 });
  });
});

describe("'request' listeners on the server, as in Node", () => {
  it('every listener sees every request, and the app still answers', async () => {
    const app = rxpress();
    app.get('/a', (_req, res) => res.send('from app'));
    const server = http.createServer(app as never) as Any;
    const seen: string[] = [];
    server.on('request', (req: Any) => seen.push(req.method + ' ' + req.url));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    open.push({ close: () => new Promise<void>((r) => server.close(() => r())) });
    const base = `http://127.0.0.1:${server.address().port}`;

    expect(await (await fetch(base + '/a')).text()).toBe('from app');
    expect((await fetch(base + '/missing')).status).toBe(404);
    expect(seen).toEqual(['GET /a', 'GET /missing']);
  });

  it('a listener can take a path and pass the rest to the app', async () => {
    const app = rxpress();
    app.get('/app', (_req, res) => res.send('app'));
    const { server, port } = await (async () => {
      const s = app.listen(0, '127.0.0.1') as Any;
      await new Promise((r) => s.once('listening', r));
      return { server: s, port: s.address().port };
    })();
    const original = server.listeners('request').slice();
    expect(original).toHaveLength(1);
    server.removeAllListeners('request');
    server.on('request', (req: Any, res: Any) => {
      if (req.url === '/special') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('special');
      } else {
        for (const l of original) l.call(server, req, res);
      }
    });
    const base = `http://127.0.0.1:${port}`;

    expect(await (await fetch(base + '/special')).text()).toBe('special');
    expect(await (await fetch(base + '/app')).text()).toBe('app');
    expect((await fetch(base + '/nope')).status).toBe(404);
  });

  it('listen() on a running server is an error, as in Node', async () => {
    const app = rxpress();
    const server = app.listen(0, '127.0.0.1') as Any;
    await new Promise((r) => server.once('listening', r));
    open.push(server);
    expect(() => server.listen(0)).toThrowError(/more than once/);
  });
});

async function vi_waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error('condition not met in time');
}
