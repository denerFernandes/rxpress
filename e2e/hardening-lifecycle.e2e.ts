import { afterEach, describe, expect, it } from 'vitest';
import {
  openRawSocket,
  type RawSocketClient,
} from './helpers/raw-http.js';
import {
  createApp,
  isExpressBaseline,
  itRxpress,
  startServer,
  type E2EServerConfigOptions,
  type E2EServerHandle,
} from './helpers/server.js';

const activeClosables: Array<() => Promise<unknown>> = [];
const activeSockets: RawSocketClient[] = [];

function trackClosable(fn: () => Promise<unknown>): void {
  activeClosables.push(fn);
}

function trackSocket(sock: RawSocketClient): RawSocketClient {
  activeSockets.push(sock);
  return sock;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function closeServerHandle(srv: E2EServerHandle): Promise<void> {
  if (isExpressBaseline()) {
    if (!srv.listening) return;
    await new Promise<void>((resolve, reject) => {
      srv.close((err?: Error) => {
        if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(err);
        } else {
          resolve();
        }
      });
    });
    return;
  }
  await Promise.resolve(srv.close());
}

afterEach(async () => {
  while (activeSockets.length > 0) {
    activeSockets.pop()?.destroy();
  }
  while (activeClosables.length > 0) {
    const closeFn = activeClosables.pop();
    if (closeFn) {
      await Promise.allSettled([closeFn()]);
    }
  }
});

describe('Graceful Shutdown & Server Lifecycle', () => {
  it('ephemeral port 0 binding with callback populates listening, address(), and serves HTTP', async () => {
    const app = createApp();
    app.get('/ping', (_req, res) => {
      res.status(200).send('pong');
    });

    let cbCalled = false;
    const srv = app.listen(0, '127.0.0.1', () => {
      cbCalled = true;
    });
    trackClosable(() => closeServerHandle(srv));

    const deadline = Date.now() + 2000;
    while ((!cbCalled || !srv.listening) && Date.now() < deadline) {
      await delay(10);
    }

    expect(cbCalled).toBe(true);
    expect(srv.listening).toBe(true);

    const addr = srv.address();
    expect(addr).not.toBeNull();
    expect(addr?.address).toBe('127.0.0.1');
    expect(addr?.family).toBe('IPv4');
    expect(addr?.port).toBeGreaterThan(0);

    const resp = await fetch(`http://127.0.0.1:${addr!.port}/ping`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('pong');
  });

  it('ServerHandle emits listening and close events and clears listening/address on close', async () => {
    const app = createApp();
    app.get('/ping', (_req, res) => {
      res.status(200).send('ok');
    });

    const srv = app.listen(0, '127.0.0.1');
    trackClosable(() => closeServerHandle(srv));

    // Assert EventEmitter interface upfront so older builds fail fast without 30s timeout
    expect(typeof srv.on).toBe('function');

    let listeningCount = 0;
    let closeCount = 0;
    const listeningPromise = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('listening event timed out')), 1500);
      srv.on!('listening', () => {
        listeningCount++;
        clearTimeout(t);
        resolve();
      });
    });
    const closePromise = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('close event timed out')), 2500);
      srv.on!('close', () => {
        closeCount++;
        clearTimeout(t);
        resolve();
      });
    });

    await listeningPromise;
    expect(listeningCount).toBe(1);
    expect(srv.listening).toBe(true);
    expect(srv.address()?.port).toBeGreaterThan(0);

    await closeServerHandle(srv);
    await closePromise;

    expect(closeCount).toBe(1);
    expect(srv.listening).toBe(false);
    expect(srv.address()).toBeNull();
  });

  it('graceful close() drains in-flight HTTP requests while refusing new connections', async () => {
    const cfg: E2EServerConfigOptions = { shutdownTimeoutMs: 2000 };
    const app = createApp(cfg);
    app.get('/slow', async (_req, res) => {
      await delay(150);
      res.status(200).send('drained-ok');
    });

    const srv = await startServer(app, { timeouts: cfg });
    trackClosable(() => srv.close());

    const inFlight = fetch(`${srv.baseUrl}/slow`);
    await delay(35);

    const closing = srv.close();

    await expect(fetch(`${srv.baseUrl}/slow`)).rejects.toThrow();

    const resp = await inFlight;
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('drained-ok');

    await closing;
  });

  itRxpress(
    'graceful close() closes idle keep-alive sockets promptly without waiting full keepAliveTimeoutMs',
    async () => {
      const cfg: E2EServerConfigOptions = {
        keepAliveTimeoutMs: 30000,
        shutdownTimeoutMs: 500,
      };
      const app = createApp(cfg);
      app.get('/ok', (_req, res) => {
        res.status(200).send('ok');
      });

      const srv = await startServer(app, { timeouts: cfg });
      trackClosable(() => srv.close());

      const client = trackSocket(await openRawSocket(srv.host, srv.port));
      await client.write('GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      const first = (await client.readUntil('ok', 2000)).toString('latin1');
      expect(first).toContain('HTTP/1.1 200');
      await client.readAvailable(0);

      const t0 = Date.now();
      await srv.close();
      const closed = await client.waitForClose(1500);
      const elapsed = Date.now() - t0;

      expect(closed).toBe(true);
      expect(elapsed).toBeLessThan(2000);
    }
  );

  it('closeAllConnections() forces open SSE and idle keep-alive sockets closed immediately', async () => {
    const cfg: E2EServerConfigOptions = { shutdownTimeoutMs: 300 };
    const app = createApp(cfg);
    app.get('/sse', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders();
      res.write('data: hello\n\n');
    });
    app.get('/ok', (_req, res) => {
      res.status(200).send('ok');
    });

    const srv = await startServer(app, { timeouts: cfg });
    trackClosable(() => srv.close());

    // Fail fast on builds lacking closeAllConnections
    expect(typeof srv.server.closeAllConnections).toBe('function');

    const sseClient = trackSocket(await openRawSocket(srv.host, srv.port));
    await sseClient.write('GET /sse HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    const sseData = (await sseClient.readUntil('data: hello', 2000)).toString('latin1');
    expect(sseData).toContain('data: hello');

    const idleClient = trackSocket(await openRawSocket(srv.host, srv.port));
    await idleClient.write('GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    const idleData = (await idleClient.readUntil('ok', 2000)).toString('latin1');
    expect(idleData).toContain('HTTP/1.1 200');

    srv.server.closeAllConnections!();

    const [sseClosed, idleClosed] = await Promise.all([
      sseClient.waitForClose(1000),
      idleClient.waitForClose(1000),
    ]);
    expect(sseClosed).toBe(true);
    expect(idleClosed).toBe(true);

    await srv.close();
  });

  itRxpress(
    'invalid ports (-1, 65536, NaN) and unresolvable hostname fail cleanly without panic',
    async () => {
      const expectListenReject = async (invoke: () => E2EServerHandle): Promise<void> => {
        let handle: E2EServerHandle | undefined;
        try {
          const err = await new Promise<unknown>((resolve) => {
            try {
              handle = invoke();
            } catch (syncErr) {
              resolve(syncErr);
              return;
            }
            if (typeof handle.on === 'function') {
              handle.on('error', (asyncErr) => resolve(asyncErr));
            }
            setTimeout(() => {
              resolve(null);
            }, 3000);
          });
          expect(err).toBeInstanceOf(Error);
        } finally {
          if (handle) {
            await Promise.allSettled([closeServerHandle(handle)]);
          }
        }
      };

      const app1 = createApp();
      await expectListenReject(() => app1.listen(65536, '127.0.0.1'));

      const app2 = createApp();
      await expectListenReject(() => app2.listen(-1, '127.0.0.1'));

      const app3 = createApp();
      await expectListenReject(() => app3.listen(Number.NaN, '127.0.0.1'));

      const app4 = createApp();
      await expectListenReject(() => app4.listen(0, 'invalid.host.invalid'));
    }
  );

  it('EADDRINUSE fails cleanly on second server while first server stays healthy', async () => {
    const appA = createApp();
    appA.get('/ping', (_req, res) => {
      res.status(200).send('server-a');
    });
    const srvA = await startServer(appA);
    trackClosable(() => srvA.close());

    const appB = createApp();
    appB.get('/ping', (_req, res) => {
      res.status(200).send('server-b');
    });

    let handleB: E2EServerHandle | undefined;
    const bindError = await new Promise<unknown>((resolve) => {
      try {
        // Call listen without callback so Express/Node emits 'error' cleanly instead of swallowing err
        handleB = appB.listen(srvA.port, '127.0.0.1');
      } catch (syncErr) {
        resolve(syncErr);
        return;
      }
      if (typeof handleB.on === 'function') {
        handleB.on('error', (err) => resolve(err));
      }
      setTimeout(() => resolve(null), 1000);
    });

    if (handleB) {
      await Promise.allSettled([closeServerHandle(handleB)]);
    }

    expect(bindError).toBeInstanceOf(Error);
    const errObj = bindError as NodeJS.ErrnoException;
    expect(
      errObj.code === 'EADDRINUSE' || /in use|EADDRINUSE/i.test(errObj.message)
    ).toBe(true);

    const respA = await fetch(`${srvA.baseUrl}/ping`);
    expect(respA.status).toBe(200);
    expect(await respA.text()).toBe('server-a');
  });

  itRxpress(
    'shutdownTimeoutMs forces shutdown on stuck handler without hanging forever',
    async () => {
      const cfg: E2EServerConfigOptions = {
        shutdownTimeoutMs: 150,
        handlerTimeoutMs: 0,
      };
      const app = createApp(cfg);
      app.get('/stuck', async () => new Promise<void>(() => {}));

      const srv = await startServer(app, { timeouts: cfg });
      trackClosable(() => srv.close());

      const client = trackSocket(await openRawSocket(srv.host, srv.port));
      await client.write('GET /stuck HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      await delay(30);

      const t0 = Date.now();
      await srv.close();
      const elapsed = Date.now() - t0;

      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(elapsed).toBeLessThan(1500);
    }
  );

  it('idempotent server.close() resolves cleanly across concurrent and sequential calls', async () => {
    const app = createApp();
    app.get('/ping', (_req, res) => {
      res.status(200).send('ok');
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    let closeEvents = 0;
    if (typeof srv.server.on === 'function') {
      srv.server.on('close', () => {
        closeEvents++;
      });
    }

    await Promise.all([srv.close(), srv.close()]);
    await srv.close();

    expect(srv.server.listening).toBe(false);
    if (typeof srv.server.on === 'function') {
      expect(closeEvents).toBeGreaterThanOrEqual(1);
      if (!isExpressBaseline()) {
        expect(closeEvents).toBe(1);
      }
    }
  });

  it('20 rapid start/fetch/close lifecycle cycles complete without leaked sockets or bind failures', async () => {
    for (let i = 0; i < 20; i++) {
      const app = createApp();
      app.get('/ping', (_req, res) => {
        res.status(200).json({ cycle: i });
      });

      const srv = await startServer(app);
      try {
        const resp = await fetch(`${srv.baseUrl}/ping`);
        expect(resp.status).toBe(200);
        expect(await resp.json()).toEqual({ cycle: i });
      } finally {
        await srv.close();
      }
    }
  });

  itRxpress(
    'IPv6 loopback binding (::1) serves HTTP when OS supports IPv6',
    async () => {
      const app = createApp();
      app.get('/ipv6', (_req, res) => {
        res.status(200).send('v6-ok');
      });

      let srv: Awaited<ReturnType<typeof startServer>> | null = null;
      try {
        srv = await startServer(app, { host: '::1', port: 0 });
        trackClosable(() => srv!.close());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (
          /EADDRNOTAVAIL|EAFNOSUPPORT|EACCES/i.test(code) ||
          /EADDRNOTAVAIL|EAFNOSUPPORT|EACCES/i.test(msg)
        ) {
          return;
        }
        throw err;
      }

      const resp = await fetch(`http://[::1]:${srv.port}/ipv6`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe('v6-ok');
    }
  );
});
