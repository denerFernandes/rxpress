import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rxpress, {
  type NextFunction,
  type Request,
  type Response,
  type ServerHandle,
} from '../js/index.js';

let activeServers: ServerHandle[] = [];
let tempDirs: string[] = [];

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
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('Native Rust Middlewares & Third-Party Express Middlewares', () => {
  it('supports express.json, express.urlencoded, express.text, and express.raw with limits', async () => {
    const app = rxpress();
    app.use(rxpress.json({ limit: '1kb' }));
    app.use(rxpress.urlencoded({ extended: true }));
    app.use(rxpress.text());
    app.use(rxpress.raw());

    app.post('/echo-json', (req, res) => res.json({ received: req.body }));
    app.post('/echo-form', (req, res) => res.json({ received: req.body }));
    app.post('/echo-text', (req, res) => res.json({ received: req.body }));
    app.post('/echo-raw', (req, res) => {
      const buf = req.body as Buffer;
      res.json({ isBuffer: Buffer.isBuffer(buf), len: buf.length, hex: buf.toString('hex') });
    });

    app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status || 500).json({ error: err.message });
    });

    const base = await startApp(app);

    // JSON
    const rJson = await fetch(`${base}/echo-json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'rxpress', fast: true }),
    });
    expect(rJson.status).toBe(200);
    expect(await rJson.json()).toEqual({ received: { name: 'rxpress', fast: true } });

    // Invalid JSON -> 400
    const rBadJson = await fetch(`${base}/echo-json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    });
    expect(rBadJson.status).toBe(400);

    // Payload too large -> 413
    const rBig = await fetch(`${base}/echo-json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(2048) }),
    });
    expect(rBig.status).toBe(413);

    // URL-encoded
    const rForm = await fetch(`${base}/echo-form`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'user[name]=Alice&roles[]=admin&roles[]=dev',
    });
    expect(await rForm.json()).toEqual({
      received: { user: { name: 'Alice' }, roles: ['admin', 'dev'] },
    });

    // Text
    const rText = await fetch(`${base}/echo-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello plain text',
    });
    expect(await rText.json()).toEqual({ received: 'hello plain text' });

    // Raw binary
    const rRaw = await fetch(`${base}/echo-raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    });
    expect(await rRaw.json()).toEqual({ isBuffer: true, len: 4, hex: 'deadbeef' });
  });

  it('serves static files natively in Rust with ETag, Range, index.html, security & fallthrough', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rxpress-static-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<h1>Home</h1>');
    writeFileSync(join(dir, 'hello.txt'), '0123456789abcdefghij');
    writeFileSync(join(dir, '.secret'), 'top-secret');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'data.json'), '{"ok":true}');

    const app = rxpress();
    app.use('/assets', rxpress.static(dir, { maxAge: '1h', dotfiles: 'ignore' }));
    app.get('/assets/fallback', (_req, res) => res.json({ fellThrough: true }));

    const base = await startApp(app);

    // index.html
    const rIdx = await fetch(`${base}/assets/`);
    expect(rIdx.status).toBe(200);
    expect(rIdx.headers.get('content-type')).toContain('text/html');
    expect(rIdx.headers.get('cache-control')).toContain('max-age=3600');
    expect(await rIdx.text()).toBe('<h1>Home</h1>');

    // ETag + 304
    const etag = rIdx.headers.get('etag');
    expect(etag).toBeTruthy();
    const r304 = await fetch(`${base}/assets/`, { headers: { 'If-None-Match': etag! } });
    expect(r304.status).toBe(304);

    // HTTP Range request -> 206 Partial Content
    const rRange = await fetch(`${base}/assets/hello.txt`, {
      headers: { Range: 'bytes=5-9' },
    });
    expect(rRange.status).toBe(206);
    expect(rRange.headers.get('content-range')).toBe('bytes 5-9/20');
    expect(await rRange.text()).toBe('56789');

    // Dotfile ignored (404)
    const rDot = await fetch(`${base}/assets/.secret`);
    expect(rDot.status).toBe(404);

    // Path traversal blocked
    const rTrav = await fetch(`${base}/assets/..%2F..%2Fetc%2Fpasswd`);
    expect(rTrav.status).toBe(404);

    // Fallthrough to JS route when file doesn't exist
    const rFall = await fetch(`${base}/assets/fallback`);
    expect(rFall.status).toBe(200);
    expect(await rFall.json()).toEqual({ fellThrough: true });
  });

  it('works seamlessly with real third-party Express middlewares: cors, helmet, morgan', async () => {
    const logs: string[] = [];
    const app = rxpress();

    app.use(
      morgan(':method :url :status', {
        stream: {
          write: (msg: string) => logs.push(msg.trim()),
        },
      }) as unknown as Parameters<typeof app.use>[0]
    );
    app.use(helmet() as unknown as Parameters<typeof app.use>[0]);
    app.use(
      cors({
        origin: 'https://example.com',
        methods: ['GET', 'POST'],
      }) as unknown as Parameters<typeof app.use>[0]
    );

    app.get('/protected', (_req, res) => {
      res.json({ secure: true });
    });

    const base = await startApp(app);

    // Normal GET request
    const r = await fetch(`${base}/protected`, {
      headers: { Origin: 'https://example.com' },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ secure: true });

    // helmet headers present & X-Powered-By removed!
    expect(r.headers.get('x-powered-by')).toBeNull();
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');

    // cors headers present!
    expect(r.headers.get('access-control-allow-origin')).toBe('https://example.com');

    // CORS preflight OPTIONS request!
    const rOpt = await fetch(`${base}/protected`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(rOpt.status).toBe(204);
    expect(rOpt.headers.get('access-control-allow-origin')).toBe('https://example.com');
    expect(rOpt.headers.get('access-control-allow-methods')).toContain('POST');

    // morgan logged both requests!
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logs.some((l) => l === 'GET /protected 200')).toBe(true);
    expect(logs.some((l) => l === 'OPTIONS /protected 204')).toBe(true);
  });
});
