// `res.sendFile(path, cb)` / `res.download(path, cb)`: the callback runs when the response has
// ended, as in Express. It used to run as soon as the file was handed to the engine.
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import rxpress from '../js/index.js';

type Closable = { close(): Promise<void> | void };
const open: Closable[] = [];
const sockets: Socket[] = [];
let dir = '';
let bigFile = '';
let smallFile = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rxpress-sendfile-'));
  bigFile = join(dir, 'big.bin');
  smallFile = join(dir, 'small.txt');
  writeFileSync(bigFile, Buffer.alloc(48 * 1024 * 1024, 7)); // far more than the socket buffers hold
  writeFileSync(smallFile, 'hello file');
  return () => rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  while (sockets.length) sockets.pop()!.destroy();
  while (open.length) await open.pop()!.close();
});

async function serve(app: ReturnType<typeof rxpress>): Promise<number> {
  const server = await new Promise<Closable & { address(): { port: number } }>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s as never)) as never;
  });
  open.push(server);
  return server.address().port;
}

function connect(port: number, path: string): Socket {
  const socket = createConnection({ host: '127.0.0.1', port }, () => {
    socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  });
  sockets.push(socket);
  return socket;
}

const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

describe('res.sendFile callback timing', () => {
  it('waits until the whole file has been written, then reports no error', async () => {
    const app = rxpress();
    const calls: Array<Error | undefined> = [];
    app.get('/big', (_req, res) => res.sendFile(bigFile, (err) => calls.push(err)));
    const port = await serve(app);

    const socket = connect(port, '/big');
    socket.pause(); // the client reads nothing, so the engine cannot finish writing
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toEqual([]); // handed to the engine long ago, but not delivered

    let received = 0;
    socket.on('data', (c) => (received += c.length));
    socket.resume();
    await until(() => calls.length > 0, 15000);
    expect(calls).toEqual([undefined]);
    await until(() => received >= 48 * 1024 * 1024, 15000);
    expect(received).toBeGreaterThanOrEqual(48 * 1024 * 1024);
  }, 30000);

  it('reports ECONNABORTED when the client leaves in the middle of the file', async () => {
    const app = rxpress();
    const calls: Array<Error | undefined> = [];
    app.get('/big', (_req, res) => res.sendFile(bigFile, (err) => calls.push(err)));
    const port = await serve(app);

    const socket = connect(port, '/big');
    await new Promise<void>((resolve) => socket.once('data', () => resolve()));
    socket.destroy();
    await until(() => calls.length > 0);
    expect(calls).toHaveLength(1);
    expect((calls[0] as NodeJS.ErrnoException).code).toBe('ECONNABORTED');
  }, 30000);

  it('reports ECONNABORTED when the client is already gone before the file is read', async () => {
    const app = rxpress();
    const calls: Array<Error | undefined> = [];
    app.get('/late', (_req, res) => {
      setTimeout(() => res.sendFile(smallFile, (err) => calls.push(err)), 100);
    });
    const port = await serve(app);

    const socket = connect(port, '/late');
    await new Promise((r) => setTimeout(r, 30));
    socket.destroy();
    await until(() => calls.length > 0);
    expect(calls).toHaveLength(1);
    expect((calls[0] as NodeJS.ErrnoException).code).toBe('ECONNABORTED');
  });

  it('calls back once, without an error, for a file that is delivered', async () => {
    const app = rxpress();
    const calls: Array<Error | undefined> = [];
    app.get('/small', (_req, res) => res.sendFile(smallFile, (err) => calls.push(err)));
    const port = await serve(app);

    const res = await fetch(`http://127.0.0.1:${port}/small`);
    expect(await res.text()).toBe('hello file');
    await until(() => calls.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([undefined]);
  });

  it('res.download() calls back the same way', async () => {
    const app = rxpress();
    const calls: Array<Error | undefined> = [];
    app.get('/dl', (_req, res) => res.download(smallFile, 'renamed.txt', (err) => calls.push(err)));
    const port = await serve(app);

    const res = await fetch(`http://127.0.0.1:${port}/dl`);
    expect(res.headers.get('content-disposition')).toMatch(/renamed\.txt/);
    expect(await res.text()).toBe('hello file');
    await until(() => calls.length > 0);
    expect(calls).toEqual([undefined]);
  });

  it('keeps the AsyncLocalStorage context of the caller in the callback', async () => {
    const als = new AsyncLocalStorage<{ id: string }>();
    const app = rxpress();
    const seen: Array<string | undefined> = [];
    app.use((req, _res, next) => als.run({ id: String(req.query.id) }, next));
    app.get('/als', (_req, res) => {
      res.sendFile(smallFile, () => seen.push(als.getStore()?.id));
    });
    const port = await serve(app);

    await Promise.all(
      ['a', 'b', 'c'].map(async (id) => (await fetch(`http://127.0.0.1:${port}/als?id=${id}`)).text())
    );
    await until(() => seen.length === 3);
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
  });

  it('fails the callback when the server closes with the file still being written', async () => {
    const app = rxpress();
    app.set('shutdownTimeoutMs', 200);
    const calls: Array<Error | undefined> = [];
    app.get('/big', (_req, res) => res.sendFile(bigFile, (err) => calls.push(err)));
    const port = await serve(app);

    const socket = connect(port, '/big');
    socket.pause();
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toEqual([]);
    const server = open.pop()!;
    await server.close();
    await until(() => calls.length > 0);
    expect(calls).toHaveLength(1);
    expect((calls[0] as NodeJS.ErrnoException).code).toBe('ECONNABORTED');
  }, 30000);
});
