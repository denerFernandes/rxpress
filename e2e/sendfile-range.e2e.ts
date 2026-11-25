import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempWorkspace, type TempWorkspace } from './helpers/fixtures.js';
import { openRawSocket, sendRawHttp, type RawSocketClient } from './helpers/raw-http.js';
import {
  createApp,
  isExpressBaseline,
  startServer,
  type E2EErrorRequestHandler,
  type E2EResponse,
  type StartedServer,
} from './helpers/server.js';

const servers: StartedServer[] = [];
const clients: RawSocketClient[] = [];
const workspaces: TempWorkspace[] = [];

function trackServer(srv: StartedServer): StartedServer {
  servers.push(srv);
  return srv;
}

function trackClient(client: RawSocketClient): RawSocketClient {
  clients.push(client);
  return client;
}

function makeWorkspace(prefix: string): TempWorkspace {
  const ws = createTempWorkspace(prefix);
  workspaces.push(ws);
  return ws;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  let firstError: unknown;
  try {
    while (clients.length > 0) {
      try {
        clients.pop()?.destroy();
      } catch (err) {
        firstError ??= err;
      }
    }
  } finally {
    try {
      while (servers.length > 0) {
        try {
          await servers.pop()?.close();
        } catch (err) {
          firstError ??= err;
        }
      }
    } finally {
      while (workspaces.length > 0) {
        try {
          workspaces.pop()?.cleanup();
        } catch (err) {
          firstError ??= err;
        }
      }
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
});

describe('sendFile, download & HTTP Range / Conditional Requests', () => {
  it(
    'res.sendFile serves relative path with { root, headers, maxAge, immutable } + callback and absolute path',
    async () => {
      const ws = makeWorkspace('rxpress-fg06-t1-01-');
      const absPath = ws.writeFile('hello.txt', 'Hello sendFile!');

      let cbCalled = false;
      let cbErr: Error | null | undefined;

      const app = createApp();
      app.get('/rel', (_req, res) => {
        res.sendFile(
          'hello.txt',
          {
            root: ws.dir,
            headers: { 'X-File': '1' },
            maxAge: 60000,
            immutable: true,
          },
          (err) => {
            cbCalled = true;
            cbErr = err ?? null;
          }
        );
      });
      app.get('/abs', (_req, res) => {
        res.sendFile(absPath);
      });

      const srv = trackServer(await startServer(app));

      const relRes = await fetch(`${srv.baseUrl}/rel`);
      expect(relRes.status).toBe(200);
      expect(await relRes.text()).toBe('Hello sendFile!');
      expect(relRes.headers.get('x-file')).toBe('1');
      const cacheControl = relRes.headers.get('cache-control') ?? '';
      expect(cacheControl).toContain('max-age=60');
      expect(cacheControl).toContain('immutable');
      expect(relRes.headers.get('accept-ranges')).toBe('bytes');

      await waitForCondition(() => cbCalled, 200);
      expect(cbCalled).toBe(true);
      expect(cbErr).toBeNull();

      const absRes = await fetch(`${srv.baseUrl}/abs`);
      expect(absRes.status).toBe(200);
      expect(await absRes.text()).toBe('Hello sendFile!');
    }
  );

  it(
    'res.download sets Content-Disposition with escaped custom filename and preserves source Content-Type',
    async () => {
      const ws = makeWorkspace('rxpress-fg06-t1-02-');
      ws.writeFile('source.pdf', '%PDF-1.4\ntest');

      let cbCalled = false;
      let cbErr: Error | null | undefined;

      const app = createApp();
      app.get('/dl', (_req, res) => {
        res.download('source.pdf', 'report "2026".pdf', { root: ws.dir }, (err) => {
          cbCalled = true;
          cbErr = err ?? null;
        });
      });

      const srv = trackServer(await startServer(app));
      const res = await fetch(`${srv.baseUrl}/dl`);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="report \\"2026\\".pdf"'
      );
      expect(res.headers.get('content-type')).toContain('application/pdf');
      expect(await res.text()).toBe('%PDF-1.4\ntest');

      await waitForCondition(() => cbCalled, 200);
      expect(cbCalled).toBe(true);
      expect(cbErr).toBeNull();
    }
  );

  it(
    'single Range bytes=0-4, bytes=5-, and suffix bytes=-4 return 206 Partial Content (plus case-insensitive BYTES= on rxpress)',
    async () => {
      const ws = makeWorkspace('rxpress-fg06-t1-03-');
      ws.writeFile('ten.txt', '0123456789');

      const app = createApp();
      app.get('/ten', (_req, res) => {
        res.sendFile('ten.txt', { root: ws.dir });
      });

      const srv = trackServer(await startServer(app));

      const r1 = await fetch(`${srv.baseUrl}/ten`, { headers: { Range: 'bytes=0-4' } });
      expect(r1.status).toBe(206);
      expect(r1.headers.get('content-range')).toBe('bytes 0-4/10');
      expect(await r1.text()).toBe('01234');

      const r2 = await fetch(`${srv.baseUrl}/ten`, { headers: { Range: 'bytes=5-' } });
      expect(r2.status).toBe(206);
      expect(r2.headers.get('content-range')).toBe('bytes 5-9/10');
      expect(await r2.text()).toBe('56789');

      const r3 = await fetch(`${srv.baseUrl}/ten`, { headers: { Range: 'bytes=-4' } });
      expect(r3.status).toBe(206);
      expect(r3.headers.get('content-range')).toBe('bytes 6-9/10');
      expect(await r3.text()).toBe('6789');

      if (!isExpressBaseline()) {
        const rUpper = await fetch(`${srv.baseUrl}/ten`, { headers: { Range: 'BYTES=0-4' } });
        expect(rUpper.status).toBe(206);
        expect(rUpper.headers.get('content-range')).toBe('bytes 0-4/10');
        expect(await rUpper.text()).toBe('01234');
      }
    }
  );

  it(
    'If-Range serves 206 when matching ETag or Last-Modified and 200 full body when stale',
    async () => {
      const ws = makeWorkspace('rxpress-fg06-t1-04-');
      ws.writeFile('ten.txt', '0123456789');

      const app = createApp();
      app.get('/ten', (_req, res) => {
        res.sendFile('ten.txt', { root: ws.dir });
      });

      const srv = trackServer(await startServer(app));

      const initial = await fetch(`${srv.baseUrl}/ten`);
      expect(initial.status).toBe(200);
      const etag = initial.headers.get('etag');
      const lastModified = initial.headers.get('last-modified');
      expect(etag).toBeTruthy();
      expect(lastModified).toBeTruthy();

      const matchEtag = await fetch(`${srv.baseUrl}/ten`, {
        headers: { Range: 'bytes=0-3', 'If-Range': etag! },
      });
      expect(matchEtag.status).toBe(206);
      expect(await matchEtag.text()).toBe('0123');

      const matchLm = await fetch(`${srv.baseUrl}/ten`, {
        headers: { Range: 'bytes=0-3', 'If-Range': lastModified! },
      });
      expect(matchLm.status).toBe(206);
      expect(await matchLm.text()).toBe('0123');

      const mismatch = await fetch(`${srv.baseUrl}/ten`, {
        headers: { Range: 'bytes=0-3', 'If-Range': '"stale-etag"' },
      });
      expect(mismatch.status).toBe(200);
      expect(await mismatch.text()).toBe('0123456789');
    }
  );

  it(
    'If-None-Match and If-Modified-Since return 304 Not Modified with empty body',
    async () => {
      const ws = makeWorkspace('rxpress-fg06-t1-05-');
      ws.writeFile('ten.txt', '0123456789');

      const app = createApp();
      app.get('/ten', (_req, res) => {
        res.sendFile('ten.txt', { root: ws.dir });
      });

      const srv = trackServer(await startServer(app));

      const initial = await sendRawHttp(
        srv.host,
        srv.port,
        'GET /ten HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
      );
      expect(initial.statusCode).toBe(200);
      const etag = initial.headers['etag'];
      const lastModified = initial.headers['last-modified'];
      expect(typeof etag === 'string' && etag.length > 0).toBe(true);
      expect(typeof lastModified === 'string' && lastModified.length > 0).toBe(true);

      const conditionalRequests = [
        `GET /ten HTTP/1.1\r\nHost: 127.0.0.1\r\nIf-None-Match: ${String(etag)}\r\nConnection: close\r\n\r\n`,
        `GET /ten HTTP/1.1\r\nHost: 127.0.0.1\r\nIf-Modified-Since: ${String(lastModified)}\r\nConnection: close\r\n\r\n`,
      ];

      for (const rawReq of conditionalRequests) {
        const client = trackClient(await openRawSocket(srv.host, srv.port));
        await client.write(rawReq);
        const closed = await client.waitForClose(3000);
        expect(closed).toBe(true);

        const buf = client.getBufferedData();
        const hdrEnd = buf.indexOf('\r\n\r\n');
        expect(hdrEnd).toBeGreaterThan(0);

        const statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
        expect(statusLine).toContain(' 304 ');
        expect(buf.subarray(hdrEnd + 4).length).toBe(0);
      }
    }
  );

  it(
    '1.5MB binary file transferred via sendFile preserves exact byte length and SHA-256 digest',
    async () => {
      const ws = makeWorkspace('rxpress-fg06-t1-06-');
      const totalBytes = 1536 * 1024;
      const srcBuf = Buffer.allocUnsafe(totalBytes);
      for (let i = 0; i < totalBytes; i++) {
        srcBuf[i] = (i * 31 + (i >> 8)) & 0xff;
      }
      const expectedSha256 = createHash('sha256').update(srcBuf).digest('hex');
      const largePath = ws.writeFile('large.bin', srcBuf);

      const app = createApp();
      app.get('/large', (_req, res) => {
        res.sendFile(largePath);
      });

      const srv = trackServer(await startServer(app));
      const res = await fetch(`${srv.baseUrl}/large`);
      expect(res.status).toBe(200);

      const received = Buffer.from(await res.arrayBuffer());
      expect(received.length).toBe(totalBytes);
      const actualSha256 = createHash('sha256').update(received).digest('hex');
      expect(actualSha256).toBe(expectedSha256);
    }
  );

  it(
    'out-of-bounds Range and Range on 0-byte empty file return 416 with Content-Range bytes */len',
    async () => {
      const ws = makeWorkspace('rxpress-fg06-t2-01-');
      ws.writeFile('ten.txt', '0123456789');
      ws.writeFile('empty.txt', '');

      const app = createApp();
      app.get('/ten', (_req, res) => {
        res.sendFile('ten.txt', { root: ws.dir });
      });
      app.get('/empty', (_req, res) => {
        res.sendFile('empty.txt', { root: ws.dir });
      });

      const srv = trackServer(await startServer(app));

      const rOob = await fetch(`${srv.baseUrl}/ten`, { headers: { Range: 'bytes=100-200' } });
      expect(rOob.status).toBe(416);
      expect(rOob.headers.get('content-range')).toBe('bytes */10');

      const rEmpty = await fetch(`${srv.baseUrl}/empty`, { headers: { Range: 'bytes=0-0' } });
      expect(rEmpty.status).toBe(416);
      expect(rEmpty.headers.get('content-range')).toBe('bytes */0');
    }
  );

  it(
    'Range end clamped beyond EOF returns 206 and multi-range or syntactically invalid Range returns 200 full file',
    async () => {
      const ws = makeWorkspace('rxpress-fg06-t2-02-');
      ws.writeFile('ten.txt', '0123456789');

      const app = createApp();
      app.get('/ten', (_req, res) => {
        res.sendFile('ten.txt', { root: ws.dir });
      });

      const srv = trackServer(await startServer(app));

      const rClamp = await fetch(`${srv.baseUrl}/ten`, { headers: { Range: 'bytes=7-999' } });
      expect(rClamp.status).toBe(206);
      expect(rClamp.headers.get('content-range')).toBe('bytes 7-9/10');
      expect(await rClamp.text()).toBe('789');

      const rMulti = await fetch(`${srv.baseUrl}/ten`, { headers: { Range: 'bytes=0-1, 3-4' } });
      expect(rMulti.status).toBe(200);
      expect(await rMulti.text()).toBe('0123456789');

      const rInvalid = await fetch(`${srv.baseUrl}/ten`, { headers: { Range: 'bytes=abc' } });
      expect(rInvalid.status).toBe(200);
      expect(await rInvalid.text()).toBe('0123456789');
    }
  );

  it(
    'res.sendFile rejects directory traversal escaping root (and symlinks escaping root on rxpress)',
    async () => {
      const ws = makeWorkspace('rxpress-fg06-t2-03-');
      const outsideSecret = ws.writeFile('outside/secret.txt', 'OUTSIDE_SECRET');
      const rootDir = ws.mkdir('root');
      ws.writeSymlink('root/symlink-out.txt', outsideSecret);

      const handleSend = (filePath: string) => (_req: unknown, res: E2EResponse) => {
        res.sendFile(filePath, { root: rootDir }, (err) => {
          if (err && !res.headersSent) {
            const status = (err as { status?: number; statusCode?: number }).status ?? 403;
            res.status(status).json({ rejected: true });
          }
        });
      };

      const app = createApp();
      app.get('/trav1', handleSend('../outside/secret.txt'));
      app.get('/trav2', handleSend('a/../../outside/secret.txt'));
      app.get('/sym', handleSend('symlink-out.txt'));

      const srv = trackServer(await startServer(app));

      for (const path of ['/trav1', '/trav2']) {
        const res = await fetch(`${srv.baseUrl}${path}`);
        expect([403, 404]).toContain(res.status);
        expect(await res.text()).not.toContain('OUTSIDE_SECRET');
      }

      if (!isExpressBaseline()) {
        const symRes = await fetch(`${srv.baseUrl}/sym`);
        expect([403, 404]).toContain(symRes.status);
        expect(await symRes.text()).not.toContain('OUTSIDE_SECRET');
      }
    }
  );

  it(
    'res.sendFile missing file invokes cb(err) before headersSent and returns 404 without cb',
    async () => {
      const ws = makeWorkspace('rxpress-fg06-t2-04-');

      const app = createApp();
      app.get('/miss-cb', (_req, res) => {
        res.sendFile('nope.txt', { root: ws.dir }, (err) => {
          const sentBefore = res.headersSent;
          if (err && !res.headersSent) {
            res.status(404).json({ custom: true, sentBefore });
          }
        });
      });
      app.get('/miss-nocb', (_req, res) => {
        res.sendFile('nope.txt', { root: ws.dir });
      });

      const srv = trackServer(await startServer(app));

      const rCb = await fetch(`${srv.baseUrl}/miss-cb`);
      expect(rCb.status).toBe(404);
      expect(await rCb.json()).toEqual({ custom: true, sentBefore: false });

      const rNoCb = await fetch(`${srv.baseUrl}/miss-nocb`);
      expect(rNoCb.status).toBe(404);
    }
  );

  it(
    'res.sendFile with relative path and no root option forwards TypeError cleanly to error handler',
    async () => {
      const app = createApp();
      app.get('/no-root', (_req, res) => {
        res.sendFile('relative.txt');
      });
      app.get('/health', (_req, res) => {
        res.send('ok');
      });
      const errHandler: E2EErrorRequestHandler = (err, _req, res, _next) => {
        res.status(500).json({
          errorName: err instanceof Error ? err.name : '',
          error: err instanceof Error ? err.message : String(err),
        });
      };
      app.use(errHandler);

      const srv = trackServer(await startServer(app));

      const res = await fetch(`${srv.baseUrl}/no-root`);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { errorName?: string; error?: string };
      expect(body.errorName).toBe('TypeError');
      expect(typeof body.error).toBe('string');
      expect((body.error ?? '').length).toBeGreaterThan(0);

      const health = await fetch(`${srv.baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe('ok');
    }
  );

  it(
    'res.sendFile honors dotfiles (deny/ignore/allow) and acceptRanges: false',
    async () => {
      const ws = makeWorkspace('rxpress-fg06-t2-06-');
      ws.writeFile('.secret', 'hidden');
      ws.writeFile('ten.txt', '0123456789');

      const app = createApp();
      app.get('/deny', (_req, res) => {
        res.sendFile('.secret', { root: ws.dir, dotfiles: 'deny' });
      });
      app.get('/ignore', (_req, res) => {
        res.sendFile('.secret', { root: ws.dir, dotfiles: 'ignore' });
      });
      app.get('/allow', (_req, res) => {
        res.sendFile('.secret', { root: ws.dir, dotfiles: 'allow' });
      });
      app.get('/no-ranges', (_req, res) => {
        res.sendFile('ten.txt', { root: ws.dir, acceptRanges: false });
      });

      const srv = trackServer(await startServer(app));

      expect((await fetch(`${srv.baseUrl}/deny`)).status).toBe(403);
      expect((await fetch(`${srv.baseUrl}/ignore`)).status).toBe(404);

      const rAllow = await fetch(`${srv.baseUrl}/allow`);
      expect(rAllow.status).toBe(200);
      expect(await rAllow.text()).toBe('hidden');

      const rNoRange = await fetch(`${srv.baseUrl}/no-ranges`, {
        headers: { Range: 'bytes=0-2' },
      });
      expect(rNoRange.status).toBe(200);
      expect(await rNoRange.text()).toBe('0123456789');
      const acceptRanges = rNoRange.headers.get('accept-ranges');
      expect(acceptRanges === null || acceptRanges === 'none').toBe(true);
    }
  );

  it(
    'res.sendFile targeting a directory reports error to cb and returns 404/403 without hanging',
    async () => {
      const ws = makeWorkspace('rxpress-fg06-t2-07-');
      ws.mkdir('subdir');

      const app = createApp();
      app.get('/dir-cb', (_req, res) => {
        res.sendFile('subdir', { root: ws.dir }, (err) => {
          if (err && !res.headersSent) {
            res.status(404).json({ err: true });
          }
        });
      });
      app.get('/dir-nocb', (_req, res) => {
        res.sendFile('subdir', { root: ws.dir });
      });

      const srv = trackServer(await startServer(app));

      const rCb = await fetch(`${srv.baseUrl}/dir-cb`);
      expect(rCb.status).toBe(404);
      expect(await rCb.json()).toEqual({ err: true });

      const rNoCb = await fetch(`${srv.baseUrl}/dir-nocb`);
      expect([403, 404]).toContain(rNoCb.status);
    }
  );
});
