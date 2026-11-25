# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic versioning.

## [Unreleased]

### Added

- HTTP/1.1 engine in Rust (N-API, tokio) with a lock-free queue, batched draining and lazy parsing of `req.headers`, `req.query`, `req.params`, `req.cookies` and `req.body`.
- HTTPS/TLS (rustls) with handshake timeouts.
- Buffered or streamed request bodies, and streamed responses/SSE.
- Works with existing Express apps (`http.createServer(app)`, NestJS, supertest) and third-party middleware (`cors`, `helmet`, `morgan`).
- `'upgrade'`/WebSocket support (Unix).
- Views (`res.render`, `app.engine`, `app.locals`/`res.locals`).
- Express 5 defaults (`async` handlers, simple `req.query`, etc.).
- Native `express.static()`, `express.json()`, `express.urlencoded()`, `express.text()` and `express.raw()` implemented in Rust.
- Prebuilt binaries per platform (`rxpress-<target>` as `optionalDependencies`): darwin arm64/x64, linux x64/arm64 (glibc and musl), win32 x64.
- CI (GitHub Actions) and a release workflow with npm provenance.
- `npm run bench:soak`: long-running mixed-traffic soak test that tracks RSS, heap and open descriptors.

### Changed

- `engines.node` is now `>=22` (Node 20 is end-of-life).
- `req.query` with the `extended` parser and `urlencoded` bodies now match qs as used by Express 5: ordinary objects, only `__proto__` segments are skipped (keys such as `constructor` are kept). The `simple` parser keeps every key on a prototype-free object, like `node:querystring`.
- JSON bodies are parsed with plain `JSON.parse`, like body-parser: a `__proto__` key is kept as an own property (it never reaches `Object.prototype`).
- The main package no longer ships `native/`; the binary comes from the platform package (a local `native/rxpress.node` still takes precedence during development).

### Fixed

- Windows: the listener no longer sets `SO_REUSEADDR`, which there allowed a second process to bind the same port; `EADDRINUSE` is reported as in Node.
- README no longer claims object pooling for `RxRequest`/`RxResponse` (a new pair is created per request).

### Security

- ReDoS in routes with several parameters in one segment (`/:a-:b-:c`): the route compiler now follows path-to-regexp 8.
- A `Transfer-Encoding` header set from JS is no longer sent together with `Content-Length` (fast path, 304 and `sendFile`); a wrong `Content-Length` is corrected.
- Bounded memory for pipelined static cache hits (flush every 256 KiB) and a new write timeout, `writeTimeoutMs` (30 s), against slow readers.
- A `Range` header with non-ASCII bytes no longer panics; tiny body chunks are coalesced.
- HTTP parser aligned with Node's llhttp: only methods from `http.METHODS`, valid request-target, strict chunk-size line.
- `res.redirect('back')` removed as in Express 5; `req.body` is `undefined` when no parser ran; asynchronous decompression with a size limit; duplicate request headers handled like Node.
- TLS options the engine does not support (`minVersion`, `ciphers`, ...) now fall back to the Node path instead of being silently ignored.
- Pending upgrade entries expire; abandoned request ids are not reused; `rustls-pemfile` replaced with `rustls-pki-types`; the bridge token is compared in constant time.
- Express 5 parity for the query/urlencoded parser (`%5D`, invalid escapes, `extended: false`) and for routes with `//` and `strict`.
