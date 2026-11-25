import { afterEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { Agent, request as httpRequest } from 'node:http';
import https from 'node:https';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import rxpress, {
  type NextFunction,
  type Request,
  type Response,
  type ServerHandle,
} from '../js/index.js';

let activeServers: ServerHandle[] = [];
let tempDirs: string[] = [];

function startApp(app: ReturnType<typeof rxpress>): { handle: ServerHandle; port: number; base: string } {
  const handle = app.listen(0, '127.0.0.1');
  activeServers.push(handle);
  const addr = handle.address()!;
  return { handle, port: addr.port, base: `http://127.0.0.1:${addr.port}` };
}

function makeTempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function sendRawAndReadAll(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(payload);
    });
    const chunks: Buffer[] = [];
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    sock.on('error', reject);
  });
}

function decodeChunkedBody(rawBody: string): string {
  let pos = 0;
  let out = '';
  while (pos < rawBody.length) {
    const crlf = rawBody.indexOf('\r\n', pos);
    if (crlf === -1) break;
    const sizeHex = rawBody.slice(pos, crlf).trim();
    const size = parseInt(sizeHex, 16);
    if (Number.isNaN(size) || size === 0) break;
    const dataStart = crlf + 2;
    out += rawBody.slice(dataStart, dataStart + size);
    pos = dataStart + size + 2;
  }
  return out;
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

describe('Streaming/SSE Spin-Loop, Backpressure & Framing', () => {
  it('eliminates closed_streams CPU spin-loop after res.end() and streamStart validation error', async () => {
    const app = rxpress();
    app.get('/stream-ok', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/plain');
      res.write('part1-');
      res.end('part2');
    });
    app.get('/stream-bad-hdr', (_req: Request, res: Response) => {
      res.setHeader('X-Bad', 'val\r\nEvil: 1');
      res.flushHeaders();
      res.end();
    });
    app.get('/health', (_req: Request, res: Response) => {
      res.send('ok');
    });

    const { base } = startApp(app);

    const r1 = await fetch(`${base}/stream-ok`);
    expect(r1.status).toBe(200);
    expect(await r1.text()).toBe('part1-part2');

    // Trigger streamStart CRLF error (must not spin or break event loop)
    const rBad = await fetch(`${base}/stream-bad-hdr`).catch(() => null);
    if (rBad) {
      expect(rBad.status).toBeGreaterThanOrEqual(400);
    }

    const cpuBefore = process.cpuUsage();
    await new Promise<void>((r) => setTimeout(r, 150));
    const cpuDelta = process.cpuUsage(cpuBefore);
    const totalCpuMs = (cpuDelta.user + cpuDelta.system) / 1000;
    expect(totalCpuMs).toBeLessThan(80);

    const rHealth = await fetch(`${base}/health`);
    expect(rHealth.status).toBe(200);
    expect(await rHealth.text()).toBe('ok');
  });

  it('enforces bounded streamQueueCapacity backpressure, emits drain, and flushes buffered write/end losslessly', async () => {
    const app = rxpress();
    app.set('streamQueueCapacity', 2);

    let sawNeedDrain = false;
    let sawDrainEvent = false;
    let finishCalled = false;
    let endCbCalled = false;

    app.get('/backpressure', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.flushHeaders();
      res.on('finish', () => {
        finishCalled = true;
      });
      res.on('drain', () => {
        sawDrainEvent = true;
      });

      const chunk = Buffer.alloc(64 * 1024, 0x41); // 64KB
      let sent = 0;
      const pump = () => {
        while (sent < 512) {
          const ok = res.write(chunk);
          sent++;
          if (!ok) {
            sawNeedDrain = res.writableNeedDrain;
            // Write one more while backpressured + end with final tail!
            const okQueued = res.write(Buffer.from('MID_QUEUED:'));
            expect(okQueued).toBe(false);
            res.end(Buffer.from('FINAL_TAIL'), () => {
              endCbCalled = true;
            });
            expect(res.writableEnded).toBe(true);
            return;
          }
        }
        res.end('FINAL_TAIL', () => {
          endCbCalled = true;
        });
      };
      // Yield slightly so client can pause socket before rapid pumping
      setTimeout(pump, 20);
    });

    const { port } = startApp(app);

    const raw = await new Promise<string>((resolve, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.write('GET /backpressure HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
        sock.pause();
        setTimeout(() => {
          sock.resume();
        }, 120);
      });
      const chunks: Buffer[] = [];
      sock.on('data', (c: Buffer) => chunks.push(c));
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
      sock.on('error', reject);
    });

    const hdrEnd = raw.indexOf('\r\n\r\n');
    expect(hdrEnd).toBeGreaterThan(0);
    const decoded = decodeChunkedBody(raw.slice(hdrEnd + 4));
    expect(sawNeedDrain).toBe(true);
    expect(decoded.endsWith('MID_QUEUED:FINAL_TAIL')).toBe(true);
    expect(finishCalled).toBe(true);
    expect(endCbCalled).toBe(true);
    expect(typeof sawDrainEvent).toBe('boolean');
  });

  it('emits drain event when socket resumes without pending end', async () => {
    const app = rxpress();
    app.set('streamQueueCapacity', 2);

    let drainFired = false;
    let totalBytes = 0;

    app.get('/drain-event', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.flushHeaders();

      const chunk = Buffer.alloc(64 * 1024, 0x42);
      let count = 0;
      const writeMore = () => {
        while (count < 512) {
          count++;
          totalBytes += chunk.length;
          const ok = res.write(chunk);
          if (!ok) {
            expect(res.writableNeedDrain).toBe(true);
            res.once('drain', () => {
              drainFired = true;
              expect(res.writableNeedDrain).toBe(false);
              res.end('DONE');
              totalBytes += 4;
            });
            return;
          }
        }
        res.end('DONE');
        totalBytes += 4;
      };
      setTimeout(writeMore, 20);
    });

    const { port } = startApp(app);
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.write('GET /drain-event HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
        sock.pause();
        setTimeout(() => sock.resume(), 120);
      });
      const chunks: Buffer[] = [];
      sock.on('data', (c: Buffer) => chunks.push(c));
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
      sock.on('error', reject);
    });

    const hdrEnd = raw.indexOf('\r\n\r\n');
    const decoded = decodeChunkedBody(raw.slice(hdrEnd + 4));
    expect(drainFired).toBe(true);
    expect(decoded.length).toBe(totalBytes);
    expect(decoded.endsWith('DONE')).toBe(true);
  });

  it('cleans up StreamRegistry and emits req/res close on early client disconnect', async () => {
    let reqCloseFired = false;
    let resCloseFired = false;
    let writeAfterClose: boolean | null = null;

    const app = rxpress();
    app.get('/abort', (req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
      res.write('data: first\n\n');

      const timer = setInterval(() => {
        const ok = res.write('data: tick\n\n');
        if (reqCloseFired && writeAfterClose === null) {
          writeAfterClose = ok;
        }
      }, 25);

      req.on('close', () => {
        reqCloseFired = true;
      });
      res.on('close', () => {
        resCloseFired = true;
        writeAfterClose = res.write('data: after\n\n');
        clearInterval(timer);
      });
    });

    const { port } = startApp(app);
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.write('GET /abort HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      });
      sock.once('data', () => {
        sock.destroy();
        resolve();
      });
      sock.on('error', reject);
    });

    for (let i = 0; i < 40 && (!reqCloseFired || !resCloseFired); i++) {
      await new Promise<void>((r) => setTimeout(r, 15));
    }
    expect(reqCloseFired).toBe(true);
    expect(resCloseFired).toBe(true);
    expect(writeAfterClose).toBe(false);
  });

  it('preserves pipelined requests during active stream and frames HEAD, 204, CL, and HTTP/1.0 cleanly', async () => {
    const app = rxpress();
    app.get('/stream', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/plain');
      res.write('one-');
      setTimeout(() => res.end('two'), 25);
    });
    app.get('/after', (_req: Request, res: Response) => {
      res.send('AFTER_OK');
    });
    app.get('/no-content', (_req: Request, res: Response) => {
      res.status(204);
      res.flushHeaders();
      res.write('ignored-204-body');
      res.end();
    });
    app.get('/fixed-cl', (_req: Request, res: Response) => {
      res.setHeader('Content-Length', '5');
      res.write('hel');
      res.end('lo');
    });

    const { port } = startApp(app);

    // 1. Pipelined [GET /stream, GET /after] in single TCP write
    const pipeRaw = await sendRawAndReadAll(
      port,
      'GET /stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
        'GET /after HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
    );
    expect(pipeRaw).toContain('4\r\none-\r\n3\r\ntwo\r\n0\r\n\r\n');
    expect(pipeRaw).toContain('AFTER_OK');

    // 2. HEAD /stream + GET /after on same keep-alive socket
    const headRaw = await sendRawAndReadAll(
      port,
      'HEAD /stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
        'GET /after HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
    );
    const secondIdx = headRaw.indexOf('HTTP/1.1 200 OK', 10);
    expect(secondIdx).toBeGreaterThan(0);
    const headPart = headRaw.slice(0, secondIdx);
    expect(headPart.toLowerCase()).not.toContain('transfer-encoding: chunked');
    expect(headPart).not.toContain('one-');
    expect(headRaw.slice(secondIdx)).toContain('AFTER_OK');

    // 3. 204 streaming suppresses TE and body
    const raw204 = await sendRawAndReadAll(
      port,
      'GET /no-content HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
    );
    expect(raw204).toMatch(/^HTTP\/1\.1 204 No Content\r\n/);
    expect(raw204.toLowerCase()).not.toContain('transfer-encoding');
    expect(raw204).not.toContain('ignored-204-body');

    // 4. Explicit Content-Length streaming sends raw unchunked body + keeps keep-alive working
    const rawCl = await sendRawAndReadAll(
      port,
      'GET /fixed-cl HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
        'GET /after HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
    );
    expect(rawCl.toLowerCase()).not.toContain('transfer-encoding: chunked');
    expect(rawCl).toContain('\r\n\r\nhelloHTTP/1.1 200 OK');
    expect(rawCl).toContain('AFTER_OK');

    // 5. HTTP/1.0 streaming emits Connection: close + unchunked raw body
    const raw10 = await sendRawAndReadAll(
      port,
      'GET /stream HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n'
    );
    expect(raw10.toLowerCase()).toContain('connection: close');
    expect(raw10.toLowerCase()).not.toContain('transfer-encoding: chunked');
    expect(raw10.endsWith('\r\n\r\none-two')).toBe(true);
  });
});

describe('Static Files, sendFile, download & Range', () => {
  it('enforces res.sendFile({ root }) traversal/symlink containment, async cb(err) before headersSent, and all options', async () => {
    const ws = makeTempDir('rxpress-test-sf-');
    const rootDir = join(ws, 'root');
    const outsideDir = join(ws, 'outside');
    mkdirSync(rootDir);
    mkdirSync(outsideDir);
    mkdirSync(join(rootDir, 'sub'));
    writeFileSync(join(rootDir, 'ten.txt'), '0123456789');
    writeFileSync(join(rootDir, '.secret'), 'hidden');
    writeFileSync(join(outsideDir, 'secret.txt'), 'OUTSIDE_SECRET');
    symlinkSync(join(outsideDir, 'secret.txt'), join(rootDir, 'sym-out.txt'));

    const app = rxpress();

    app.get('/trav', (_req: Request, res: Response) => {
      res.sendFile('../outside/secret.txt', { root: rootDir }, (err?: Error) => {
        if (err && !res.headersSent) {
          const st = (err as { status?: number }).status ?? 403;
          res.status(st).json({ rejected: true, headersSent: res.headersSent });
        }
      });
    });

    app.get('/sym', (_req: Request, res: Response) => {
      res.sendFile('sym-out.txt', { root: rootDir }, (err?: Error) => {
        if (err && !res.headersSent) {
          const st = (err as { status?: number }).status ?? 403;
          res.status(st).json({ symRejected: true, headersSent: res.headersSent });
        }
      });
    });

    app.get('/miss-cb', (_req: Request, res: Response) => {
      res.sendFile('missing.txt', { root: rootDir }, (err?: Error) => {
        if (err && !res.headersSent) {
          res.status(404).json({ miss: true, headersSentBefore: res.headersSent });
        }
      });
    });

    app.get('/miss-nocb', (_req: Request, res: Response) => {
      res.sendFile('missing.txt', { root: rootDir });
    });

    app.get('/dir-cb', (_req: Request, res: Response) => {
      res.sendFile('sub', { root: rootDir }, (err?: Error) => {
        if (err && !res.headersSent) {
          res.status(404).json({ isDirErr: true, headersSent: res.headersSent });
        }
      });
    });

    app.get('/dir-nocb', (_req: Request, res: Response) => {
      res.sendFile('sub', { root: rootDir });
    });

    app.get('/no-root', (_req: Request, res: Response) => {
      res.sendFile('relative.txt');
    });

    app.get('/dot-deny', (_req: Request, res: Response) => {
      res.sendFile('.secret', { root: rootDir, dotfiles: 'deny' });
    });
    app.get('/dot-ignore', (_req: Request, res: Response) => {
      res.sendFile('.secret', { root: rootDir, dotfiles: 'ignore' });
    });
    app.get('/dot-allow', (_req: Request, res: Response) => {
      res.sendFile('.secret', { root: rootDir, dotfiles: 'allow' });
    });

    app.get('/opts-off', (_req: Request, res: Response) => {
      res.sendFile('ten.txt', {
        root: rootDir,
        acceptRanges: false,
        lastModified: false,
        cacheControl: false,
      });
    });

    app.get('/opts-cc', (_req: Request, res: Response) => {
      res.sendFile('ten.txt', {
        root: rootDir,
        maxAge: '1h',
        immutable: true,
      });
    });

    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const e = err as { name?: string; message?: string; status?: number };
      res.status(e.status || 500).json({ errorName: e.name || 'Error', message: e.message || '' });
    });

    const { base } = startApp(app);

    const rTrav = await fetch(`${base}/trav`);
    expect(rTrav.status).toBe(403);
    expect(await rTrav.json()).toEqual({ rejected: true, headersSent: false });

    const rSym = await fetch(`${base}/sym`);
    expect(rSym.status).toBe(403);
    expect(await rSym.json()).toEqual({ symRejected: true, headersSent: false });

    const rMissCb = await fetch(`${base}/miss-cb`);
    expect(rMissCb.status).toBe(404);
    expect(await rMissCb.json()).toEqual({ miss: true, headersSentBefore: false });

    const rMissNoCb = await fetch(`${base}/miss-nocb`);
    expect(rMissNoCb.status).toBe(404);

    const rDirCb = await fetch(`${base}/dir-cb`);
    expect(rDirCb.status).toBe(404);
    expect(await rDirCb.json()).toEqual({ isDirErr: true, headersSent: false });

    const rDirNoCb = await fetch(`${base}/dir-nocb`);
    expect(rDirNoCb.status).toBe(404);

    const rNoRoot = await fetch(`${base}/no-root`);
    expect(rNoRoot.status).toBe(500);
    const noRootBody = (await rNoRoot.json()) as { errorName: string };
    expect(noRootBody.errorName).toBe('TypeError');

    expect((await fetch(`${base}/dot-deny`)).status).toBe(403);
    expect((await fetch(`${base}/dot-ignore`)).status).toBe(404);
    const rDotAllow = await fetch(`${base}/dot-allow`);
    expect(rDotAllow.status).toBe(200);
    expect(await rDotAllow.text()).toBe('hidden');

    const rOff = await fetch(`${base}/opts-off`, { headers: { Range: 'bytes=0-2' } });
    expect(rOff.status).toBe(200);
    expect(await rOff.text()).toBe('0123456789');
    expect(rOff.headers.get('accept-ranges')).toBeNull();
    expect(rOff.headers.get('last-modified')).toBeNull();
    expect(rOff.headers.get('cache-control')).toBeNull();

    const rCc = await fetch(`${base}/opts-cc`);
    expect(rCc.status).toBe(200);
    expect(rCc.headers.get('cache-control')).toBe('public, max-age=3600, immutable');
  });

  it('res.download escapes filename, preserves source Content-Type, and does not leak headers on error', async () => {
    const ws = makeTempDir('rxpress-test-dl-');
    writeFileSync(join(ws, 'source.pdf'), '%PDF-1.4\nbody');

    const app = rxpress();
    app.get('/dl', (_req: Request, res: Response) => {
      res.download('source.pdf', 'report "2026".pdf', { root: ws });
    });
    app.get('/dl-miss', (_req: Request, res: Response) => {
      res.download('missing.pdf', 'out.pdf', { root: ws }, (err?: Error) => {
        if (err && !res.headersSent) {
          res.status(404).json({
            hasDisposition: res.hasHeader('content-disposition'),
            headersSent: res.headersSent,
          });
        }
      });
    });

    const { base } = startApp(app);

    const rDl = await fetch(`${base}/dl`);
    expect(rDl.status).toBe(200);
    expect(rDl.headers.get('content-disposition')).toBe(
      'attachment; filename="report \\"2026\\".pdf"'
    );
    expect(rDl.headers.get('content-type')).toContain('application/pdf');
    expect(await rDl.text()).toBe('%PDF-1.4\nbody');

    const rMiss = await fetch(`${base}/dl-miss`);
    expect(rMiss.status).toBe(404);
    expect(await rMiss.json()).toEqual({ hasDisposition: false, headersSent: false });
  });

  it('handles RFC 9110 Range, If-Range, 0-byte 416, multi-range 200, and cached static Ranges', async () => {
    const ws = makeTempDir('rxpress-test-range-');
    writeFileSync(join(ws, 'ten.txt'), '0123456789');
    writeFileSync(join(ws, 'empty.txt'), '');

    const app = rxpress();
    app.use('/static', rxpress.static(ws, { maxAge: '1h', immutable: true }));
    app.get('/sf', (_req: Request, res: Response) => {
      res.sendFile('ten.txt', { root: ws });
    });

    const { base } = startApp(app);

    // Populate TL_STATIC_CACHE first
    const initStatic = await fetch(`${base}/static/ten.txt`);
    expect(initStatic.status).toBe(200);
    const etag = initStatic.headers.get('etag')!;
    const lm = initStatic.headers.get('last-modified')!;
    expect(initStatic.headers.get('cache-control')).toBe('public, max-age=3600, immutable');

    // Cached static Range + If-Range
    const rCached206 = await fetch(`${base}/static/ten.txt`, {
      headers: { Range: 'BYTES=2-5', 'If-Range': etag },
    });
    expect(rCached206.status).toBe(206);
    expect(rCached206.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await rCached206.text()).toBe('2345');

    const rCachedStaleIr = await fetch(`${base}/static/ten.txt`, {
      headers: { Range: 'bytes=2-5', 'If-Range': '"stale"' },
    });
    expect(rCachedStaleIr.status).toBe(200);
    expect(await rCachedStaleIr.text()).toBe('0123456789');

    // sendFile Range edge cases
    const rLmMatch = await fetch(`${base}/sf`, {
      headers: { Range: 'bytes=0-3', 'If-Range': lm },
    });
    expect(rLmMatch.status).toBe(206);
    expect(await rLmMatch.text()).toBe('0123');

    const rZero416 = await fetch(`${base}/static/empty.txt`, {
      headers: { Range: 'bytes=0-0' },
    });
    expect(rZero416.status).toBe(416);
    expect(rZero416.headers.get('content-range')).toBe('bytes */0');

    const rMulti = await fetch(`${base}/sf`, { headers: { Range: 'bytes=0-1, 3-4' } });
    expect(rMulti.status).toBe(200);
    expect(await rMulti.text()).toBe('0123456789');

    const rBadSyntax = await fetch(`${base}/sf`, { headers: { Range: 'bytes=10-5' } });
    expect(rBadSyntax.status).toBe(200);
    expect(await rBadSyntax.text()).toBe('0123456789');
  });

  it('hardens Rust StaticMount (405, redirect, route precedence) and async JS serveStatic fallback', async () => {
    const ws = makeTempDir('rxpress-test-static-');
    const pub = join(ws, 'pub');
    const outside = join(ws, 'outside');
    mkdirSync(pub);
    mkdirSync(join(pub, 'sub'));
    mkdirSync(outside);
    writeFileSync(join(pub, 'index.html'), '<h1>Root</h1>');
    writeFileSync(join(pub, 'sub', 'index.html'), '<h1>Sub</h1>');
    writeFileSync(join(pub, 'foo..bar.txt'), 'dots-ok');
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE');
    symlinkSync(join(outside, 'secret.txt'), join(pub, 'sym-out.txt'));
    symlinkSync(join(ws, 'does-not-exist.txt'), join(pub, 'broken-sym.txt'));

    // 1. Rust StaticMount: fallthrough: false -> 405, redirect: true -> 301
    const appRust = rxpress();
    appRust.use('/assets', rxpress.static(pub, { fallthrough: false, redirect: true }));
    const srvRust = startApp(appRust);

    const rRedir = await fetch(`${srvRust.base}/assets/sub?x=1`, { redirect: 'manual' });
    expect(rRedir.status).toBe(301);
    expect(rRedir.headers.get('location')).toBe('/assets/sub/?x=1');

    const r405 = await fetch(`${srvRust.base}/assets/foo..bar.txt`, { method: 'POST', body: 'hi' });
    expect(r405.status).toBe(405);
    expect(r405.headers.get('allow')).toBe('GET, HEAD');

    // 2. Route registered BEFORE express.static must NOT be shadowed by Rust StaticMount
    const appOrder = rxpress();
    appOrder.post('/assets/api', (_req: Request, res: Response) => {
      res.json({ postOk: true });
    });
    appOrder.use('/assets', rxpress.static(pub, { fallthrough: false }));
    const srvOrder = startApp(appOrder);

    const rPostOrder = await fetch(`${srvOrder.base}/assets/api`, { method: 'POST' });
    expect(rPostOrder.status).toBe(200);
    expect(await rPostOrder.json()).toEqual({ postOk: true });

    // 3. Async JS serveStatic fallback (forced via preceding JS middleware + setHeaders)
    const appJs = rxpress();
    let seenStatSize = -1;
    appJs.use((_req: Request, _res: Response, next: NextFunction) => next());
    appJs.use(
      '/js',
      rxpress.static(pub, {
        fallthrough: false,
        redirect: false,
        extensions: ['txt'],
        setHeaders: ((res: Response, _path: string, st?: { size: number }) => {
          res.setHeader('X-JS-Static', '1');
          if (st) seenStatSize = st.size;
        }) as unknown as (res: Response, path: string) => void,
      })
    );
    const srvJs = startApp(appJs);

    const rDots = await fetch(`${srvJs.base}/js/foo..bar.txt`);
    expect(rDots.status).toBe(200);
    expect(await rDots.text()).toBe('dots-ok');
    expect(rDots.headers.get('x-js-static')).toBe('1');
    expect(seenStatSize).toBe(7);

    // Regular file with trailing slash -> 404
    expect((await fetch(`${srvJs.base}/js/foo..bar.txt/`)).status).toBe(404);
    // Directory without trailing slash and redirect: false -> 404
    expect((await fetch(`${srvJs.base}/js/sub`)).status).toBe(404);
    // Directory with trailing slash -> index.html
    const rSubIdx = await fetch(`${srvJs.base}/js/sub/`);
    expect(rSubIdx.status).toBe(200);
    expect(await rSubIdx.text()).toBe('<h1>Sub</h1>');

    // Symlink escape -> 403, broken symlink -> 404
    expect((await fetch(`${srvJs.base}/js/sym-out.txt`)).status).toBe(403);
    expect((await fetch(`${srvJs.base}/js/broken-sym.txt`)).status).toBe(404);

    // Non-GET/HEAD -> 405
    const rJs405 = await fetch(`${srvJs.base}/js/foo..bar.txt`, { method: 'POST' });
    expect(rJs405.status).toBe(405);
    expect(rJs405.headers.get('allow')).toBe('GET, HEAD');

    // Cleanup chmod if any
    try {
      chmodSync(pub, 0o755);
    } catch {
      // ignore
    }
  });

  it('notifies req.on("close") when an aborted backpressured stream had _endPending === true', async () => {
    const app = rxpress();
    app.set('streamQueueCapacity', 2);

    let enteredEndPending = false;
    let reqCloseFired = false;
    let resCloseFired = false;
    let endCbFired = false;

    app.get('/bp-abort', (req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.flushHeaders();
      req.on('close', () => {
        reqCloseFired = true;
      });
      res.on('close', () => {
        resCloseFired = true;
      });

      const chunk = Buffer.alloc(64 * 1024, 0x43);
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const pump = () => {
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
        while (!res.writableEnded) {
          if (!res.write(chunk)) {
            // Wait briefly: if Rust TCP write_all is genuinely stalled on paused client,
            // drain will NOT fire within 60ms, so we enter _endPending while backpressured.
            stallTimer = setTimeout(() => {
              if (!res.writableEnded && res.writableNeedDrain) {
                enteredEndPending = true;
                res.end('TAIL', () => {
                  endCbFired = true;
                });
              }
            }, 60);
            return;
          }
        }
      };
      res.on('drain', pump);
      setTimeout(pump, 20);
    });

    const { port } = startApp(app);
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.write('GET /bp-abort HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
        sock.pause();
        const deadline = Date.now() + 3000;
        const waitAndDestroy = () => {
          if (enteredEndPending || Date.now() >= deadline) {
            sock.destroy();
            resolve();
          } else {
            setTimeout(waitAndDestroy, 15);
          }
        };
        setTimeout(waitAndDestroy, 40);
      });
      sock.on('error', reject);
    });

    for (let i = 0; i < 60 && (!reqCloseFired || !resCloseFired || !endCbFired); i++) {
      await new Promise<void>((r) => setTimeout(r, 15));
    }
    expect(enteredEndPending).toBe(true);
    expect(reqCloseFired).toBe(true);
    expect(resCloseFired).toBe(true);
    expect(endCbFired).toBe(true);
  });

  it('preserves percent-encoding on 301 directory redirects in JS fallback express.static matching Rust native', async () => {
    const ws = makeTempDir('rxpress-test-redir-');
    mkdirSync(join(ws, 'my dir'));
    writeFileSync(join(ws, 'my dir', 'index.html'), 'SPACE_INDEX');

    const appRust = rxpress();
    appRust.use('/rust', rxpress.static(ws));
    const srvRust = startApp(appRust);

    const appJsPrior = rxpress();
    appJsPrior.use((_req: Request, _res: Response, next: NextFunction) => next());
    appJsPrior.use('/js', rxpress.static(ws));
    const srvJsPrior = startApp(appJsPrior);

    const appJsSetHdr = rxpress();
    appJsSetHdr.use(
      '/js-sh',
      rxpress.static(ws, {
        setHeaders: (res: Response) => {
          res.setHeader('X-Custom', '1');
        },
      })
    );
    const srvJsSetHdr = startApp(appJsSetHdr);

    for (const [base, prefix] of [
      [srvRust.base, '/rust'],
      [srvJsPrior.base, '/js'],
      [srvJsSetHdr.base, '/js-sh'],
    ] as const) {
      const rRedir = await fetch(`${base}${prefix}/my%20dir?x=1`, { redirect: 'manual' });
      expect(rRedir.status).toBe(301);
      const loc = rRedir.headers.get('location');
      expect(loc).toBe(`${prefix}/my%20dir/?x=1`);
      expect(loc).not.toContain('%2520');

      const rFollow = await fetch(`${base}${loc}`);
      expect(rFollow.status).toBe(200);
      expect(await rFollow.text()).toBe('SPACE_INDEX');
    }
  });

  it('forwards res.sendFile errors without cb to Express error middleware across sub-routers and sync validation failures', async () => {
    const ws = makeTempDir('rxpress-test-sf-router-');
    const pub = join(ws, 'pub');
    const outside = join(ws, 'outside');
    mkdirSync(pub);
    mkdirSync(join(pub, 'sub'));
    mkdirSync(outside);
    writeFileSync(join(pub, 'ten.txt'), '0123456789');
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE');

    const app = rxpress();
    // app.all disables fastRoutes compilation so sub-router routes run via this._router.handle
    app.all('/block-fast', (_req: Request, _res: Response, next: NextFunction) => next());

    const router = rxpress.Router();
    router.get('/miss', (_req: Request, res: Response) => {
      res.sendFile('missing.txt', { root: pub });
    });
    router.get('/trav', (_req: Request, res: Response) => {
      res.sendFile('../outside/secret.txt', { root: pub });
    });
    app.use('/r', router);

    app.get('/fast-trav', (_req: Request, res: Response) => {
      res.sendFile('../outside/secret.txt', { root: pub });
    });

    app.get('/sub-dotdot', (_req: Request, res: Response) => {
      res.sendFile('sub/../ten.txt', { root: pub }, (err?: Error) => {
        if (err && !res.headersSent) {
          const st = (err as { status?: number }).status ?? 403;
          res.status(st).json({ caughtCb: true, status: st, headersSent: res.headersSent });
        }
      });
    });

    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const e = err as { status?: number; statusCode?: number; message?: string };
      const st = e.status ?? e.statusCode ?? 500;
      res.status(st).json({ caughtByErrorMiddleware: true, status: st });
    });

    const { base } = startApp(app);

    const rMiss = await fetch(`${base}/r/miss`);
    expect(rMiss.status).toBe(404);
    expect(await rMiss.json()).toEqual({ caughtByErrorMiddleware: true, status: 404 });

    const rTrav = await fetch(`${base}/r/trav`);
    expect(rTrav.status).toBe(403);
    expect(await rTrav.json()).toEqual({ caughtByErrorMiddleware: true, status: 403 });

    const rFastTrav = await fetch(`${base}/fast-trav`);
    expect(rFastTrav.status).toBe(403);
    expect(await rFastTrav.json()).toEqual({ caughtByErrorMiddleware: true, status: 403 });

    // Like send: `sub/../ten.txt` normalizes to `ten.txt`, still inside the root.
    const rSubDotDot = await fetch(`${base}/sub-dotdot`);
    expect(rSubDotDot.status).toBe(200);
  });

  it('survives parallel multi-connection TL_STATIC_CACHE churn across >300 files without corruption', async () => {
    const ws = makeTempDir('rxpress-test-cache-churn-');
    const fileCount = 320;
    const expectedBodies: string[] = [];
    for (let i = 0; i < fileCount; i++) {
      const body = `FILE_CONTENT_${String(i).padStart(3, '0')}_${'X'.repeat(240)}`;
      expectedBodies.push(body);
      writeFileSync(join(ws, `f${i}.txt`), body);
    }

    const app = rxpress();
    app.use('/st', rxpress.static(ws, { maxAge: '60s' }));
    const { port } = startApp(app);

    const agent = new Agent({ keepAlive: true, maxSockets: 16 });
    const fetchKeepAlive = (
      path: string,
      headers?: Record<string, string>
    ): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path, method: 'GET', agent, headers },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              });
            });
          }
        );
        req.on('error', reject);
        req.end();
      });

    try {
      const workers = Array.from({ length: 16 }, (_v, workerId) =>
        (async () => {
          for (let step = 0; step < 60; step++) {
            const idx = (workerId * 37 + step * 7) % fileCount;
            if (step % 5 === 0) {
              const r = await fetchKeepAlive(`/st/f${idx}.txt`, { Range: 'bytes=0-15' });
              expect(r.status).toBe(206);
              expect(r.body).toBe(expectedBodies[idx].slice(0, 16));
            } else {
              const r = await fetchKeepAlive(`/st/f${idx}.txt`);
              expect(r.status).toBe(200);
              expect(r.body).toBe(expectedBodies[idx]);
            }
          }
        })()
      );
      await Promise.all(workers);
    } finally {
      agent.destroy();
    }
  });

  it('enforces forward-only error middleware ordering across app and sub-routers for res.sendFile without cb', async () => {
    const ws = makeTempDir('rxpress-test-scenario-c-');
    const pub = join(ws, 'pub');
    const outside = join(ws, 'outside');
    mkdirSync(pub);
    mkdirSync(outside);
    writeFileSync(join(pub, 'ten.txt'), '0123456789');
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE');

    const app = rxpress();

    // Early app error middleware must NEVER catch errors from later routes/sub-routers
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const st = (err as { status?: number }).status ?? 500;
      res.status(599).json({ where: 'WRONG_EARLY_APP_ERR', status: st });
    });

    const r1 = rxpress.Router();
    r1.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const st = (err as { status?: number }).status ?? 500;
      res.status(598).json({ where: 'WRONG_R1_ERR', status: st });
    });
    app.use('/s', r1);

    const r2 = rxpress.Router();
    r2.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const st = (err as { status?: number }).status ?? 500;
      res.status(597).json({ where: 'WRONG_R2_EARLY_ERR', status: st });
    });
    r2.get('/sf-miss', (_req: Request, res: Response) => {
      res.sendFile('missing.txt', { root: pub });
    });
    r2.get('/sf-trav', (_req: Request, res: Response) => {
      res.sendFile('../outside/secret.txt', { root: pub });
    });
    r2.route('/chained-miss').get(
      (_req: Request, _res: Response, next: NextFunction) => next(),
      (_req: Request, res: Response) => {
        res.sendFile('missing.txt', { root: pub });
      }
    );
    r2.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const st = (err as { status?: number }).status ?? 500;
      res.status(st).json({ where: 'RIGHT_R2_LATE_ERR', status: st });
    });
    app.use('/s', r2);

    // Sync route to verify pooled req.next does not leak across requests
    app.get('/sync-check', (req: Request, res: Response) => {
      const hasNext = typeof (req as unknown as { next?: unknown }).next === 'function';
      res.json({ hasNext });
    });

    app.get('/top-miss', (_req: Request, res: Response) => {
      res.sendFile('missing.txt', { root: pub });
    });

    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const st = (err as { status?: number }).status ?? 500;
      res.status(st).json({ where: 'RIGHT_APP_LATE_ERR', status: st });
    });

    const { base } = startApp(app);

    const rMiss = await fetch(`${base}/s/sf-miss`);
    expect(rMiss.status).toBe(404);
    expect(await rMiss.json()).toEqual({ where: 'RIGHT_R2_LATE_ERR', status: 404 });

    const rTrav = await fetch(`${base}/s/sf-trav`);
    expect(rTrav.status).toBe(403);
    expect(await rTrav.json()).toEqual({ where: 'RIGHT_R2_LATE_ERR', status: 403 });

    const rChained = await fetch(`${base}/s/chained-miss`);
    expect(rChained.status).toBe(404);
    expect(await rChained.json()).toEqual({ where: 'RIGHT_R2_LATE_ERR', status: 404 });

    const rTop = await fetch(`${base}/top-miss`);
    expect(rTop.status).toBe(404);
    expect(await rTop.json()).toEqual({ where: 'RIGHT_APP_LATE_ERR', status: 404 });

    // Confirm sync route after wrapped routes still gets a clean req and completes properly
    const rSync = await fetch(`${base}/sync-check`);
    expect(rSync.status).toBe(200);
    expect(await rSync.json()).toEqual({ hasNext: true });

    // Confirm pooled req.next does NOT leak across sync fastRoute requests when a wrapped handler ran synchronously
    const fastApp = rxpress();
    fastApp.get('/fast-pure', (req: Request, res: Response, next: NextFunction) => {
      // Express sets req.next to the current handler's next: it must never be another request's.
      res.json({ leakedNext: (req as unknown as { next?: unknown }).next !== next });
    });
    fastApp.get('/fast-to-wrapped', (_req: Request, _res: Response, next: NextFunction) => next());
    fastApp.use('/fast-to-wrapped', (_req: Request, res: Response) => {
      res.json({ ok: true });
    });
    const fastSrv = startApp(fastApp);
    const rW = await fetch(`${fastSrv.base}/fast-to-wrapped`);
    expect(rW.status).toBe(200);
    const rPure = await fetch(`${fastSrv.base}/fast-pure`);
    expect(rPure.status).toBe(200);
    expect(await rPure.json()).toEqual({ leakedNext: false });
  });

  it('continues downstream with full req.path when res.sendFile targets a directory without cb inside a mounted router', async () => {
    const ws = makeTempDir('rxpress-test-sf-dir-');
    const pub = join(ws, 'pub');
    mkdirSync(pub);
    mkdirSync(join(pub, 'subdir'));

    const app = rxpress();
    const mRouter = rxpress.Router();
    mRouter.get('/sf-dir', (_req: Request, res: Response) => {
      res.sendFile('subdir', { root: pub });
    });
    mRouter.get('/sf-dir-down', (_req: Request, res: Response) => {
      res.sendFile('subdir', { root: pub });
    });
    app.use('/m', mRouter);
    app.get('/m/sf-dir-down', (_req: Request, res: Response) => {
      res.status(200).json({ downstream: true, path: '/m/sf-dir-down' });
    });

    const { base } = startApp(app);

    const rUnhandled = await fetch(`${base}/m/sf-dir`);
    expect(rUnhandled.status).toBe(404);
    expect(await rUnhandled.text()).toContain('<pre>Cannot GET /m/sf-dir</pre>');

    const rDownstream = await fetch(`${base}/m/sf-dir-down`);
    expect(rDownstream.status).toBe(200);
    expect(await rDownstream.json()).toEqual({ downstream: true, path: '/m/sf-dir-down' });
  });

  it('defaults res.sendFile cacheControl to true (public, max-age=0) and honors cacheControl: false', async () => {
    const ws = makeTempDir('rxpress-test-sf-cc-');
    writeFileSync(join(ws, 'ten.txt'), '0123456789');

    const app = rxpress();
    app.get('/sf-default', (_req: Request, res: Response) => {
      res.sendFile('ten.txt', { root: ws });
    });
    app.get('/sf-cc-false', (_req: Request, res: Response) => {
      res.sendFile('ten.txt', { root: ws, cacheControl: false, maxAge: 30000 });
    });
    app.get('/sf-cc-immutable', (_req: Request, res: Response) => {
      res.sendFile('ten.txt', { root: ws, maxAge: 30000, immutable: true });
    });

    const { base } = startApp(app);

    const rDefault = await fetch(`${base}/sf-default`);
    expect(rDefault.status).toBe(200);
    expect(await rDefault.text()).toBe('0123456789');
    expect(rDefault.headers.get('cache-control')).toBe('public, max-age=0');

    const rFalse = await fetch(`${base}/sf-cc-false`);
    expect(rFalse.status).toBe(200);
    expect(await rFalse.text()).toBe('0123456789');
    expect(rFalse.headers.get('cache-control')).toBeNull();

    const rImmutable = await fetch(`${base}/sf-cc-immutable`);
    expect(rImmutable.status).toBe(200);
    expect(await rImmutable.text()).toBe('0123456789');
    expect(rImmutable.headers.get('cache-control')).toBe('public, max-age=30, immutable');
  });
});

function generateSelfSignedCert(): { key: Buffer; cert: Buffer } {
  const dir = makeTempDir('rxpress-test-tls-');
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=127.0.0.1"`,
    { stdio: 'ignore' }
  );
  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}

function httpsFetchText(
  port: number,
  path: string
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        rejectUnauthorized: false,
        timeout: 2000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`TLS request timeout for ${path}`));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('regressions: repeated listen(), 4-arg error handlers and param() async next', () => {
  it('preserves req.next and leakedNext: false across repeated app.listen() and app.listenTls() on the same Application', async () => {
    const ws = makeTempDir('rxpress-test-repeat-listen-');
    const pub = join(ws, 'pub');
    mkdirSync(pub);
    mkdirSync(join(pub, 'subdir'));

    const app = rxpress();
    app.get('/fast-pure', (req: Request, res: Response, next: NextFunction) => {
      // Express sets req.next to the current handler's next: it must never be another request's.
      res.json({ leakedNext: (req as unknown as { next?: unknown }).next !== next });
    });
    app.get('/fast-miss', (_req: Request, res: Response) => {
      res.sendFile('missing.txt', { root: pub });
    });
    app.get('/fast-dir', (_req: Request, res: Response) => {
      res.sendFile('subdir', { root: pub });
    });
    app.get('/fast-async-next', (req: Request, _res: Response) => {
      queueMicrotask(() => {
        (req as unknown as { next?: (e?: unknown) => void }).next?.(
          Object.assign(new Error('async'), { status: 502 })
        );
      });
    });
    app.get('/fast-stream-async-err', (req: Request, res: Response) => {
      res.write('part1-');
      queueMicrotask(() => {
        (req as unknown as { next?: (e?: unknown) => void }).next?.(
          Object.assign(new Error('stream async'), { status: 503 })
        );
      });
    });
    app.use((_req: Request, _res: Response, next: NextFunction) => next());
    app.get('/chain-miss', (_req: Request, res: Response) => {
      res.sendFile('missing.txt', { root: pub });
    });
    app.use('/fast-dir', (_req: Request, res: Response) => {
      res.status(200).json({ downstream: true });
    });
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const e = err as { status?: number; message?: string };
      if (res.headersSent) {
        res.end(`|CAUGHT:${e.message ?? 'err'}`);
        return;
      }
      const st = e.status ?? 500;
      res.status(st).json({ caught: true, status: st });
    });

    const s1 = startApp(app);
    const s2 = startApp(app);
    const { key, cert } = generateSelfSignedCert();
    const tlsHandle = app.listenTls({ key, cert }, 0, '127.0.0.1');
    activeServers.push(tlsHandle);
    const tlsPort = tlsHandle.address()!.port;

    for (const base of [s1.base, s2.base]) {
      const rMiss = await fetch(`${base}/fast-miss`, { signal: AbortSignal.timeout(2000) });
      expect(rMiss.status).toBe(404);
      expect(await rMiss.json()).toEqual({ caught: true, status: 404 });

      const rDir = await fetch(`${base}/fast-dir`, { signal: AbortSignal.timeout(2000) });
      expect(rDir.status).toBe(200);
      expect(await rDir.json()).toEqual({ downstream: true });

      const rAsync = await fetch(`${base}/fast-async-next`, { signal: AbortSignal.timeout(2000) });
      expect(rAsync.status).toBe(502);
      expect(await rAsync.json()).toEqual({ caught: true, status: 502 });

      const rStream = await fetch(`${base}/fast-stream-async-err`, { signal: AbortSignal.timeout(2000) });
      expect(rStream.status).toBe(200);
      expect(await rStream.text()).toBe('part1-|CAUGHT:stream async');

      const rChain = await fetch(`${base}/chain-miss`, { signal: AbortSignal.timeout(2000) });
      expect(rChain.status).toBe(404);
      expect(await rChain.json()).toEqual({ caught: true, status: 404 });

      const rPure = await fetch(`${base}/fast-pure`, { signal: AbortSignal.timeout(2000) });
      expect(rPure.status).toBe(200);
      expect(await rPure.json()).toEqual({ leakedNext: false });
    }

    const tlsMiss = await httpsFetchText(tlsPort, '/fast-miss');
    expect(tlsMiss.status).toBe(404);
    expect(JSON.parse(tlsMiss.text)).toEqual({ caught: true, status: 404 });

    const tlsDir = await httpsFetchText(tlsPort, '/fast-dir');
    expect(tlsDir.status).toBe(200);
    expect(JSON.parse(tlsDir.text)).toEqual({ downstream: true });

    const tlsAsync = await httpsFetchText(tlsPort, '/fast-async-next');
    expect(tlsAsync.status).toBe(502);
    expect(JSON.parse(tlsAsync.text)).toEqual({ caught: true, status: 502 });

    const tlsStream = await httpsFetchText(tlsPort, '/fast-stream-async-err');
    expect(tlsStream.status).toBe(200);
    expect(tlsStream.text).toBe('part1-|CAUGHT:stream async');

    const tlsChain = await httpsFetchText(tlsPort, '/chain-miss');
    expect(tlsChain.status).toBe(404);
    expect(JSON.parse(tlsChain.text)).toEqual({ caught: true, status: 404 });

    const tlsPure = await httpsFetchText(tlsPort, '/fast-pure');
    expect(tlsPure.status).toBe(200);
    expect(JSON.parse(tlsPure.text)).toEqual({ leakedNext: false });
  });

  it('forwards 4-arg error handler res.sendFile without cb across fast-throw, non-fast, route-level, and dir continuation without looping or hanging', async () => {
    const ws = makeTempDir('rxpress-test-err-sf-');
    const pub = join(ws, 'pub');
    mkdirSync(pub);
    mkdirSync(join(pub, 'subdir'));

    let err1Calls = 0;
    const app = rxpress();

    app.get('/fast-throw', () => {
      throw Object.assign(new Error('fast'), { status: 418 });
    });

    const r = rxpress.Router();
    r.get('/mw-next-err', (_req: Request, _res: Response, next: NextFunction) => {
      next(Object.assign(new Error('mw'), { status: 419 }));
    });
    r.route('/route-err-sf').get(
      (_req: Request, _res: Response, next: NextFunction) => {
        next(Object.assign(new Error('route'), { status: 420 }));
      },
      (_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        res.sendFile('missing-route-err.txt', { root: pub });
      }
    );
    app.use('/sub', r);

    app.get('/err-sf', () => {
      throw Object.assign(new Error('non-fast'), { status: 421 });
    });

    app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      err1Calls++;
      res.sendFile('missing-app-err.txt', { root: pub });
    });
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const st = (err as { status?: number }).status ?? 500;
      res.status(521).json({ where: 'SECOND_APP_ERR', status: st, err1Calls });
    });

    const { base } = startApp(app);

    err1Calls = 0;
    const rFast = await fetch(`${base}/fast-throw`, { signal: AbortSignal.timeout(2000) });
    expect(rFast.status).toBe(521);
    expect(await rFast.json()).toEqual({ where: 'SECOND_APP_ERR', status: 404, err1Calls: 1 });

    err1Calls = 0;
    const rErrSf = await fetch(`${base}/err-sf`, { signal: AbortSignal.timeout(2000) });
    expect(rErrSf.status).toBe(521);
    expect(await rErrSf.json()).toEqual({ where: 'SECOND_APP_ERR', status: 404, err1Calls: 1 });

    err1Calls = 0;
    const rMwErr = await fetch(`${base}/sub/mw-next-err`, { signal: AbortSignal.timeout(2000) });
    expect(rMwErr.status).toBe(521);
    expect(await rMwErr.json()).toEqual({ where: 'SECOND_APP_ERR', status: 404, err1Calls: 1 });

    err1Calls = 0;
    const rRouteErr = await fetch(`${base}/sub/route-err-sf`, { signal: AbortSignal.timeout(2000) });
    expect(rRouteErr.status).toBe(521);
    expect(await rRouteErr.json()).toEqual({ where: 'SECOND_APP_ERR', status: 404, err1Calls: 1 });

    // Directory continuation from 4-arg error handler clears error and reaches downstream normal handler
    const dirApp = rxpress();
    dirApp.get('/dir-err', () => {
      throw new Error('trigger dir fallback');
    });
    dirApp.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.sendFile('subdir', { root: pub });
    });
    dirApp.use('/dir-err', (_req: Request, res: Response) => {
      res.status(200).json({ recoveredFromDir: true });
    });
    const dirSrv = startApp(dirApp);
    const rDirCont = await fetch(`${dirSrv.base}/dir-err`, { signal: AbortSignal.timeout(2000) });
    expect(rDirCont.status).toBe(200);
    expect(await rDirCont.json()).toEqual({ recoveredFromDir: true });
  });

  it('wires req.next for app.param(), router.param() (with and without prior middleware), and mounted subApp.param()', async () => {
    const ws = makeTempDir('rxpress-test-param-sf-');
    const pub = join(ws, 'pub');
    mkdirSync(pub);
    mkdirSync(join(pub, 'subdir'));
    writeFileSync(join(pub, 'ok.txt'), 'PARAM_OK');

    const app = rxpress();

    const rWithMw = rxpress.Router();
    rWithMw.use((_req: Request, _res: Response, next: NextFunction) => next());
    rWithMw.param('rid', (_req: Request, res: Response, _next: NextFunction, val: string) => {
      res.sendFile(
        val === 'miss' ? 'no-such.txt' : val === 'dir' ? 'subdir' : 'ok.txt',
        { root: pub }
      );
    });
    rWithMw.get('/r-param/:rid', (_req: Request, res: Response) => {
      res.json({ where: 'R_DOWNSTREAM' });
    });
    rWithMw.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const st = (err as { status?: number }).status ?? 500;
      res.status(st).json({ where: 'R_ERR', status: st });
    });
    app.use('/r', rWithMw);

    const rNoMw = rxpress.Router();
    rNoMw.param('id', (_req: Request, res: Response, _next: NextFunction, val: string) => {
      res.sendFile(
        val === 'miss' ? 'no-such.txt' : val === 'dir' ? 'subdir' : 'ok.txt',
        { root: pub }
      );
    });
    rNoMw.get('/item/:id', (_req: Request, res: Response) => {
      res.json({ where: 'PR_DOWNSTREAM' });
    });
    rNoMw.get('/dir-fallthrough/:id', (_req: Request, _res: Response, next: NextFunction) => {
      next();
    });
    rNoMw.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const st = (err as { status?: number }).status ?? 500;
      res.status(st).json({ where: 'PARAM_ROUTER_ERR', status: st });
    });
    app.use('/pr', rNoMw);

    const { base } = startApp(app);

    const rWithMwMiss = await fetch(`${base}/r/r-param/miss`, { signal: AbortSignal.timeout(2000) });
    expect(rWithMwMiss.status).toBe(404);
    expect(await rWithMwMiss.json()).toEqual({ where: 'R_ERR', status: 404 });

    const rWithMwDir = await fetch(`${base}/r/r-param/dir`, { signal: AbortSignal.timeout(2000) });
    expect(rWithMwDir.status).toBe(200);
    expect(await rWithMwDir.json()).toEqual({ where: 'R_DOWNSTREAM' });

    const rWithMwOk = await fetch(`${base}/r/r-param/ok`, { signal: AbortSignal.timeout(2000) });
    expect(rWithMwOk.status).toBe(200);
    expect(await rWithMwOk.text()).toBe('PARAM_OK');

    const rNoMwMiss = await fetch(`${base}/pr/item/miss`, { signal: AbortSignal.timeout(2000) });
    expect(rNoMwMiss.status).toBe(404);
    expect(await rNoMwMiss.json()).toEqual({ where: 'PARAM_ROUTER_ERR', status: 404 });

    const rNoMwDir = await fetch(`${base}/pr/item/dir`, { signal: AbortSignal.timeout(2000) });
    expect(rNoMwDir.status).toBe(200);
    expect(await rNoMwDir.json()).toEqual({ where: 'PR_DOWNSTREAM' });

    const rNoMwFallthrough = await fetch(`${base}/pr/dir-fallthrough/dir`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(rNoMwFallthrough.status).toBe(404);
    expect(await rNoMwFallthrough.text()).toContain(
      '<pre>Cannot GET /pr/dir-fallthrough/dir</pre>'
    );

    // Top-level app.param() and mounted subApp.param() without prior middleware
    const appParam = rxpress();
    appParam.param('aid', (_req: Request, res: Response, _next: NextFunction, val: string) => {
      res.sendFile(
        val === 'miss' ? 'no-such.txt' : val === 'dir' ? 'subdir' : 'ok.txt',
        { root: pub }
      );
    });
    appParam.get('/app-param/:aid', (_req: Request, res: Response) => {
      res.json({ where: 'APP_DOWNSTREAM' });
    });
    appParam.get('/app-param-fallthrough/:aid', (_req: Request, _res: Response, next: NextFunction) => {
      next();
    });

    const subApp = rxpress();
    subApp.param('sid', (_req: Request, res: Response, _next: NextFunction, val: string) => {
      res.sendFile(val === 'miss' ? 'no-such.txt' : 'subdir', { root: pub });
    });
    subApp.get('/s/:sid', (_req: Request, res: Response) => {
      res.json({ where: 'SUBAPP_DOWNSTREAM' });
    });
    subApp.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const st = (err as { status?: number }).status ?? 500;
      res.status(st).json({ where: 'SUBAPP_ERR', status: st });
    });
    appParam.use('/subapp', subApp);

    appParam.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const st = (err as { status?: number }).status ?? 500;
      res.status(520).json({ where: 'APP_ERR', status: st });
    });

    const appSrv = startApp(appParam);

    const rAppMiss = await fetch(`${appSrv.base}/app-param/miss`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(rAppMiss.status).toBe(520);
    expect(await rAppMiss.json()).toEqual({ where: 'APP_ERR', status: 404 });

    const rAppDir = await fetch(`${appSrv.base}/app-param/dir`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(rAppDir.status).toBe(200);
    expect(await rAppDir.json()).toEqual({ where: 'APP_DOWNSTREAM' });

    const rAppFall = await fetch(`${appSrv.base}/app-param-fallthrough/dir`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(rAppFall.status).toBe(404);
    expect(await rAppFall.text()).toContain('<pre>Cannot GET /app-param-fallthrough/dir</pre>');

    const rSubMiss = await fetch(`${appSrv.base}/subapp/s/miss`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(rSubMiss.status).toBe(404);
    expect(await rSubMiss.json()).toEqual({ where: 'SUBAPP_ERR', status: 404 });

    const rSubDir = await fetch(`${appSrv.base}/subapp/s/dir`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(rSubDir.status).toBe(200);
    expect(await rSubDir.json()).toEqual({ where: 'SUBAPP_DOWNSTREAM' });
  });
});
