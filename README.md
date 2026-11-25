# rxpress

HTTP/HTTPS server for Node.js with the networking engine written in Rust (N-API), compatible with **Express 5**: same API, `async` handlers, and third-party middleware such as `cors`, `helmet` and `morgan`.

## Installation

```bash
npm install @rxpress/rxpress
```

The native binary ships in per-platform packages (`@rxpress/rxpress-<target>`) installed automatically as `optionalDependencies`; npm only downloads the one for your machine. Do not use `--omit=optional`/`--no-optional`. Requires Node.js >= 22.

| Target | Package |
| --- | --- |
| macOS Apple Silicon | `@rxpress/rxpress-darwin-arm64` |
| macOS Intel | `@rxpress/rxpress-darwin-x64` |
| Linux x64 (glibc) | `@rxpress/rxpress-linux-x64-gnu` |
| Linux x64 (musl/Alpine) | `@rxpress/rxpress-linux-x64-musl` |
| Linux arm64 (glibc) | `@rxpress/rxpress-linux-arm64-gnu` |
| Linux arm64 (musl/Alpine) | `@rxpress/rxpress-linux-arm64-musl` |
| Windows x64 | `@rxpress/rxpress-win32-x64-msvc` |

If no binary loads, the error names the expected package. In a clone of the repository, `npm run build:native` produces `native/rxpress.node`, which takes precedence over the platform packages.

**Windows:** the `'upgrade'` event (WebSocket) is not supported yet, because handing the socket over to JS is Unix-only. Everything else behaves the same. Until that lands, the Windows test job in CI is informational (`continue-on-error`).

## Benchmarks (Apple M1 Pro, Node.js v24, same 45-route API)

> **These numbers are a reference, not a promise.** They measure the server itself on minimal handlers. In a real application, throughput and latency are dominated by everything around the server: your dependencies and middleware, business logic, database and cache access, calls to other services, payload sizes and the hardware you deploy on. Expect the gain to be much smaller once that work is included, and measure with your own application before drawing conclusions.

Measured on a single machine and not reproduced on other hardware; absolute numbers depend on the CPU. Command used (requires `wrk`):

```bash
npm run build && node bench/run.mjs
```

### 1. Peak throughput (`wrk -t4 -c128`, HTTP/1.1 pipeline depth 10)

| Scenario | Express 5 | **rxpress** | Speedup |
| --- | ---: | ---: | ---: |
| `GET /ping` (plain text) | 59,572 req/s | **1,098,512 req/s** | **18.44x** |
| `GET /json` (JSON API) | 60,637 req/s | **1,046,608 req/s** | **17.26x** |
| `GET /users/:id/posts/:postId?sort=desc` | 58,619 req/s | **658,886 req/s** | **11.24x** |
| `POST /echo` (`express.json()`) | 40,799 req/s | **838,995 req/s** | **20.56x** |
| `GET /cors` (real `cors` middleware) | 53,666 req/s | **709,549 req/s** | **13.22x** |
| `GET /static/sample.json` (`express.static`) | 17,668 req/s | **1,326,797 req/s** | **75.10x** |
| **Average** | — | — | **25.97x** |

### 2. Plain keep-alive (`wrk -t4 -c128`, no pipelining)

| Scenario | Express 5 | **rxpress** | Speedup |
| --- | ---: | ---: | ---: |
| `GET /ping` (plain text) | 31,621 req/s | **137,528 req/s** | **4.35x** |
| `GET /json` (JSON API) | 34,672 req/s | **147,831 req/s** | **4.26x** |
| `GET /users/:id/posts/:postId?sort=desc` | 29,612 req/s | **129,015 req/s** | **4.36x** |
| `POST /echo` (`express.json()`) | 27,782 req/s | **140,481 req/s** | **5.06x** |
| `GET /cors` (real `cors` middleware) | 34,154 req/s | **151,068 req/s** | **4.42x** |
| `GET /static/sample.json` (`express.static`) | 13,876 req/s | **123,779 req/s** | **8.92x** |
| **Average** | — | — | **5.23x** |

## Architecture

- **HTTP/1.1 + HTTPS engine in Rust** (`src/server/`, `src/http_parse/`, `src/tls.rs`): strict HTTP/1.1 parser, multi-threaded Tokio runtime, `TCP_NODELAY`, batched pipelining with write coalescing, and TLS through `tokio-rustls` (`ring`).
- **Radix-tree router in Rust** (`src/router.rs`): `matchit` resolves static routes, `:param` and `*splat` in O(path length), and falls back to the full Express-style router for `RegExp` routes, optional parameters, duplicate routes using `next('route')` and dynamic sub-routers.
- **Batched N-API bridge** (`src/protocol/`, `src/slots.rs`, `js/protocol.ts`):
  - Lock-free queue (`SegQueue`) plus a preallocated slot table (`SlotTable`), with no `oneshot::channel` or `HashMap` per request.
  - Requests are drained in batches into a reused `Buffer` (`drainBatchInto`).
  - **Lazy** parsing of `req.headers`, `req.query`, `req.params`, `req.cookies` and `req.body` in JS: routes that never touch headers or query pay nothing for them.
  - A fresh `RxRequest`/`RxResponse` pair per request (no object reuse, since user closures, timers and promises can keep references after the response), with automatic `_detach()` for `async` handlers and streaming/SSE.
- **Native middleware in Rust**:
  - `express.static()` with a lock-free `thread_local!` cache for small files, chunked streaming for large ones, `ETag` + `304`, `Last-Modified`, `Range` (`206 Partial Content`), and path traversal and `dotfiles` protection.
  - `express.json()`, `express.urlencoded()`, `express.text()` and `express.raw()` read and limit the body (`413 Payload Too Large`) in Rust.
- **Streaming and SSE**: `res.flushHeaders()`, `res.write()`, `res.end()`, `res.sendFile()`, `res.download()`, and client disconnect detection through `req.on('close', ...)`.

## Usage

```ts
import express from '@rxpress/rxpress';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

const app = express();

app.use(morgan('tiny'));
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/public', express.static('./public', { maxAge: '1h' }));

const api = express.Router();

api.get('/users/:id', async (req, res) => {
  res.json({
    id: req.params.id,
    query: req.query,
  });
});

// Server-Sent Events (SSE)
api.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const timer = setInterval(() => {
    res.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  }, 1000);

  req.on('close', () => clearInterval(timer));
});

app.use('/api', api);

// Error handler (also receives rejections from async handlers)
app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(3000, () => {
  console.log('listening on http://localhost:3000');
});
```

### HTTPS / TLS

```ts
import { readFileSync } from 'node:fs';
import express from '@rxpress/rxpress';

const app = express();
app.get('/', (req, res) => res.json({ secure: req.secure }));

// Option 1: direct method
app.listenTls(
  { key: readFileSync('./key.pem'), cert: readFileSync('./cert.pem') },
  443
);

// Option 2: same shape as Node's https.createServer
express
  .createHttpsServer({ key: './key.pem', cert: './cert.pem' }, app)
  .listen(443);
```

## Replacing Express without code changes (NestJS, Vendure, supertest...)

An rxpress `app` is a `(req, res, next)` function, like an Express app. When it is passed to `http.createServer(app)` or `https.createServer({ key, cert }, app)`, the returned server runs on the Rust engine (the same one used by `app.listen()`), so frameworks that create the server themselves keep rxpress's performance.

To make dependencies that `require('express')` use rxpress, add an npm alias to the application's `package.json`:

```json
{
  "dependencies": {
    "express": "npm:@rxpress/rxpress@^0.1.0"
  },
  "overrides": {
    "express": "npm:@rxpress/rxpress@^0.1.0"
  }
}
```

(`overrides` for npm, `resolutions` for Yarn, `pnpm.overrides` for pnpm: they make sure packages such as `@nestjs/platform-express` get rxpress as well.) `express.request`, `express.response` and `express.application` are the prototypes, as in Express, so extensions like `express.response.foo = function () {}` work.

Works unchanged:

- `http.createServer(app).listen(...)`, `server.address()`, `server.close()`, and the `'listening'`/`'close'`/`'error'` events (including `EADDRINUSE`), which is the flow used by NestJS's `ExpressAdapter`.
- `supertest(app)` and `supertest(server)`; `app.listen(0)`, `app.address()` and `app.close()`.
- npm middleware that reads the body as a stream: `body-parser`, `raw-body`, `req.pipe()`, `for await (const chunk of req)`, `on-finished`, `req.socket`/`res.socket`.
- Mounting an rxpress app inside a real Express app (`expressApp.use('/x', rxApp)`): `next()` and errors go back to Express as with a sub-app.
- Mounting an app or `Router()` created by another copy of Express (a package that bundles its own `express`) in rxpress: `app.use('/admin', expressApp)`. As with an Express sub-app, it receives `'mount'` and `mountpath`/`parent`, inherits the rxpress app's settings (for example `trust proxy`) and keeps its own (for example `json spaces`); `req.app` is the sub-app, and `next()` and errors go back to rxpress. It runs in the same process and the same request, with no network hop.
- Large streamed uploads: `multer`/`busboy`, `req.pipe(fs.createWriteStream(...))`, full-duplex `req.pipe(res)`, `for await`.

### Request body: buffered or streamed

- When a route uses rxpress's `express.json()`/`urlencoded()`/`text()`/`raw()` and the request matches the type, the engine reads and limits the body in Rust before calling JS (fast path).
- Other bodies larger than 64 KiB, or sent with `Transfer-Encoding: chunked`, arrive as a stream, as in Node: the handler runs right after the headers and the body is read in chunks. While `req` is paused the engine stops reading the socket (TCP backpressure), so a multi-GB upload uses at most ~256 KiB of memory per request.
- A client that aborts the upload triggers `'aborted'` (and `'error'` if there is a listener; `for await` throws `aborted`). `requestTimeoutMs` also bounds receiving the body, even while a streamed response is in progress.
- If the response finishes without reading the whole body, the connection is closed afterwards instead of being reused.
- Without `defaultBodyLimitBytes`, a body that no parser reads is unbounded, as in Node; parsers apply their own `limit` (413 `entity.too.large`). With an explicit `app.set('defaultBodyLimitBytes', n)`, larger bodies get a 413 before reaching JS.

When the `app` receives Node's own `req`/`res` (mounted in a real Express app, an `http.Server` created before rxpress was imported, serverless adapters), the request goes through a local bridge to the Rust engine: behaviour is identical, at the cost of a loopback hop (measured: ~18k req/s versus ~150k on the native server). To force that path for one app, call `app.set('native server', false)` before `createServer`, or set `RXPRESS_NODE_HTTP=1` for all of them. `app.listen()` and `http.createServer(app).listen()` use the same engine with the same performance.

### WebSockets and `'upgrade'`

`server.on('upgrade', (req, socket, head) => ...)` works on the native server (the handle returned by `app.listen()` or the server from `http/https.createServer(app)`), so `ws` (`new WebSocketServer({ server })`), `express-ws` and similar packages work unchanged. With an `'upgrade'` listener, a request with `Connection: upgrade` + `Upgrade` leaves the engine: the TCP socket is handed to Node as a real `net.Socket` (no overhead from then on); over HTTPS the engine relays the decrypted traffic. Without listeners, the request is handled as a normal request (as in Node 24). Unix only (Linux/macOS): on Windows, an upgrade request is answered with `426 Upgrade Required` even when there is an `'upgrade'` listener.

### Views

`app.engine()`, `app.set('views' | 'view engine' | 'view cache')`, `app.render()` and `res.render()` work as in Express (including `require('<ext>').__express`, `index.<ext>` in directories and `app.locals`/`res.locals`).

### Express test suite

`npm run test:express` runs Express 5.3.0's own test suite against rxpress (also in CI): 1260 of its 1261 tests pass. The one exception is listed in `test/express-suite/known-failures.json` and below.

`app.request` and `app.response` are per app, as in Express: extending one affects only that app and the apps mounted under it. Express switches the prototype of `req`/`res` as a request enters each app, which slows V8 down, so rxpress only does it once an app has touched `app.request` or `app.response`; apps that extend `express.request`/`express.response` (shared by all apps) or nothing at all pay no cost.

### Known limitations of the native server

- Extra `'request'`/`'connection'` listeners on the server are not called (for example socket.io's polling transport; the `websocket` transport works).
- `listen()` on a UNIX socket is not supported.
- `req.socket.remotePort` is `undefined`.
- `req`/`res` are not `instanceof http.IncomingMessage`/`ServerResponse`.
- When a client closes its side of the connection (FIN) while a handler is still running, the engine gives the handler 100 ms to answer before treating the request as aborted; Node aborts at once. A `res.sendFile(path, cb)` that finishes in that window calls `cb()` without the `ECONNABORTED` error Express would pass (this is the Express test that fails). The callback is also called once the file is handed to the engine, not when the last byte is written.

## Scripts

```bash
npm run build        # Build the Rust addon (--release with LTO) and the TypeScript layer (ESM, CJS and .d.ts)
npm run build:native # Build only the Rust addon -> native/rxpress.node
npm run build:ts     # Build only the TypeScript layer -> dist/
npm test             # Unit and compatibility tests
npm run test:e2e     # End-to-end tests against rxpress and Express 5
npm run test:express # Express 5.3.0's own test suite against rxpress
npm run bench        # Benchmark against Express 5 with wrk
```

## License

MIT
