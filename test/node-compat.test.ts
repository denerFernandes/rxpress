// Node behaviours that code written for Express may rely on: the peer port of the connection and
// `instanceof` checks against the http classes.
import http from 'node:http';
import { createConnection, type AddressInfo as NetAddress } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import rxpress from '../js/index.js';

type Closable = { close(): Promise<void> | void };
const open: Closable[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function serve(app: ReturnType<typeof rxpress>): Promise<number> {
  const server = await new Promise<Closable & { address(): { port: number } }>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s as never)) as never;
  });
  open.push(server);
  return server.address().port;
}

describe('req.socket.remotePort', () => {
  it('is the port the client connected from, with remoteAddress and remoteFamily', async () => {
    const app = rxpress();
    app.get('/peer', (req, res) => {
      const s = req.socket;
      res.json({ address: s.remoteAddress, port: s.remotePort, family: s.remoteFamily });
    });
    const port = await serve(app);

    const seen = await new Promise<{ localPort: number; body: string }>((resolve, reject) => {
      let localPort = 0;
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        localPort = socket.localPort!; // gone once the socket is closed
        socket.write('GET /peer HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', (c) => (data += c));
      socket.on('error', reject);
      socket.on('close', () => resolve({ localPort, body: data }));
    });
    const body = JSON.parse(seen.body.slice(seen.body.indexOf('{')));
    expect(body.port).toBe(seen.localPort);
    expect(body).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
  });

  it('differs between connections and matches res.socket and req.connection', async () => {
    const app = rxpress();
    app.get('/p', (req, res) => {
      res.json({
        req: req.socket.remotePort,
        res: res.socket.remotePort,
        connection: req.connection.remotePort,
      });
    });
    const port = await serve(app);

    const ports = new Set<number>();
    for (let i = 0; i < 3; i++) {
      // Each request on its own connection (no keep-alive).
      const body = await new Promise<{ req: number; res: number; connection: number }>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: '/p', agent: false }, (r) => {
            let data = '';
            r.on('data', (c) => (data += c));
            r.on('end', () => resolve(JSON.parse(data)));
          })
          .on('error', reject);
      });
      expect(body.res).toBe(body.req);
      expect(body.connection).toBe(body.req);
      expect(Number.isInteger(body.req) && body.req > 0 && body.req < 65536).toBe(true);
      ports.add(body.req);
    }
    expect(ports.size).toBeGreaterThan(1);
  });
});

describe('instanceof http.IncomingMessage / http.ServerResponse', () => {
  it('is true for rxpress requests and responses, as in Express', async () => {
    const app = rxpress();
    app.get('/', (req, res) => {
      res.json({
        req: req instanceof http.IncomingMessage,
        res: res instanceof http.ServerResponse,
        reqIsResponse: req instanceof http.ServerResponse,
        resIsRequest: res instanceof http.IncomingMessage,
      });
    });
    const port = await serve(app);
    const body = await (await fetch(`http://127.0.0.1:${port}/`)).json();
    expect(body).toEqual({ req: true, res: true, reqIsResponse: false, resIsRequest: false });
  });

  it('leaves everything else as it was', () => {
    expect({} instanceof http.IncomingMessage).toBe(false);
    expect((null as unknown) instanceof http.IncomingMessage).toBe(false);
    expect(Object.create(null) instanceof http.ServerResponse).toBe(false);
    expect(new http.ServerResponse(new http.IncomingMessage(undefined as never)) instanceof http.ServerResponse).toBe(true);
  });

  it('does not change the answer for subclasses', async () => {
    class MyRequest extends http.IncomingMessage {}
    class MyResponse extends http.ServerResponse {}
    const app = rxpress();
    app.get('/', (req, res) => {
      res.json({ req: req instanceof MyRequest, res: res instanceof MyResponse });
    });
    const port = await serve(app);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).json()).toEqual({ req: false, res: false });
    expect(new MyRequest(undefined as never) instanceof http.IncomingMessage).toBe(true);
  });

  it('works for a request that came through the Node bridge too', async () => {
    const app = rxpress();
    app.get('/', (req, res) => res.json({ req: req instanceof http.IncomingMessage, res: res instanceof http.ServerResponse }));
    // A plain Node server calling the app: the app answers through the engine bridge.
    const server = http.createServer((req, res) => app(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    open.push({ close: () => new Promise<void>((r) => server.close(() => r())) });
    const port = (server.address() as NetAddress).port;
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).json()).toEqual({ req: true, res: true });
  });
});
