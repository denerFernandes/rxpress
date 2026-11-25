import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import rxpress, { type ServerHandle } from '../js/index.js';

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

describe('Streaming, SSE, and Large File Delivery', () => {
  it('streams Server-Sent Events (SSE) incrementally with flushHeaders & write', async () => {
    const app = rxpress();
    app.get('/sse', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders();

      let count = 0;
      const timer = setInterval(() => {
        count++;
        res.write(`data: event-${count}\n\n`);
        if (count === 3) {
          clearInterval(timer);
          res.end();
        }
      }, 15);
    });

    const base = await startApp(app);
    const resp = await fetch(`${base}/sse`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('text/event-stream');

    const chunks: string[] = [];
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    const full = chunks.join('');
    expect(full).toContain('data: event-1\n\n');
    expect(full).toContain('data: event-2\n\n');
    expect(full).toContain('data: event-3\n\n');
  });

  it('notifies req.on("close") when an SSE client disconnects early', async () => {
    let closedFired = false;
    const app = rxpress();
    app.get('/sse-abort', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
      res.write('data: hello\n\n');

      const timer = setInterval(() => {
        res.write('data: ping\n\n');
      }, 20);

      req.on('close', () => {
        closedFired = true;
        clearInterval(timer);
      });
    });

    const base = await startApp(app);
    const controller = new AbortController();
    const resp = await fetch(`${base}/sse-abort`, { signal: controller.signal });
    const reader = resp.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('data: hello');

    controller.abort();
    await reader.cancel().catch(() => {});

    // Wait briefly for Rust DropGuard -> Node close notification
    for (let i = 0; i < 30 && !closedFired; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(closedFired).toBe(true);
  });

  it('streams large files via res.sendFile() and res.download() with Range support', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rxpress-files-'));
    tempDirs.push(dir);
    // 300KB file (above 64KB streaming threshold in Rust)
    const largeData = Buffer.alloc(300 * 1024);
    for (let i = 0; i < largeData.length; i++) {
      largeData[i] = i & 0xff;
    }
    const largePath = join(dir, 'large.bin');
    writeFileSync(largePath, largeData);

    const app = rxpress();
    app.get('/file', (_req, res) => res.sendFile(largePath));
    app.get('/dl', (_req, res) => res.download(largePath, 'report.bin'));

    const base = await startApp(app);

    const rFull = await fetch(`${base}/file`);
    expect(rFull.status).toBe(200);
    const buf = Buffer.from(await rFull.arrayBuffer());
    expect(buf.length).toBe(largeData.length);
    expect(buf.equals(largeData)).toBe(true);

    // Partial range of large file
    const rPart = await fetch(`${base}/file`, {
      headers: { Range: 'bytes=1000-1999' },
    });
    expect(rPart.status).toBe(206);
    const partBuf = Buffer.from(await rPart.arrayBuffer());
    expect(partBuf.length).toBe(1000);
    expect(partBuf.equals(largeData.subarray(1000, 2000))).toBe(true);

    // Download header
    const rDl = await fetch(`${base}/dl`);
    expect(rDl.status).toBe(200);
    expect(rDl.headers.get('content-disposition')).toBe('attachment; filename="report.bin"');
  });
});
