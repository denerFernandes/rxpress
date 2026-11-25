import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import rxpress, { type ServerHandle } from '../js/index.js';
import { parseBridgeHeader } from '../js/bridge.js';

let servers: Array<{ close(cb?: () => void): unknown }> = [];
let dirs: string[] = [];

afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  servers = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function start(app: ReturnType<typeof rxpress>): Promise<number> {
  const srv = app.listen(0, '127.0.0.1') as ServerHandle;
  servers.push(srv as never);
  return (srv.address() as AddressInfo).port;
}

function request(
  port: number,
  path: string,
  opts: http.RequestOptions & { body?: Buffer | string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const { body, ...rest } = opts;
    const req = http.request({ host: '127.0.0.1', port, path, ...rest }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('res.redirect/location have no "back" magic string', () => {
  it("redirects to the literal relative URL 'back'", async () => {
    const app = rxpress();
    app.get('/r', (_req, res) => res.redirect('back'));
    app.get('/l', (_req, res) => res.location('back').end());
    const port = await start(app);
    const r = await request(port, '/r', { headers: { Referer: '/prev' } });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('back');
    const l = await request(port, '/l', { headers: { Referer: '/prev' } });
    expect(l.headers.location).toBe('back');
  });
});

describe('req.body is undefined unless a parser middleware ran', () => {
  it('does not parse for routes without a parser, and error handlers do not throw', async () => {
    const app = rxpress();
    app.post('/parsed', rxpress.json(), (req, res) => res.json({ body: req.body }));
    app.post('/plain', (req, res) => res.json({ type: typeof req.body }));
    app.post(
      '/verify',
      rxpress.json({
        verify: () => {
          throw new Error('nope');
        },
      }),
      (_q, res) => res.send('unreachable')
    );
    app.post('/bad', rxpress.json(), (_q, res) => res.send('unreachable'));
    app.use((err: Error, req: any, res: any, _next: any) => {
      res.status(500).json({ msg: err.message.slice(0, 10), body: typeof req.body });
    });
    const port = await start(app);
    const hdr = { 'content-type': 'application/json' };
    const ok = await request(port, '/parsed', { method: 'POST', headers: hdr, body: '{"a":1}' });
    expect(JSON.parse(ok.body)).toEqual({ body: { a: 1 } });
    const plain = await request(port, '/plain', { method: 'POST', headers: hdr, body: '{"a":1}' });
    expect(JSON.parse(plain.body)).toEqual({ type: 'undefined' });
    const ver = await request(port, '/verify', { method: 'POST', headers: hdr, body: '{"a":1}' });
    expect(ver.status).toBe(500);
    expect(JSON.parse(ver.body).body).toBe('undefined');
    const bad = await request(port, '/bad', { method: 'POST', headers: hdr, body: '{bad' });
    expect(bad.status).toBe(500);
    expect(JSON.parse(bad.body).body).toBe('undefined');
  });

  it('a parser scoped to another path does not leak a parsed body', async () => {
    const app = rxpress();
    app.use('/api', rxpress.json());
    app.post('/api/x', (req, res) => res.json({ body: req.body }));
    app.post('/other', (req, res) => res.json({ type: typeof req.body }));
    const port = await start(app);
    const hdr = { 'content-type': 'application/json' };
    const a = await request(port, '/api/x', { method: 'POST', headers: hdr, body: '{"a":1}' });
    expect(JSON.parse(a.body)).toEqual({ body: { a: 1 } });
    const o = await request(port, '/other', { method: 'POST', headers: hdr, body: '{"a":1}' });
    expect(JSON.parse(o.body)).toEqual({ type: 'undefined' });
  });
});

describe('async inflate with limit', () => {
  function app() {
    const a = rxpress();
    a.post('/j', rxpress.json({ limit: '1kb' }), (req, res) => res.json(req.body));
    a.use((err: { status?: number; type?: string }, _q: any, res: any, _n: any) => {
      res.status(err.status ?? 500).json({ type: err.type });
    });
    return a;
  }
  const send = (port: number, enc: string, body: Buffer) =>
    request(port, '/j', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': enc },
      body,
    });

  it('inflates gzip, deflate and br', async () => {
    const port = await start(app());
    const raw = Buffer.from('{"a":1}');
    for (const [enc, buf] of [
      ['gzip', zlib.gzipSync(raw)],
      ['deflate', zlib.deflateSync(raw)],
      ['br', zlib.brotliCompressSync(raw)],
    ] as const) {
      const r = await send(port, enc, buf);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ a: 1 });
    }
  });

  it('rejects a decompression bomb with 413, bad data with 400, unknown encoding with 415', async () => {
    const port = await start(app());
    const bomb = zlib.gzipSync(Buffer.from('[' + '0,'.repeat(50_000) + '0]'));
    expect(bomb.length).toBeLessThan(1024);
    const r = await send(port, 'gzip', bomb);
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body).type).toBe('entity.too.large');
    const bad = await send(port, 'gzip', Buffer.from('not gzip'));
    expect(bad.status).toBe(400);
    const unk = await send(port, 'compress', Buffer.from('x'));
    expect(unk.status).toBe(415);
    expect(JSON.parse(unk.body).type).toBe('encoding.unsupported');
  });
});

describe('duplicate request headers follow Node rules', () => {
  it('keeps the first for discard-list headers, joins others', async () => {
    const app = rxpress();
    app.get('/h', (req, res) =>
      res.json({
        ua: req.headers['user-agent'],
        referer: req.headers.referer,
        auth: req.headers.authorization,
        cookie: req.headers.cookie,
        x: req.headers['x-foo'],
      })
    );
    const port = await start(app);
    const r = await request(port, '/h', {
      headers: {
        'user-agent': ['a', 'b'],
        referer: ['r1', 'r2'],
        authorization: ['Bearer 1', 'Bearer 2'],
        cookie: ['a=1', 'b=2'],
        'x-foo': ['1', '2'],
      } as unknown as http.OutgoingHttpHeaders,
    });
    expect(JSON.parse(r.body)).toEqual({
      ua: 'a',
      referer: 'r1',
      auth: 'Bearer 1',
      cookie: 'a=1; b=2',
      x: '1, 2',
    });
  });
});

describe('TLS options the engine cannot honour use the Node TLS stack', () => {
  function cert(): { key: Buffer; cert: Buffer } {
    const dir = mkdtempSync(join(tmpdir(), 'rxpress-tls-'));
    dirs.push(dir);
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${dir}/k.pem" -out "${dir}/c.pem" -days 1 -nodes -subj "/CN=127.0.0.1"`,
      { stdio: 'ignore' }
    );
    return { key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) };
  }
  function connect(port: number, maxVersion: 'TLSv1.2' | 'TLSv1.3'): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = https.get(
        { host: '127.0.0.1', port, path: '/', rejectUnauthorized: false, maxVersion },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
    });
  }
  function listen(opts: Record<string, unknown>) {
    const app = rxpress();
    app.get('/', (_q, res) => res.send('ok'));
    const srv = https.createServer({ ...cert(), ...opts }, app as never);
    servers.push(srv);
    return new Promise<number>((resolve) =>
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port))
    );
  }

  it('honours minVersion TLSv1.3 (rejects TLS 1.2 clients)', async () => {
    const port = await listen({ minVersion: 'TLSv1.3' });
    expect(await connect(port, 'TLSv1.3')).toBe(200);
    await expect(connect(port, 'TLSv1.2')).rejects.toThrow();
  });

  it('honours maxVersion TLSv1.2 (negotiates 1.2 at most)', async () => {
    const port = await listen({ maxVersion: 'TLSv1.2' });
    expect(await connect(port, 'TLSv1.3')).toBe(200);
  });

  it('engine-default versions still work', async () => {
    const port = await listen({ minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' });
    expect(await connect(port, 'TLSv1.2')).toBe(200);
  });
});

describe('bridge token', () => {
  it('rejects wrong-length and wrong tokens', () => {
    expect(parseBridgeHeader('x;0;0;a;b;c')).toBeNull();
    expect(parseBridgeHeader('')).toBeNull();
    expect(parseBridgeHeader(undefined)).toBeNull();
  });
});
