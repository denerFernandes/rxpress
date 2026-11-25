import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeChunkedBody,
  openRawSocket,
  sendRawHttp,
  type RawSocketClient,
} from './helpers/raw-http.js';
import {
  createApp,
  itRxpress,
  jsonMiddleware,
  startServer,
  urlencodedMiddleware,
} from './helpers/server.js';

const activeClosables: Array<() => Promise<unknown>> = [];
const activeSockets: RawSocketClient[] = [];
const activeAgents: http.Agent[] = [];

function trackClosable(fn: () => Promise<unknown>): void {
  activeClosables.push(fn);
}

function trackSocket(sock: RawSocketClient): RawSocketClient {
  activeSockets.push(sock);
  return sock;
}

function trackAgent(agent: http.Agent): http.Agent {
  activeAgents.push(agent);
  return agent;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function agentRequest(
  port: number,
  path: string,
  agent: http.Agent,
  method = 'GET',
  body?: string,
  headers?: Record<string, string>
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  socket: unknown;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        agent,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString('utf8'),
            socket: res.socket,
          });
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error('agentRequest timed out')));
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function parsePipelinedResponses(raw: Buffer): Array<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}> {
  const out: Array<{ statusCode: number; headers: Record<string, string>; body: string }> = [];
  const headerDelim = Buffer.from('\r\n\r\n', 'latin1');
  let offset = 0;

  while (offset < raw.length) {
    const headerEnd = raw.indexOf(headerDelim, offset);
    if (headerEnd === -1) break;

    const headText = raw.subarray(offset, headerEnd).toString('latin1');
    const lines = headText.split('\r\n');
    const statusMatch = /^HTTP\/\d+\.\d+\s+(\d{3})/.exec(lines[0] ?? '');
    const statusCode = statusMatch ? Number.parseInt(statusMatch[1], 10) : 0;

    const headers: Record<string, string> = Object.create(null) as Record<string, string>;
    for (let i = 1; i < lines.length; i++) {
      const idx = lines[i].indexOf(':');
      if (idx === -1) continue;
      const k = lines[i].slice(0, idx).trim().toLowerCase();
      const v = lines[i].slice(idx + 1).trim();
      headers[k] = v;
    }

    const bodyStart = headerEnd + 4;
    let bodyBuf = Buffer.alloc(0);
    let nextOffset = bodyStart;

    if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
      const termIdx = raw.indexOf(Buffer.from('0\r\n\r\n', 'latin1'), bodyStart);
      if (termIdx === -1) {
        throw new Error('Incomplete chunked response in pipeline buffer');
      }
      const chunkSlice = raw.subarray(bodyStart, termIdx + 5);
      bodyBuf = Buffer.from(decodeChunkedBody(chunkSlice));
      nextOffset = termIdx + 5;
    } else if (headers['content-length'] !== undefined) {
      const cl = Number.parseInt(headers['content-length'], 10);
      bodyBuf = Buffer.from(raw.subarray(bodyStart, bodyStart + cl));
      nextOffset = bodyStart + cl;
    } else {
      bodyBuf = Buffer.from(raw.subarray(bodyStart));
      nextOffset = raw.length;
    }

    out.push({
      statusCode,
      headers,
      body: bodyBuf.toString('utf8'),
    });
    offset = nextOffset;
  }

  return out;
}

afterEach(async () => {
  while (activeSockets.length > 0) {
    activeSockets.pop()?.destroy();
  }
  while (activeAgents.length > 0) {
    activeAgents.pop()?.destroy();
  }
  while (activeClosables.length > 0) {
    const closeFn = activeClosables.pop();
    if (closeFn) {
      await Promise.allSettled([closeFn()]);
    }
  }
});

describe('Cross-Request Pooling Isolation & Prototype Pollution Defense', () => {
  it('custom req.*, res.*, and res.locals properties do not leak across keep-alive requests', async () => {
    const app = createApp();
    app.get('/mutate', (req, res) => {
      req.user = 'alice';
      res.customTag = 'A';
      res.locals.secret = 's1';
      res.json({ mutated: true });
    });
    app.get('/inspect', (req, res) => {
      res.json({
        user: req.user ?? null,
        customTag: res.customTag ?? null,
        secret: res.locals.secret ?? null,
      });
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const agent = trackAgent(new http.Agent({ keepAlive: true, maxSockets: 1 }));
    const r1 = await agentRequest(srv.port, '/mutate', agent);
    expect(r1.statusCode).toBe(200);

    const r2 = await agentRequest(srv.port, '/inspect', agent);
    expect(r2.statusCode).toBe(200);
    expect(r2.socket).toBe(r1.socket);
    expect(JSON.parse(r2.body)).toEqual({
      user: null,
      customTag: null,
      secret: null,
    });
  });

  it('wrapped res.end, res.write, and res.writeHead do not leak to subsequent clean routes', async () => {
    let wrapperCalls = 0;
    const app = createApp();
    app.get('/wrapped', (_req, res) => {
      const origWriteHead = res.writeHead.bind(res);
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);

      res.writeHead = ((
        statusCode: number,
        statusMessageOrHeaders?: string | Record<string, string | number | string[]>,
        maybeHeaders?: Record<string, string | number | string[]>
      ) => {
        wrapperCalls++;
        if (typeof statusMessageOrHeaders === 'string') {
          return origWriteHead(statusCode, statusMessageOrHeaders, maybeHeaders);
        }
        return origWriteHead(statusCode, statusMessageOrHeaders);
      }) as typeof res.writeHead;

      res.write = ((
        chunk: string | Buffer | Uint8Array,
        encodingOrCb?: BufferEncoding | (() => void),
        maybeCb?: () => void
      ) => {
        wrapperCalls++;
        if (typeof encodingOrCb === 'function') {
          return origWrite(chunk, encodingOrCb);
        }
        return origWrite(chunk, encodingOrCb, maybeCb);
      }) as typeof res.write;

      res.end = ((
        dataOrCb?: string | Buffer | Uint8Array | (() => void),
        encodingOrCb?: BufferEncoding | (() => void),
        maybeCb?: () => void
      ) => {
        wrapperCalls++;
        if (!res.headersSent) {
          res.setHeader('X-Wrapped', '1');
        }
        if (typeof dataOrCb === 'function') {
          return origEnd(dataOrCb);
        }
        if (typeof encodingOrCb === 'function') {
          return origEnd(dataOrCb ?? '', encodingOrCb);
        }
        if (dataOrCb === undefined) {
          return origEnd();
        }
        return origEnd(dataOrCb, encodingOrCb, maybeCb);
      }) as typeof res.end;

      res.status(200).send('wrapped');
    });

    app.get('/clean', (_req, res) => {
      res.json({ ok: 1 });
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const agent = trackAgent(new http.Agent({ keepAlive: true, maxSockets: 1 }));
    const r1 = await agentRequest(srv.port, '/wrapped', agent);
    expect(r1.statusCode).toBe(200);
    expect(r1.headers['x-wrapped']).toBe('1');
    const callsAfterWrapped = wrapperCalls;
    expect(callsAfterWrapped).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < 3; i++) {
      const clean = await agentRequest(srv.port, '/clean', agent);
      expect(clean.statusCode).toBe(200);
      expect(clean.headers['x-wrapped']).toBeUndefined();
      expect(JSON.parse(clean.body)).toEqual({ ok: 1 });
      expect(clean.socket).toBe(r1.socket);
    }

    expect(wrapperCalls).toBe(callsAfterWrapped);
  });

  it('req.on("close") and res.on("finish") listeners do not fire on subsequent pooled requests', async () => {
    let finishHits = 0;
    let closeHits = 0;

    const app = createApp();
    app.get('/attach', (req, res) => {
      res.on('finish', () => {
        finishHits++;
      });
      req.on('close', () => {
        closeHits++;
      });
      res.status(200).send('attached');
    });
    app.get('/clean', (_req, res) => {
      res.json({ finishHits, closeHits });
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const agent = trackAgent(new http.Agent({ keepAlive: true, maxSockets: 1 }));
    const first = await agentRequest(srv.port, '/attach', agent);
    expect(first.statusCode).toBe(200);
    await delay(20);
    const baselineCloseHits = closeHits;
    expect(finishHits).toBe(1);
    expect(baselineCloseHits).toBeLessThanOrEqual(1);

    for (let i = 0; i < 4; i++) {
      const clean = await agentRequest(srv.port, '/clean', agent);
      expect(clean.statusCode).toBe(200);
      expect(clean.socket).toBe(first.socket);
      expect(finishHits).toBe(1);
      expect(closeHits).toBe(baselineCloseHits);
    }
  });

  it('valid nested objects in query, JSON, and urlencoded parse cleanly without polluting Object.prototype', async () => {
    const app = createApp();
    app.set('query parser', 'extended');
    app.use(jsonMiddleware());
    app.use(urlencodedMiddleware({ extended: true }));

    app.get('/q', (req, res) => {
      res.json({ query: req.query });
    });
    app.post('/json', (req, res) => {
      res.json({ body: req.body });
    });
    app.post('/form', (req, res) => {
      res.json({ body: req.body });
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const qRes = await fetch(`${srv.baseUrl}/q?user[name]=bob&tags[]=a&tags[]=b`);
    expect(qRes.status).toBe(200);
    expect(await qRes.json()).toEqual({
      query: { user: { name: 'bob' }, tags: ['a', 'b'] },
    });

    const jRes = await fetch(`${srv.baseUrl}/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { name: 'bob' } }),
    });
    expect(jRes.status).toBe(200);
    expect(await jRes.json()).toEqual({ body: { user: { name: 'bob' } } });

    const fRes = await fetch(`${srv.baseUrl}/form`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'user[name]=bob&tags[]=x',
    });
    expect(fRes.status).toBe(200);
    expect(await fRes.json()).toEqual({
      body: { user: { name: 'bob' }, tags: ['x'] },
    });

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('8-request pipelined heterogeneous batch preserves FIFO order and zero state leakage', async () => {
    const app = createApp();
    app.use(jsonMiddleware());

    app.get('/set-custom', (req, res) => {
      req.customVal = 'leaked';
      res.locals.dirty = true;
      res.json({ step: 'set' });
    });
    app.get('/clean', (req, res) => {
      res.json({
        step: 'clean',
        customVal: req.customVal ?? null,
        dirty: res.locals.dirty ?? null,
      });
    });
    app.get('/error', () => {
      throw Object.assign(new Error('pipeline-err'), { status: 400 });
    });
    app.get('/wrap', (_req, res) => {
      const origEnd = res.end.bind(res);
      res.end = ((
        dataOrCb?: string | Buffer | Uint8Array | (() => void),
        encodingOrCb?: BufferEncoding | (() => void),
        maybeCb?: () => void
      ) => {
        if (!res.headersSent) {
          res.setHeader('X-Pipelined-Wrap', '1');
        }
        if (typeof dataOrCb === 'function') return origEnd(dataOrCb);
        if (typeof encodingOrCb === 'function') return origEnd(dataOrCb ?? '', encodingOrCb);
        if (dataOrCb === undefined) return origEnd();
        return origEnd(dataOrCb, encodingOrCb, maybeCb);
      }) as typeof res.end;
      res.json({ step: 'wrap' });
    });
    app.post('/json-post', (req, res) => {
      const body = req.body as { val: number };
      res.json({ step: 'json', val: body.val });
    });

    app.use(
      (
        err: unknown,
        _req: unknown,
        res: { status: (c: number) => { json: (b: unknown) => void } },
        _next: unknown
      ) => {
        const status =
          typeof err === 'object' && err !== null && 'status' in err
            ? Number((err as { status: unknown }).status) || 500
            : 500;
        res.status(status).json({ step: 'error' });
      }
    );

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const jsonPayload = JSON.stringify({ val: 99 });
    const batch =
      'GET /set-custom HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
      'GET /clean HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
      'GET /error HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
      'GET /clean HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
      'GET /wrap HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
      'GET /clean HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n' +
      `POST /json-post HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(jsonPayload)}\r\n\r\n${jsonPayload}` +
      'GET /clean HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n';

    const client = trackSocket(await openRawSocket(srv.host, srv.port));
    await client.write(batch);
    expect(await client.waitForClose(5000)).toBe(true);

    const responses = parsePipelinedResponses(client.getBufferedData());
    expect(responses.length).toBe(8);

    expect(responses[0].statusCode).toBe(200);
    expect(JSON.parse(responses[0].body)).toEqual({ step: 'set' });

    expect(responses[1].statusCode).toBe(200);
    expect(JSON.parse(responses[1].body)).toEqual({
      step: 'clean',
      customVal: null,
      dirty: null,
    });

    expect(responses[2].statusCode).toBe(400);
    expect(JSON.parse(responses[2].body)).toEqual({ step: 'error' });

    expect(responses[3].statusCode).toBe(200);
    expect(JSON.parse(responses[3].body)).toEqual({
      step: 'clean',
      customVal: null,
      dirty: null,
    });

    expect(responses[4].statusCode).toBe(200);
    expect(responses[4].headers['x-pipelined-wrap']).toBe('1');
    expect(JSON.parse(responses[4].body)).toEqual({ step: 'wrap' });

    expect(responses[5].statusCode).toBe(200);
    expect(responses[5].headers['x-pipelined-wrap']).toBeUndefined();
    expect(JSON.parse(responses[5].body)).toEqual({
      step: 'clean',
      customVal: null,
      dirty: null,
    });

    expect(responses[6].statusCode).toBe(200);
    expect(JSON.parse(responses[6].body)).toEqual({ step: 'json', val: 99 });

    expect(responses[7].statusCode).toBe(200);
    expect(responses[7].headers['x-pipelined-wrap']).toBeUndefined();
    expect(JSON.parse(responses[7].body)).toEqual({
      step: 'clean',
      customVal: null,
      dirty: null,
    });
  });

  it('prototype pollution via query string leaves Object.prototype untouched', async () => {
    const app = createApp();
    app.set('query parser', 'extended');
    app.get('/q', (req, res) => {
      res.json({
        hasOwnProto: Object.prototype.hasOwnProperty.call(req.query, '__proto__'),
        polluted: ({} as Record<string, unknown>).polluted ?? 'clean',
      });
    });
    app.get('/check-proto', (_req, res) => {
      res.json({
        polluted: ({} as Record<string, unknown>).polluted ?? 'clean',
      });
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const r1 = await fetch(
      `${srv.baseUrl}/q?__proto__[polluted]=yes&constructor[prototype][polluted]=yes`
    );
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ hasOwnProto: false, polluted: 'clean' });

    const r2 = await fetch(`${srv.baseUrl}/check-proto`);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ polluted: 'clean' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('prototype pollution via JSON body leaves Object.prototype untouched', async () => {
    const app = createApp();
    app.use(jsonMiddleware());
    app.post('/json', (req, res) => {
      const probe = {} as Record<string, unknown>;
      res.json({
        polluted: probe.polluted ?? 'clean',
        p2: probe.p2 ?? 'clean',
        ok: (req.body as Record<string, unknown>).ok,
        hasOwnProto: Object.prototype.hasOwnProperty.call(req.body, '__proto__'),
      });
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const resp = await fetch(`${srv.baseUrl}/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"__proto__":{"polluted":true},"constructor":{"prototype":{"p2":true}},"ok":1}',
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      polluted: string;
      p2: string;
      ok: number;
      hasOwnProto: boolean;
    };
    expect(data.polluted).toBe('clean');
    expect(data.p2).toBe('clean');
    expect(data.ok).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).p2).toBeUndefined();
  });

  it('prototype pollution via urlencoded body and HTTP headers leaves Object.prototype clean', async () => {
    const app = createApp();
    app.use(urlencodedMiddleware({ extended: false }));
    app.post('/form', (req, res) => {
      const body = req.body as Record<string, unknown>;
      res.json({
        ok: body.ok,
        polluted: ({} as Record<string, unknown>).p ?? 'clean',
        hasOwnProtoHeader: Object.prototype.hasOwnProperty.call(req.headers, '__proto__'),
      });
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const payload = '__proto__[p]=1&constructor[prototype][p]=1&ok=yes';
    const resp = await sendRawHttp(
      srv.host,
      srv.port,
      'POST /form HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Content-Type: application/x-www-form-urlencoded\r\n' +
        '__proto__: evil\r\n' +
        'constructor: evil\r\n' +
        `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
        `Connection: close\r\n\r\n${payload}`
    );

    expect(resp.statusCode).toBe(200);
    const parsed = JSON.parse(resp.body.toString('utf8')) as {
      ok: string;
      polluted: string;
      hasOwnProtoHeader: boolean;
    };
    expect(parsed.ok).toBe('yes');
    expect(parsed.polluted).toBe('clean');
    expect(parsed.hasOwnProtoHeader).toBe(false);
    expect(({} as Record<string, unknown>).p).toBeUndefined();
  });

  itRxpress(
    'prototype pollution via built-in req.cookies leaves Object.prototype clean and protects cookie map',
    async () => {
      const app = createApp();
      app.get('/cookies', (req, res) => {
        res.json({
          ok: req.cookies.ok,
          hasOwnProto: Object.prototype.hasOwnProperty.call(req.cookies, '__proto__'),
          polluted: ({} as Record<string, unknown>).polluted ?? 'clean',
        });
      });

      const srv = await startServer(app);
      trackClosable(() => srv.close());

      const resp = await sendRawHttp(
        srv.host,
        srv.port,
        'GET /cookies HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Cookie: __proto__=evil; constructor=evil; ok=1\r\n' +
          'Connection: close\r\n\r\n'
      );

      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body.toString('utf8'))).toEqual({
        ok: '1',
        hasOwnProto: false,
        polluted: 'clean',
      });
    }
  );

  it('query and urlencoded parameterLimit and nesting maxDepth caps bound parsing cleanly', async () => {
    const app = createApp();
    app.set('query parser', 'extended');
    app.use(urlencodedMiddleware({ extended: true, parameterLimit: 1000 }));

    app.get('/q', (req, res) => {
      res.json({ keyCount: Object.keys(req.query).length });
    });
    app.post('/form', (req, res) => {
      const body = req.body as Record<string, unknown>;
      res.json({ keyCount: Object.keys(body).length });
    });
    app.get('/health', (_req, res) => {
      res.status(200).send('ok');
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    // 1) ~1,150 short GET query params (<12KB total request header size)
    const shortParams = Array.from({ length: 1150 }, (_, i) => `a${i}=1`).join('&');
    expect(shortParams.length).toBeLessThan(12000);
    const qResp = await fetch(`${srv.baseUrl}/q?${shortParams}`);
    expect([200, 400, 413]).toContain(qResp.status);
    if (qResp.status === 200) {
      const data = (await qResp.json()) as { keyCount: number };
      expect(data.keyCount).toBeLessThanOrEqual(1000);
    }

    // 2) 2,000 urlencoded POST params
    const formParams = Array.from({ length: 2000 }, (_, i) => `k${i}=1`).join('&');
    const fResp = await fetch(`${srv.baseUrl}/form`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formParams,
    });
    expect([200, 400, 413]).toContain(fResp.status);
    if (fResp.status === 200) {
      const data = (await fResp.json()) as { keyCount: number };
      expect(data.keyCount).toBeLessThanOrEqual(1000);
    }

    // 3) 50-level deep bracket nesting on both GET query and urlencoded POST
    const deepKey = `a${'[b]'.repeat(50)}=1`;
    const deepQueryResp = await fetch(`${srv.baseUrl}/q?${deepKey}`);
    expect([200, 400, 413]).toContain(deepQueryResp.status);

    const deepFormResp = await fetch(`${srv.baseUrl}/form`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: deepKey,
    });
    expect([200, 400, 413]).toContain(deepFormResp.status);

    const health = await fetch(`${srv.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');
  });

  it('async route mutating req properties does not leak into concurrent fast sync requests', async () => {
    const app = createApp();
    app.get('/async', async (req, res) => {
      req.tag = 'async';
      await delay(50);
      res.json({ tag: req.tag });
    });
    app.get('/sync', (req, res) => {
      res.json({ tag: req.tag ?? null });
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const asyncCalls = Array.from({ length: 5 }, () =>
      fetch(`${srv.baseUrl}/async`).then((r) => r.json() as Promise<{ tag: string | null }>)
    );
    const syncCalls = Array.from({ length: 50 }, () =>
      fetch(`${srv.baseUrl}/sync`).then((r) => r.json() as Promise<{ tag: string | null }>)
    );

    const [asyncResults, syncResults] = await Promise.all([
      Promise.all(asyncCalls),
      Promise.all(syncCalls),
    ]);

    for (const item of asyncResults) {
      expect(item.tag).toBe('async');
    }
    for (const item of syncResults) {
      expect(item.tag).toBeNull();
    }
  });

  it('mutating req.url, req.baseUrl, req.params, req.body, headers, and res.status on Req 1 leaves Req 2 clean on keep-alive', async () => {
    const app = createApp();
    app.get('/mutate-req', (req, res) => {
      req.url = '/rewritten';
      req.baseUrl = '/fake';
      req.params = { id: '999' };
      req.body = { hacked: true };
      (req.headers as Record<string, string>)['x-mutated'] = '1';
      res.status(418).json({ mutated: true, query: req.query });
    });
    app.get('/clean/:id', (req, res) => {
      res.json({
        url: req.url,
        baseUrl: req.baseUrl,
        params: req.params,
        query: req.query,
        body: req.body ?? null,
        mutatedHeader: req.get('x-mutated') ?? null,
        statusCode: res.statusCode,
      });
    });

    const srv = await startServer(app);
    trackClosable(() => srv.close());

    const agent = trackAgent(new http.Agent({ keepAlive: true, maxSockets: 1 }));
    const r1 = await agentRequest(srv.port, '/mutate-req?hacked=1', agent);
    expect(r1.statusCode).toBe(418);

    const r2 = await agentRequest(srv.port, '/clean/42?a=1', agent);
    expect(r2.statusCode).toBe(200);
    expect(r2.socket).toBe(r1.socket);
    expect(JSON.parse(r2.body)).toEqual({
      url: '/clean/42?a=1',
      baseUrl: '',
      params: { id: '42' },
      query: { a: '1' },
      body: null,
      mutatedHeader: null,
      statusCode: 200,
    });
  });
});
