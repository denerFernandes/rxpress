// Differential HTTP/1.1 framing harness: the same raw bytes go to a plain `node:http` server
// (llhttp) and to an rxpress server; each records the requests whose body it fully received.
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createApp, rawMiddleware, startServer, type StartedServer } from './server.js';

export interface SeenRequest {
  method: string;
  url: string;
  body: string;
}

export interface ExchangeResult {
  /** Status codes of every response received on the connection, in order. */
  statuses: number[];
  /** Requests the server application fully received (headers + whole body), in order. */
  seen: SeenRequest[];
  /** Whether the server closed the connection before our idle timeout. */
  closedByServer: boolean;
}

export interface DiffTarget {
  name: 'node' | 'rxpress';
  port: number;
  seen: SeenRequest[];
  close(): Promise<void>;
}

export async function startNodeTarget(): Promise<DiffTarget> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      seen.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.setHeader('content-type', 'text/plain');
      res.end(`seen:${body.length}`);
    });
    req.on('error', () => {});
  });
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    name: 'node',
    port,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export async function startRxpressTarget(): Promise<DiffTarget & { srv: StartedServer }> {
  const seen: SeenRequest[] = [];
  const app = createApp();
  app.use(rawMiddleware({ type: () => true, limit: '1mb' }));
  app.use((req, res) => {
    const r = req as unknown as { method: string; originalUrl: string; body: unknown };
    const body = Buffer.isBuffer(r.body) ? r.body.toString('latin1') : '';
    seen.push({ method: r.method, url: r.originalUrl, body });
    res.set('content-type', 'text/plain');
    res.send(`seen:${body.length}`);
  });
  const srv = await startServer(app);
  return { name: 'rxpress', port: srv.port, seen, srv, close: () => srv.close() };
}

/**
 * Writes `bytes`, then reads until the server closes or stays idle for `idleMs`.
 * The client never half-closes, so an incomplete message is simply left pending.
 */
export function exchange(
  target: DiffTarget,
  bytes: Buffer,
  opts: { idleMs?: number; maxMs?: number } = {}
): Promise<ExchangeResult> {
  const idleMs = opts.idleMs ?? 200;
  const maxMs = opts.maxMs ?? 3000;
  const startIdx = target.seen.length;
  return new Promise<ExchangeResult>((resolve) => {
    const chunks: Buffer[] = [];
    let closed = false;
    let done = false;
    const sock = net.connect(target.port, '127.0.0.1');
    let idle: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      clearTimeout(hard);
      sock.destroy();
      // Let the server-side handlers for already-sent responses settle.
      setTimeout(() => {
        resolve({
          statuses: parseStatuses(Buffer.concat(chunks)),
          seen: target.seen.slice(startIdx),
          closedByServer: closed,
        });
      }, 10);
    };
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(finish, idleMs);
    };
    const hard = setTimeout(finish, maxMs);
    sock.on('connect', () => {
      sock.write(bytes);
      arm();
    });
    sock.on('data', (c: Buffer) => {
      chunks.push(c);
      arm();
    });
    sock.on('end', () => {
      closed = true;
      finish();
    });
    sock.on('close', () => {
      closed = true;
      finish();
    });
    sock.on('error', () => {
      closed = true;
      finish();
    });
  });
}

/** Extracts the status code of every response (handles Content-Length and chunked bodies). */
export function parseStatuses(buf: Buffer): number[] {
  const out: number[] = [];
  let off = 0;
  const s = buf.toString('latin1');
  while (off < s.length) {
    const m = /^HTTP\/1\.[01] (\d{3})[^\r\n]*\r\n/.exec(s.slice(off));
    if (!m) break;
    out.push(Number(m[1]));
    const headEnd = s.indexOf('\r\n\r\n', off);
    if (headEnd === -1) break;
    const head = s.slice(off, headEnd).toLowerCase();
    let next = headEnd + 4;
    const cl = /\r\ncontent-length:\s*(\d+)/.exec(head);
    if (/\r\ntransfer-encoding:[^\r\n]*chunked/.test(head)) {
      while (true) {
        const le = s.indexOf('\r\n', next);
        if (le === -1) return out;
        const size = Number.parseInt(s.slice(next, le), 16);
        next = le + 2 + size + 2;
        if (!size) {
          next = le + 4;
          break;
        }
      }
    } else if (cl) {
      next += Number(cl[1]);
    } else if (Number(m[1]) >= 200 && Number(m[1]) !== 204 && Number(m[1]) !== 304) {
      break; // read-until-close body
    }
    off = next;
  }
  return out;
}

export type Verdict = 'accepted' | 'rejected' | 'pending';

/** Accepted when the first response is 2xx; rejected on 4xx/5xx or close without a response. */
export function verdict(r: ExchangeResult): Verdict {
  const first = r.statuses[0];
  if (first !== undefined) return first < 400 ? 'accepted' : 'rejected';
  return r.closedByServer ? 'rejected' : 'pending';
}
