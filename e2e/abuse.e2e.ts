// Automated abuse tests.
//   - slowloris on the head (headers trickled byte by byte) is cut off by headersTimeoutMs;
//   - a 1-byte-per-chunk body (tens of thousands of chunks) completes without excess memory;
//   - a pipelined burst of cached static GETs from a client that never reads keeps RSS bounded;
//   - long ReDoS-shaped paths against multi-param routes answer fast over the real HTTP stack.
//
// The server runs in this process, so RSS includes the test runner; thresholds are set far
// below what the unbounded behaviour produces and far above normal noise.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openRawSocket, sendRawHttp, type RawSocketClient } from './helpers/raw-http.js';
import {
  createApp,
  isExpressBaseline,
  itRxpress,
  rawMiddleware,
  startServer,
  staticMiddleware,
  type E2EServerConfigOptions,
} from './helpers/server.js';

const closables: Array<() => Promise<unknown>> = [];
const sockets: RawSocketClient[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  while (sockets.length) sockets.pop()?.destroy();
  while (closables.length) await Promise.allSettled([closables.pop()?.()]);
  while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

const MiB = 1024 * 1024;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Samples RSS every `everyMs` for `forMs` and returns the peak. */
async function peakRss(forMs: number, everyMs = 50): Promise<number> {
  let peak = process.memoryUsage.rss();
  const end = Date.now() + forMs;
  while (Date.now() < end) {
    await sleep(everyMs);
    peak = Math.max(peak, process.memoryUsage.rss());
  }
  return peak;
}

describe('abuse: slowloris on the request head', () => {
  itRxpress('headers trickled 1 byte / 100 ms are cut off within headersTimeoutMs', async () => {
    const cfg: E2EServerConfigOptions = { headersTimeoutMs: 1000, shutdownTimeoutMs: 200 };
    const app = createApp(cfg);
    app.get('/', (_req, res) => {
      res.send('ok');
    });
    const srv = await startServer(app, { timeouts: cfg });
    closables.push(() => srv.close());

    const clients = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const c = await openRawSocket(srv.host, srv.port);
        sockets.push(c);
        return c;
      })
    );
    const head = 'GET / HTTP/1.1\r\nHost: t\r\nX-Slow: ' + 'a'.repeat(200);
    const t0 = Date.now();
    // Trickle for up to 8 s; each trickle stops as soon as its socket is closed.
    for (const c of clients) void c.writeChunksSlowly(head.split(''), 100);
    const closed = await Promise.all(clients.map((c) => c.waitForClose(4000)));
    const elapsed = Date.now() - t0;

    expect(closed.every(Boolean)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(3000);
    for (const c of clients) {
      const got = c.getBufferedData().toString('latin1');
      if (got.length > 0) expect(got).toMatch(/^HTTP\/1\.1 408/);
    }

    // The server is still healthy for normal clients.
    const ok = await sendRawHttp(srv.host, srv.port, 'GET / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n');
    expect(ok.statusCode).toBe(200);
  });
});

describe('abuse: 1-byte chunked body', () => {
  itRxpress('50 000 one-byte chunks complete correctly without excess memory', async () => {
    const app = createApp();
    app.use(rawMiddleware({ type: () => true, limit: '1mb' }));
    app.post('/up', (req, res) => {
      const body = (req as unknown as { body: Buffer }).body;
      res.send(`len=${body.length};x=${body.toString('latin1').split('').every((ch) => ch === 'x')}`);
    });
    const srv = await startServer(app);
    closables.push(() => srv.close());

    const N = 50_000;
    const c = await openRawSocket(srv.host, srv.port);
    sockets.push(c);
    const rss0 = process.memoryUsage.rss();
    const t0 = Date.now();
    await c.write('POST /up HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n');
    const one = '1\r\nx\r\n';
    // Write in ~6 KB slices so the server sees many small reads, not one buffer.
    const perWrite = 1000;
    for (let i = 0; i < N; i += perWrite) {
      await c.write(one.repeat(Math.min(perWrite, N - i)));
    }
    const peakP = peakRss(1000, 25);
    await c.write('0\r\n\r\n');
    const resp = (await c.readUntil(/len=\d+;x=(true|false)/, 10_000)).toString('latin1');
    const elapsed = Date.now() - t0;
    const growth = (await peakP) - rss0;

    expect(resp).toMatch(/^HTTP\/1\.1 200/);
    expect(resp).toContain(`len=${N};x=true`);
    expect(elapsed).toBeLessThan(10_000);
    // 50 KB of payload (300 KB on the wire): anything near 64 MiB means per-chunk overhead blew up.
    expect(growth).toBeLessThan(64 * MiB);
  });
});

const CONNS = Number(process.env.ABUSE_CONNS ?? 8);

/** Opens CONNS non-reading connections, each pipelining 2000 GETs; returns peak RSS growth. */
async function pipelinedStaticGrowth(): Promise<{ growth: number; healthyAfter: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'rxpress-abuse-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'big.bin'), Buffer.alloc(64 * 1024, 0x61));
  const app = createApp();
  app.use(staticMiddleware(dir));
  const srv = await startServer(app);
  closables.push(() => srv.close());

  // Warm the static cache.
  for (let i = 0; i < 3; i++) {
    const r = await sendRawHttp(srv.host, srv.port, 'GET /big.bin HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n');
    expect(r.statusCode).toBe(200);
    expect(r.body.length).toBe(64 * 1024);
  }
  await sleep(200);
  const rss0 = process.memoryUsage.rss();

  const burst = 'GET /big.bin HTTP/1.1\r\nHost: t\r\n\r\n'.repeat(2000); // ~66 KB, about one read
  const conns: RawSocketClient[] = [];
  for (let i = 0; i < CONNS; i++) {
    const c = await openRawSocket(srv.host, srv.port);
    sockets.push(c);
    c.pause(); // never read: the kernel buffers fill and the server must apply backpressure
    conns.push(c);
    c.socket.write(burst);
  }
  const growth = (await peakRss(3000)) - rss0;
  if (process.env.ABUSE_VERBOSE) console.log(`S3 growth ${(growth / MiB).toFixed(1)} MiB over ${CONNS} conns`);
  for (const c of conns) c.destroy();
  const r = await sendRawHttp(srv.host, srv.port, 'GET /big.bin HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n');
  return { growth, healthyAfter: r.statusCode };
}

describe('abuse: pipelined cached static GETs, client never reads', () => {
  // Regression for S3: write_buf is flushed with backpressure every 256 KiB, so memory per
  // non-reading connection stays bounded.
  itRxpress(`RSS growth < 4 MiB per connection (${CONNS} non-reading connections)`, async () => {
    const { growth } = await pipelinedStaticGrowth();
    expect(growth, `RSS growth ${(growth / MiB).toFixed(1)} MiB`).toBeLessThan(4 * MiB * CONNS);
  }, 30_000);

  // Holds today and must keep holding: no runaway (the reported worst case is ~136 MiB per
  // connection) and the server keeps serving after the abusive clients go away.
  itRxpress('no runaway: growth < 24 MiB per connection and the server still serves', async () => {
    const { growth, healthyAfter } = await pipelinedStaticGrowth();
    expect(growth, `RSS growth ${(growth / MiB).toFixed(1)} MiB`).toBeLessThan(24 * MiB * CONNS);
    expect(healthyAfter).toBe(200);
  }, 30_000);
});

describe('abuse: ReDoS-shaped paths over HTTP', () => {
  itRxpress('long separator runs against multi-param routes answer in < 300 ms', async () => {
    const app = createApp();
    const patterns = ['/f/:a-:b-:c', '/g/:a.:b.:c.:d', '/h/:a~:b~:c', '/w/*a-*b', '/o/:a{-:b}{-:c}', '/m/:a-:b/*rest'];
    for (const p of patterns) {
      app.get(p, (_req, res) => {
        res.send('matched');
      });
    }
    const srv = await startServer(app);
    closables.push(() => srv.close());

    const N = 6000; // keeps the request line under the default header-size limit
    const paths = [
      '/f/' + '-'.repeat(N) + '/x',
      '/f/' + 'a-'.repeat(N / 2) + '/',
      '/g/' + '.'.repeat(N) + '!',
      '/h/' + '~'.repeat(N) + '/x',
      '/w/' + '-/'.repeat(N / 2) + '!',
      '/o/' + '-'.repeat(N) + '/x',
      '/m/' + '-'.repeat(N) + '/',
    ];
    const slow: string[] = [];
    for (const p of paths) {
      const t0 = performance.now();
      const r = await sendRawHttp(srv.host, srv.port, `GET ${p} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n`);
      const ms = performance.now() - t0;
      expect([200, 404, 414, 431]).toContain(r.statusCode);
      if (ms >= 300) slow.push(`${p.slice(0, 12)}... (${p.length} B): ${ms.toFixed(0)} ms`);
    }
    expect(slow).toEqual([]);
  });
});
