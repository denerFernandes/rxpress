// Compat path: an rxpress app invoked with Node's own IncomingMessage/ServerResponse.
//
// That happens when the app is mounted in a real Express app (`expressApp.use('/x', rxApp)`),
// handed to an `http.Server` rxpress could not intercept, or driven by a serverless adapter.
// Rather than re-implementing the engine in JS, the request is forwarded over a keep-alive
// loopback connection to a private instance of the Rust engine serving the same app, and the
// answer is streamed back. Behaviour (static files, ETag/304, body limits...) is therefore
// identical to the native path; the cost is one local hop, paid only on this path.
//
// A per-process secret on the forwarded request carries what the app must see from the
// original connection (peer address, TLS, original/base URL) and whether the caller has a
// `next` to fall through to: then "no route matched" and errors are handed back to it instead
// of being answered, exactly like an Express sub-app.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Application } from './application.js';
import type { NextFunction } from './types.js';

export const BRIDGE_HEADER = 'x-rxpress-bridge';
export const BRIDGE_NEXT_HEADER = 'x-rxpress-bridge-next';
const TOKEN = randomBytes(18).toString('base64url');

/** Hop-by-hop / connection-scoped headers that must not cross the bridge. */
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  BRIDGE_HEADER,
  BRIDGE_NEXT_HEADER,
]);

interface Bridge {
  port: number;
  agent: http.Agent;
}

const bridges = new WeakMap<Application, Bridge>();

function getBridge(app: Application): Bridge {
  let b = bridges.get(app);
  if (!b) {
    const handle = app._startBridge();
    b = {
      port: handle.address()!.port,
      agent: new http.Agent({ keepAlive: true, keepAliveMsecs: 1000 }),
    };
    bridges.set(app, b);
  }
  return b;
}

export interface BridgeMeta {
  peer: string;
  tls: boolean;
  originalUrl: string;
  baseUrl: string;
  hasNext: boolean;
}

const TOKEN_BUF = Buffer.from(TOKEN);
function tokenMatches(given: string): boolean {
  const g = Buffer.from(given);
  return g.length === TOKEN_BUF.length && timingSafeEqual(g, TOKEN_BUF);
}

/** Parse and authenticate the bridge header; `null` for anything not sent by this process. */
export function parseBridgeHeader(value: string | undefined): BridgeMeta | null {
  if (!value) return null;
  const parts = value.split(';');
  if (parts.length !== 6 || !tokenMatches(parts[0])) return null;
  try {
    return {
      tls: parts[1] === '1',
      hasNext: parts[2] === '1',
      peer: decodeURIComponent(parts[3]),
      originalUrl: decodeURIComponent(parts[4]),
      baseUrl: decodeURIComponent(parts[5]),
    };
  } catch {
    return null;
  }
}

type NodeReq = IncomingMessage & {
  originalUrl?: string;
  baseUrl?: string;
  body?: unknown;
};

/** Re-encode a body a parent's parser already consumed from the stream. */
function consumedBody(req: NodeReq): Buffer | null {
  const body = req.body;
  if (body === undefined) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(JSON.stringify(body), 'utf8');
}

export function bridgeHandle(
  app: Application,
  req: NodeReq,
  res: ServerResponse,
  next?: NextFunction
): void {
  let bridge: Bridge;
  try {
    bridge = getBridge(app);
  } catch (err) {
    if (next) return next(err);
    res.statusCode = 500;
    res.end();
    return;
  }

  const headers: Record<string, string | string[]> = Object.create(null);
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const k = raw[i].toLowerCase();
    if (HOP.has(k)) continue;
    const v = raw[i + 1];
    const prev = headers[k];
    headers[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }

  // A parent parser (body-parser in a real Express app) may already have read the stream.
  const consumed = req.readableEnded && req.body !== undefined;
  let payload: Buffer | null = null;
  if (consumed) {
    payload = consumedBody(req);
    if (payload !== null) {
      if (!Buffer.isBuffer(req.body) && typeof req.body !== 'string') {
        const ct = String(headers['content-type'] ?? '');
        if (!/json/i.test(ct)) headers['content-type'] = 'application/json';
      }
      headers['content-length'] = String(payload.length);
      delete headers['content-encoding'];
    }
  }

  const sock = req.socket as (typeof req.socket & { encrypted?: boolean }) | null;
  const originalUrl = req.originalUrl ?? req.url ?? '/';
  headers[BRIDGE_HEADER] = [
    TOKEN,
    sock?.encrypted ? '1' : '0',
    next ? '1' : '0',
    encodeURIComponent(sock?.remoteAddress ?? ''),
    encodeURIComponent(originalUrl),
    encodeURIComponent(req.baseUrl ?? ''),
  ].join(';');

  const proxyReq = http.request({
    host: '127.0.0.1',
    port: bridge.port,
    method: req.method,
    path: req.url || '/',
    headers,
    agent: bridge.agent,
    setHost: false,
  });

  let settled = false;
  const fail = (err: Error): void => {
    if (settled) return;
    settled = true;
    if (next && !res.headersSent) return next(err);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end();
    } else {
      res.destroy(err);
    }
  };

  proxyReq.on('error', fail);
  res.on('close', () => {
    if (!res.writableFinished) proxyReq.destroy();
  });

  proxyReq.on('response', (pres) => {
    const mark = pres.headers[BRIDGE_NEXT_HEADER];
    if (mark !== undefined && next) {
      settled = true;
      if (mark === '0') {
        pres.resume();
        pres.on('end', () => next());
        return;
      }
      const chunks: Buffer[] = [];
      pres.on('data', (c: Buffer) => chunks.push(c));
      pres.on('end', () => {
        const status = Number(mark) || 500;
        const err = new Error(Buffer.concat(chunks).toString('utf8')) as Error & {
          status: number;
          statusCode: number;
          expose: boolean;
        };
        err.status = status;
        err.statusCode = status;
        err.expose = status < 500;
        next(err);
      });
      return;
    }

    settled = true;
    res.statusCode = pres.statusCode ?? 502;
    if (pres.statusMessage) res.statusMessage = pres.statusMessage;
    const out: Record<string, string | string[]> = Object.create(null);
    const rh = pres.rawHeaders;
    for (let i = 0; i + 1 < rh.length; i += 2) {
      const k = rh[i].toLowerCase();
      if (HOP.has(k)) continue;
      const prev = out[k];
      out[k] = prev === undefined ? rh[i + 1] : Array.isArray(prev) ? [...prev, rh[i + 1]] : [prev, rh[i + 1]];
    }
    for (const k in out) res.setHeader(k, out[k]);
    pres.pipe(res);
    pres.on('error', (err) => res.destroy(err));
  });

  if (consumed) {
    proxyReq.end(payload ?? undefined);
  } else {
    req.pipe(proxyReq);
  }
}
