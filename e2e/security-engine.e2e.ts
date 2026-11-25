// Regression tests for the Rust engine security fixes,
// driven over raw TCP so the exact wire bytes are checked.
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect } from 'vitest';
import { openRawSocket, sendRawHttp, type RawSocketClient } from './helpers/raw-http.js';
import { createApp, itRxpress, staticMiddleware, startServer } from './helpers/server.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await Promise.allSettled([cleanups.pop()?.()]);
  }
});

function track(sock: RawSocketClient): RawSocketClient {
  cleanups.push(() => sock.destroy());
  return sock;
}

/** Split a buffer holding back-to-back HTTP/1.1 responses framed by Content-Length. */
function splitResponses(buf: Buffer): Array<{ head: string; body: Buffer }> {
  const out: Array<{ head: string; body: Buffer }> = [];
  let pos = 0;
  while (pos < buf.length) {
    const end = buf.indexOf('\r\n\r\n', pos, 'latin1');
    if (end < 0) break;
    const head = buf.subarray(pos, end).toString('latin1');
    pos = end + 4;
    if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) {
      // Decode chunked framing: what a client sees as the body.
      const parts: Buffer[] = [];
      for (;;) {
        const lineEnd = buf.indexOf('\r\n', pos, 'latin1');
        const size = parseInt(buf.subarray(pos, lineEnd).toString('latin1'), 16);
        pos = lineEnd + 2;
        if (size === 0) {
          pos += 2;
          break;
        }
        parts.push(buf.subarray(pos, pos + size));
        pos += size + 2;
      }
      out.push({ head, body: Buffer.concat(parts) });
      continue;
    }
    const m = /\r\ncontent-length:\s*(\d+)/i.exec(head);
    const len = m ? Number(m[1]) : 0;
    out.push({ head, body: buf.subarray(pos, pos + len) });
    pos += len;
  }
  return out;
}

const SMUGGLE = '0\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nPOISON';

describe('Engine response framing', () => {
  itRxpress('frames a JS Transfer-Encoding body itself: pipelined responses stay in sync', async () => {
    const app = createApp();
    app.set('etag', false);
    app.get('/proxy', (_req, res) => {
      res.status(404).set({ 'Transfer-Encoding': 'chunked' }).send(Buffer.from(SMUGGLE));
    });
    app.get('/ping', (_req, res) => {
      res.send('pong');
    });
    const srv = await startServer(app);
    cleanups.push(() => srv.close());

    const sock = track(await openRawSocket(srv.host, srv.port));
    await sock.write(
      'GET /proxy HTTP/1.1\r\nHost: a\r\n\r\nGET /ping HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n'
    );
    await sock.waitForClose(5000);
    const all = sock.getBufferedData();
    const resps = splitResponses(all);
    expect(resps).toHaveLength(2);
    expect(resps[0].head).toMatch(/^HTTP\/1\.1 404/);
    // Like Node: the app's Transfer-Encoding is kept, never next to a Content-Length.
    expect(resps[0].head.toLowerCase()).toContain('transfer-encoding: chunked');
    expect(resps[0].head.toLowerCase()).not.toContain('content-length');
    expect(resps[0].body.toString('latin1')).toBe(SMUGGLE);
    expect(resps[1].body.toString()).toBe('pong');
  });

  itRxpress('keeps a JS Transfer-Encoding off a 304, as res.send does', async () => {
    const app = createApp();
    app.get('/r', (_req, res) => {
      res.set('Transfer-Encoding', 'chunked').send('hello');
    });
    const srv = await startServer(app);
    cleanups.push(() => srv.close());
    const first = await sendRawHttp(srv.host, srv.port, 'GET /r HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n');
    const etag = String(first.headers.etag);
    expect(first.headers['transfer-encoding']).toBe('chunked');
    expect(first.headers['content-length']).toBeUndefined();
    const second = await sendRawHttp(
      srv.host,
      srv.port,
      `GET /r HTTP/1.1\r\nHost: a\r\nIf-None-Match: ${etag}\r\nConnection: close\r\n\r\n`
    );
    expect(second.statusCode).toBe(304);
    expect(second.headers['transfer-encoding']).toBeUndefined();
  });

  itRxpress('replaces a wrong JS Content-Length with the real one; HEAD keeps the advertised size', async () => {
    const app = createApp();
    app.set('etag', false);
    app.get('/short', (_req, res) => {
      res.set('Content-Length', '2').send('hello world');
    });
    app.get('/sized', (_req, res) => {
      res.set('Content-Length', '1234');
      res.end();
    });
    app.get('/ping', (_req, res) => {
      res.send('pong');
    });
    const srv = await startServer(app);
    cleanups.push(() => srv.close());

    const sock = track(await openRawSocket(srv.host, srv.port));
    await sock.write(
      'GET /short HTTP/1.1\r\nHost: a\r\n\r\n' +
        'GET /sized HTTP/1.1\r\nHost: a\r\n\r\n' +
        'GET /ping HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n'
    );
    await sock.waitForClose(5000);
    const resps = splitResponses(sock.getBufferedData());
    expect(resps.map((r) => r.body.toString())).toEqual(['hello world', '', 'pong']);
    expect(resps[1].head).toMatch(/content-length: 0/i);

    const head = await sendRawHttp(srv.host, srv.port, 'HEAD /sized HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n');
    expect(head.headers['content-length']).toBe('1234');
  });
});

describe('Static Range parsing', () => {
  itRxpress('a non-ASCII Range unit is ignored instead of crashing the connection task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rxpress-s4-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'f.txt'), '0123456789');
    const app = createApp();
    app.use('/s', staticMiddleware(dir));
    const srv = await startServer(app);
    cleanups.push(() => srv.close());

    const req = (range: Buffer) =>
      Buffer.concat([Buffer.from('GET /s/f.txt HTTP/1.1\r\nHost: a\r\nRange: ', 'latin1'), range, Buffer.from('\r\n\r\n')]);
    const sock = track(await openRawSocket(srv.host, srv.port));
    // Twice: the second one is served from the static cache path.
    await sock.write(req(Buffer.from('bytesé=0-1', 'utf8')));
    await sock.readUntil((b) => splitResponses(b).length >= 1 && b.includes('0123456789'), 5000);
    await sock.write(Buffer.concat([req(Buffer.from('bytesé=0-1', 'utf8')), req(Buffer.from('bytes=0-1'))]));
    await sock.readUntil((b) => splitResponses(b).length >= 3, 5000);
    const resps = splitResponses(sock.getBufferedData());
    expect(resps[0].head).toMatch(/^HTTP\/1\.1 200/);
    expect(resps[1].head).toMatch(/^HTTP\/1\.1 200/);
    expect(resps[1].body.toString()).toBe('0123456789');
    expect(resps[2].head).toMatch(/^HTTP\/1\.1 206/);
    expect(resps[2].body.toString()).toBe('01');
  });
});

describe('Streamed request bodies', () => {
  itRxpress('1-byte chunks are coalesced into few JS chunks', async () => {
    const app = createApp();
    app.post('/count', (req, res) => {
      let events = 0;
      let bytes = 0;
      req.on('data', (c: unknown) => {
        events++;
        bytes += (c as Buffer).length;
      });
      req.on('end', () => res.json({ events, bytes }));
    });
    const srv = await startServer(app);
    cleanups.push(() => srv.close());
    const n = 20000;
    const body = '1\r\nx\r\n'.repeat(n) + '0\r\n\r\n';
    const resp = await sendRawHttp(
      srv.host,
      srv.port,
      `POST /count HTTP/1.1\r\nHost: a\r\nContent-Type: application/x-bin\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${body}`,
      { timeoutMs: 10000 }
    );
    expect(resp.statusCode).toBe(200);
    const out = JSON.parse(resp.body.toString()) as { events: number; bytes: number };
    expect(out.bytes).toBe(n);
    // Without coalescing every byte is its own event (n); how many pieces the engine merges
    // depends on how fast JS drains, so assert an order of magnitude, not an exact count.
    expect(out.events).toBeLessThan(n / 8);
  });
});

describe('Write idle timeout', () => {
  itRxpress('a client that stops reading a streamed response is dropped and JS sees close', async () => {
    const app = createApp();
    app.set('writeTimeoutMs', 300);
    let closed: () => void = () => {};
    const closedP = new Promise<void>((r) => (closed = r));
    app.get('/firehose', (_req, res) => {
      const chunk = Buffer.alloc(64 * 1024, 120);
      res.on('close', () => closed());
      const pump = () => {
        while (!res.writableEnded && !res.destroyed) {
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
      };
      pump();
    });
    const srv = await startServer(app);
    cleanups.push(() => srv.close());

    const sock = net.connect(srv.port, srv.host);
    cleanups.push(() => sock.destroy());
    await new Promise<void>((r) => sock.once('connect', () => r()));
    sock.pause();
    sock.write('GET /firehose HTTP/1.1\r\nHost: a\r\n\r\n');
    const t0 = Date.now();
    await Promise.race([
      closedP,
      new Promise((_, rej) => setTimeout(() => rej(new Error('JS never saw close')), 8000)),
    ]);
    expect(Date.now() - t0).toBeLessThan(8000);
  });
});
