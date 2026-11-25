import { afterEach, describe, expect, it } from 'vitest';
import {
  openRawSocket,
  sendRawHttp,
  type RawSocketClient,
} from './helpers/raw-http.js';
import {
  createApp,
  itRxpress,
  startServer,
  textMiddleware,
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

describe('HTTP/1.1 Framing, Anti-Smuggling & CRLF Injection Defense', () => {
  it('standard Content-Length POST and chunked POST with trailers parse cleanly', async () => {
    const app = createApp();
    app.use(textMiddleware({ type: '*/*' }));
    app.post('/echo', (req, res) => {
      res.status(200).send(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const clResp = await sendRawHttp(
      srv.host,
      srv.port,
      'POST /echo HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Content-Type: text/plain\r\n' +
        'Content-Length: 11\r\n' +
        'Connection: close\r\n\r\n' +
        'hello world'
    );
    expect(clResp.statusCode).toBe(200);
    expect(clResp.body.toString('utf8')).toBe('hello world');

    const chunkedResp = await sendRawHttp(
      srv.host,
      srv.port,
      'POST /echo HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Content-Type: text/plain\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        'Trailer: X-Tr\r\n' +
        'Connection: close\r\n\r\n' +
        '5\r\nhello\r\n' +
        '6\r\n world\r\n' +
        '0\r\n' +
        'X-Tr: 1\r\n\r\n'
    );
    expect(chunkedResp.statusCode).toBe(200);
    expect(chunkedResp.body.toString('utf8')).toBe('hello world');
  });

  it('Expect: 100-continue handshake emits 100 Continue before body arrives', async () => {
    const app = createApp();
    app.use(textMiddleware({ type: '*/*' }));
    app.post('/upload', (req, res) => {
      res.status(200).send(`got:${String(req.body)}`);
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const client = trackSocket(await openRawSocket(srv.host, srv.port));
    await client.write(
      'POST /upload HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Content-Type: text/plain\r\n' +
        'Expect: 100-continue\r\n' +
        'Content-Length: 5\r\n\r\n'
    );

    const interim = (await client.readUntil('100 Continue\r\n\r\n', 3000)).toString('latin1');
    expect(interim).toContain('HTTP/1.1 100 Continue');

    // Drain interim frame before reading final 200 response
    await client.readAvailable(0);

    await client.write('hello');
    const finalBuf = await client.readUntil('got:hello', 3000);
    const finalStr = finalBuf.toString('latin1');
    expect(finalStr).toContain('HTTP/1.1 200');
    expect(finalStr).toContain('got:hello');
  });

  it('HTTP/1.1 Connection: close vs keep-alive and HTTP/1.0 close vs keep-alive', async () => {
    const app = createApp();
    app.get('/ping', (_req, res) => {
      res.status(200).send('pong');
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    // 1) HTTP/1.1 Connection: close closes socket
    const closeResp = await sendRawHttp(
      srv.host,
      srv.port,
      'GET /ping HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
    );
    expect(closeResp.statusCode).toBe(200);
    expect(String(closeResp.headers['connection'] ?? '').toLowerCase()).toBe('close');
    expect(closeResp.closed).toBe(true);

    // 2) HTTP/1.1 defaults to persistent keep-alive
    const kaClient = trackSocket(await openRawSocket(srv.host, srv.port));
    await kaClient.write('GET /ping HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    const ka1 = (await kaClient.readUntil('pong', 3000)).toString('latin1');
    expect(ka1).toContain('HTTP/1.1 200');
    await kaClient.readAvailable(0);
    await kaClient.write('GET /ping HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    const ka2 = (await kaClient.readUntil('pong', 3000)).toString('latin1');
    expect(ka2).toContain('HTTP/1.1 200');
    expect(await kaClient.waitForClose(2000)).toBe(true);

    // 3) HTTP/1.0 default closes socket
    const h10Close = await sendRawHttp(
      srv.host,
      srv.port,
      'GET /ping HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n'
    );
    expect(h10Close.statusCode).toBe(200);
    expect(h10Close.closed).toBe(true);

    // 4) HTTP/1.0 with Connection: keep-alive stays open for second request
    const h10Ka = trackSocket(await openRawSocket(srv.host, srv.port));
    await h10Ka.write('GET /ping HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    const h10r1 = (await h10Ka.readUntil('pong', 3000)).toString('latin1');
    expect(h10r1).toMatch(/^HTTP\/1\.[01] 200/);
    await h10Ka.readAvailable(0);
    await h10Ka.write('GET /ping HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    const h10r2 = (await h10Ka.readUntil('pong', 3000)).toString('latin1');
    expect(h10r2).toMatch(/^HTTP\/1\.[01] 200/);
    expect(await h10Ka.waitForClose(2000)).toBe(true);
  });

  it('HTTP status reason phrases match RFC expectations', async () => {
    const app = createApp();
    app.get('/code/:code', (req, res) => {
      const code = Number(req.params.code);
      if (code === 204) {
        res.status(204).end();
      } else {
        res.status(code).send(`code:${code}`);
      }
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const expected: Array<[number, string]> = [
      [201, 'Created'],
      [204, 'No Content'],
      [413, 'Payload Too Large'],
      [416, 'Range Not Satisfiable'],
      [429, 'Too Many Requests'],
      [431, 'Request Header Fields Too Large'],
      [503, 'Service Unavailable'],
      [504, 'Gateway Timeout'],
    ];

    for (const [code, reason] of expected) {
      const resp = await sendRawHttp(
        srv.host,
        srv.port,
        `GET /code/${code} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`
      );
      expect(resp.statusCode).toBe(code);
      expect(resp.statusLine).toBe(`HTTP/1.1 ${code} ${reason}`);
    }
  });

  it('multi-value request headers join according to HTTP/Express rules', async () => {
    const app = createApp();
    app.get('/headers', (req, res) => {
      res.json({
        cookie: req.get('cookie'),
        xff: req.get('x-forwarded-for'),
        tag: req.get('x-tag'),
      });
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const resp = await sendRawHttp(
      srv.host,
      srv.port,
      'GET /headers HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Cookie: a=1\r\n' +
        'Cookie: b=2\r\n' +
        'X-Forwarded-For: 1.1.1.1\r\n' +
        'X-Forwarded-For: 2.2.2.2\r\n' +
        'X-Tag: t1\r\n' +
        'X-Tag: t2\r\n' +
        'Connection: close\r\n\r\n'
    );

    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body.toString('utf8'))).toEqual({
      cookie: 'a=1; b=2',
      xff: '1.1.1.1, 2.2.2.2',
      tag: 't1, t2',
    });
  });

  it('duplicate Content-Length (mismatching and identical) returns 400 and closes socket', async () => {
    let postHits = 0;
    const app = createApp();
    app.post('/submit', (_req, res) => {
      postHits++;
      res.status(200).send('ok');
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const mismatch = await sendRawHttp(
      srv.host,
      srv.port,
      'POST /submit HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Content-Length: 5\r\n' +
        'Content-Length: 10\r\n\r\n' +
        '1234567890'
    );
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.closed).toBe(true);

    const identical = await sendRawHttp(
      srv.host,
      srv.port,
      'POST /submit HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Content-Length: 5\r\n' +
        'Content-Length: 5\r\n\r\n' +
        '12345'
    );
    expect(identical.statusCode).toBe(400);
    expect(identical.closed).toBe(true);
    expect(postHits).toBe(0);
  });

  it('CL+TE smuggling attempt returns 400 and never invokes smuggled route', async () => {
    let postHits = 0;
    let adminHits = 0;
    const app = createApp();
    app.post('/submit', (_req, res) => {
      postHits++;
      res.status(200).send('ok');
    });
    app.get('/admin', (_req, res) => {
      adminHits++;
      res.status(200).send('pwned');
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const resp = await sendRawHttp(
      srv.host,
      srv.port,
      'POST /submit HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Content-Length: 4\r\n' +
        'Transfer-Encoding: chunked\r\n\r\n' +
        '0\r\n\r\n' +
        'GET /admin HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n\r\n'
    );

    expect(resp.statusCode).toBe(400);
    expect(resp.closed).toBe(true);
    expect(postHits).toBe(0);
    expect(adminHits).toBe(0);
  });

  it('duplicate Transfer-Encoding: chunked, chunked and non-numeric/negative Content-Length return 400', async () => {
    let postHits = 0;
    const app = createApp();
    app.post('/submit', (_req, res) => {
      postHits++;
      res.status(200).send('ok');
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const malformedPayloads = [
      'POST /submit HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked, chunked\r\n\r\n0\r\n\r\n',
      'POST /submit HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 12abc\r\n\r\n',
      'POST /submit HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: -5\r\n\r\n',
    ];

    for (const payload of malformedPayloads) {
      const resp = await sendRawHttp(srv.host, srv.port, payload);
      expect(resp.statusCode).toBe(400);
      expect(resp.closed).toBe(true);
    }

    expect(postHits).toBe(0);
  });

  itRxpress(
    'obfuscated/unsupported Transfer-Encoding (gzip, chunked / identity / bogus) returns 400 and closes socket',
    async () => {
      let postHits = 0;
      const app = createApp();
      app.post('/submit', (_req, res) => {
        postHits++;
        res.status(200).send('ok');
      });

      const srv = await startServer(app);
      trackClosable(() => srv.close());

      const payloads = [
        'POST /submit HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n',
        'POST /submit HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: identity\r\n\r\n',
        'POST /submit HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: bogus\r\n\r\n',
      ];

      for (const payload of payloads) {
        const resp = await sendRawHttp(srv.host, srv.port, payload);
        expect(resp.statusCode).toBe(400);
        expect(resp.closed).toBe(true);
      }

      expect(postHits).toBe(0);
    }
  );

  it('missing Host header in HTTP/1.1 returns 400 Bad Request', async () => {
    const app = createApp();
    app.get('/', (_req, res) => {
      res.status(200).send('ok');
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const resp = await sendRawHttp(srv.host, srv.port, 'GET / HTTP/1.1\r\n\r\n');
    expect(resp.statusCode).toBe(400);
    expect(resp.closed).toBe(true);
  });

  itRxpress(
    'duplicate Host headers in HTTP/1.1 return 400 Bad Request',
    async () => {
      const app = createApp();
      app.get('/', (_req, res) => {
        res.status(200).send('ok');
      });

      const srv = await startServer(app);
      trackClosable(() => srv.close());

      const resp = await sendRawHttp(
        srv.host,
        srv.port,
        'GET / HTTP/1.1\r\nHost: a.example\r\nHost: b.example\r\n\r\n'
      );
      expect(resp.statusCode).toBe(400);
      expect(resp.closed).toBe(true);
    }
  );

  itRxpress(
    'chunked size overflow and missing CRLF after chunk data return 400 without panic',
    async () => {
      let postHits = 0;
      const app = createApp();
      app.post('/chunk', (_req, res) => {
        postHits++;
        res.status(200).send('ok');
      });
      app.get('/health', (_req, res) => {
        res.status(200).send('healthy');
      });

      const srv = await startServer(app);
      trackClosable(() => srv.close());

      const u64OverflowResp = await sendRawHttp(
        srv.host,
        srv.port,
        'POST /chunk HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n10000000000000000\r\n'
      );
      expect(u64OverflowResp.statusCode).toBe(400);
      expect(u64OverflowResp.closed).toBe(true);

      const hugeHexResp = await sendRawHttp(
        srv.host,
        srv.port,
        'POST /chunk HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\nffffffffffffffff\r\n'
      );
      expect([400, 413]).toContain(hugeHexResp.statusCode);
      expect(hugeHexResp.closed).toBe(true);

      const badCrlfResp = await sendRawHttp(
        srv.host,
        srv.port,
        'POST /chunk HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhelloXX0\r\n\r\n'
      );
      expect(badCrlfResp.statusCode).toBe(400);
      expect(badCrlfResp.closed).toBe(true);
      expect(postHits).toBe(0);

      const health = await fetch(`${srv.baseUrl}/health`);
      expect(health.status).toBe(200);
    }
  );

  it('response header CRLF and NUL injection are blocked across setHeader, append, writeHead, location/redirect, and streaming', async () => {
    const app = createApp();

    app.get('/crlf-set', (_req, res) => {
      res.setHeader('X-Evil', 'a\r\nSet-Cookie: pwn=1');
      res.status(200).send('ok');
    });
    app.get('/crlf-append', (_req, res) => {
      res.append('X-Evil', 'a\nSet-Cookie: pwn=1');
      res.status(200).send('ok');
    });
    app.get('/nul-set', (_req, res) => {
      res.setHeader('X-Nul', 'a\0b');
      res.status(200).send('ok');
    });
    app.get('/crlf-writehead', (_req, res) => {
      res.writeHead(200, { 'X-WH': 'a\r\nSet-Cookie: pwn=1' });
      res.end('ok');
    });
    app.get('/crlf-redirect', (_req, res) => {
      res.redirect('/next\r\nSet-Cookie: pwn=1');
    });
    app.get('/crlf-stream', (_req, res) => {
      res.setHeader('X-Stream-Evil', 'a\r\nSet-Cookie: pwn=1');
      res.write('chunk');
      res.end();
    });

    app.use((_err: unknown, _req: unknown, res: { headersSent: boolean; status: (c: number) => { send: (b: string) => void } }, _next: unknown) => {
      if (!res.headersSent) {
        res.status(500).send('rejected');
      }
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    for (const path of [
      '/crlf-set',
      '/crlf-append',
      '/nul-set',
      '/crlf-writehead',
      '/crlf-stream',
    ]) {
      const resp = await sendRawHttp(
        srv.host,
        srv.port,
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`
      );
      const wire = resp.raw.toString('latin1');
      expect(wire.toLowerCase()).not.toContain('\nset-cookie: pwn=1');
      expect(wire).not.toContain('\0');
      expect(resp.statusCode).toBeGreaterThanOrEqual(400);
    }

    const redirResp = await sendRawHttp(
      srv.host,
      srv.port,
      'GET /crlf-redirect HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
    );
    const redirHeadersWire = redirResp.headersRaw;
    expect(redirHeadersWire.toLowerCase()).not.toContain('\nset-cookie: pwn=1');
    expect(redirHeadersWire).not.toContain('\0');
    expect([302, 400, 500]).toContain(redirResp.statusCode);
  });

  itRxpress(
    'invalid HTTP status code and >64KB response header fail cleanly without panic or wire corruption',
    async () => {
      const app = createApp();
      app.get('/bad-status', (_req, res) => {
        res.status(1000).send('bad');
      });
      app.get('/huge-header', (_req, res) => {
        res.setHeader('X-Huge', 'x'.repeat(70000));
        res.status(200).send('ok');
      });
      app.get('/health', (_req, res) => {
        res.status(200).send('healthy');
      });
      app.use((_err: unknown, _req: unknown, res: { headersSent: boolean; status: (c: number) => { send: (b: string) => void } }, _next: unknown) => {
        if (!res.headersSent) {
          res.status(500).send('handled-error');
        }
      });

      const srv = await startServer(app);
      trackClosable(() => srv.close());

      const badStatusResp = await sendRawHttp(
        srv.host,
        srv.port,
        'GET /bad-status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
      );
      expect(
        badStatusResp.statusCode >= 400 ||
          (badStatusResp.statusCode === 0 && badStatusResp.closed)
      ).toBe(true);

      const hugeHeaderResp = await sendRawHttp(
        srv.host,
        srv.port,
        'GET /huge-header HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
      );
      expect(
        hugeHeaderResp.statusCode >= 400 ||
          (hugeHeaderResp.statusCode === 0 && hugeHeaderResp.closed)
      ).toBe(true);

      const health = await fetch(`${srv.baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe('healthy');
    }
  );
});
