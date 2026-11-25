# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic versioning.

## [Unreleased]

## [0.1.0] - 2026-11-25

First release, published on npm as `@rxpress/rxpress` (the unscoped `rxpress` name belongs to another package); the binaries are `@rxpress/rxpress-<target>`.

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
- `npm run test:express`: runs Express's own test suite against rxpress (also in CI): 1260 of 1261 tests pass; the remaining one (a `sendFile` client-abort timing case) is listed in `test/express-suite/known-failures.json` and explained in the README.
- Every method in `http.METHODS` on `app`, `Router` and `Route` (`app.acl()`, `router.propfind()`, `route['m-search']()`...), as in Express.
- `npm run bench:soak`: long-running mixed-traffic soak test that tracks RSS, heap and open descriptors.
- `express.Router()` returns a callable router (`router(req, res, next)`), as in Express; `router.handle()` works with plain request objects (FQDN URLs, blank or missing URL, lowercase methods).

### Changed

- `engines.node` is now `>=22` (Node 20 is end-of-life).
- `req.query` with the `extended` parser and `urlencoded` bodies now match qs as used by Express 5: ordinary objects, only `__proto__` segments are skipped (keys such as `constructor` are kept). The `simple` parser keeps every key on a prototype-free object, like `node:querystring`.
- `res.send`/`res.json`/`res.jsonp`/`res.sendStatus` follow Express exactly: an ETag for any status and method, 304 when the request is fresh against an ETag or `Last-Modified` set by the app, Content-Type/Content-Length stripped on 204 and 304, an empty body with `Content-Length: 0` on 205, custom `etag` functions. `res.end()` no longer adds an ETag.
- `res.set('Content-Type', ...)` adds the default charset like Express (`mime-types`), and `res.send(string)`/`res.json()` set `charset=utf-8` on an existing Content-Type.
- `app.use()`, `router.use()`, `route.VERB()` and `router.param()` reject missing or non-function handlers with the same errors as Express.
- JSON bodies are parsed with plain `JSON.parse`, like body-parser: a `__proto__` key is kept as an own property (it never reaches `Object.prototype`).
- A 304 produced by `res.send` is visible as `res.statusCode` (loggers, `'finish'` listeners), as in Express.
- The router follows router@2: a middleware may rewrite `req.url` for the layers after it, it yields to the event loop every 100 synchronous `next()` calls (no stack overflow with thousands of layers), `router.param()` runs once per value and keeps the value or error it left, regexp paths name their captures like Express, and `mergeParams` shifts numeric captures after the parent's.
- A handler that throws `null`/`undefined` continues to the next layer, and a promise rejected with no value becomes `Error('Rejected promise')`, as in Express.
- Body parsers: a whitespace-only JSON body is a 400, a body whose size does not match `Content-Length` is a 400, a custom `type` function is not called for requests without a body, `verify` must be a function, `parameterLimit: Infinity` is accepted, `charset=utf-16` honours the byte-order mark, and a `verify` error carries the raw body.
- Content-Type lookup by extension (static files, `res.sendFile`, `res.download`, `res.type`, `res.format`, `res.attachment`) uses the mime-db table that Express uses (e.g. `.js` is `text/javascript`), generated into the engine by `scripts/gen-mime-table.mjs`; the `mime_guess` crate is gone. `res.type()` with an unknown extension gives `application/octet-stream`, as in Express.
- `res.format()` follows Express 5: handlers receive `(req, res, next)`, no match calls `next()` with a 406 error that lists the supported `types`, and the Content-Type drops the key's parameters.
- `Content-Disposition` follows `content-disposition` 2: `filename` is unquoted when it is a token; a `Content-Disposition` in `res.download()`'s `headers` option is ignored; `res.attachment('')` sends `filename=""`.
- `res.sendFile()` with `root` normalizes the path first (`a/../b` is allowed when it stays inside the root), and a non-string path throws `path must be a string to res.sendFile`.
- `res.get()` returns arrays as set (it is `res.getHeader()` in Express); `res.vary()` follows the `vary` package (arrays, `*`, invalid names throw).
- `app.set()` follows Express: `etag` and `query parser` reject unknown values and keep `etag fn`/`query parser fn` in sync, `app.set(name)` reads inherited settings, and a mounted app inherits `trust proxy`, settings and engines from its parent (through the prototype chain, as in Express).
- `express.json()`, `express.urlencoded()`, `express.text()`, `express.raw()` and `express.static()` report the same `.length` as Express; `cookie-parser` mounted after rxpress has parsed cookies still runs (it sees no `req.cookies` yet).
- `res.cookie()` treats `maxAge: null` as unset; the `json escape` setting escapes `<`, `>` and `&` in `res.json()`/`res.jsonp()`.
- A `Transfer-Encoding` set from JS is honoured like Node: a last coding of `chunked` is sent chunked, any other coding is sent close-delimited with `Connection: close`; never with `Content-Length`.
- `req.get()` throws on a missing or non-string name; `req.subdomains` returns the whole IP with `subdomain offset` 0; `req.protocol` reads `req.socket.encrypted`; `req.fresh` ignores `If-Modified-Since` when `If-None-Match` is present (fresh 2).
- `express.static()` follows serve-static and send: `..` segments that stay inside the root are allowed, `If-Match`/`If-Unmodified-Since` give 412, `acceptRanges`/`cacheControl: false`, `extensions` as a string, `maxAge` capped at one year, an encoded redirect `Location`, and errors passed to `next()` as `BadRequestError`/`ForbiddenError`/`NotFoundError` (or the underlying `ENOENT`/`ENAMETOOLONG`) when `fallthrough` is false. The engine still serves hits itself and hands misses, refusals and precondition requests to the JS handler.
- `res.links()` accepts an array of URLs per rel; an OPTIONS request is answered by the router that matched it, and an error while answering (e.g. headers already sent) goes to the app's error handlers, as in router@2.
- `res.setHeader()` throws `ERR_HTTP_HEADERS_SENT` after `res.writeHead()`, as in Node.
- `app.listen()` passes a server error (`EADDRINUSE`...) to its callback, as in Express 5; without a callback it is still thrown.
- `res.sendFile()` supports `send`'s `start`/`end` options and reports `ECONNABORTED` when the client already went away.
- Node's own `OutgoingMessage.prototype.setHeader/getHeader/removeHeader` work on rxpress responses (the `cookies` package calls them, so `cookie-session` now sets its cookie).
- `app.request`/`app.response` are per app and inherit from the parent app's, as in Express (extending one no longer changes every app). The prototype switch only happens once an app has touched them.
- The main package no longer ships `native/`; the binary comes from the platform package (a local `native/rxpress.node` still takes precedence during development).

### Fixed

- An error from app-level middleware now reaches the error handlers registered between it and the matched route (it skipped them on compiled routes).
- Windows: the listener no longer sets `SO_REUSEADDR`, which there allowed a second process to bind the same port; `EADDRINUSE` is reported as in Node.
- README no longer claims object pooling for `RxRequest`/`RxResponse` (a new pair is created per request).

### Security

- ReDoS in routes with several parameters in one segment (`/:a-:b-:c`): the route compiler now follows path-to-regexp 8.
- A `Transfer-Encoding` header set from JS is never sent together with `Content-Length` (the body is framed by the engine), and none is sent on 304; a wrong `Content-Length` is corrected.
- Bounded memory for pipelined static cache hits (flush every 256 KiB) and a new write timeout, `writeTimeoutMs` (30 s), against slow readers.
- A `Range` header with non-ASCII bytes no longer panics; tiny body chunks are coalesced.
- HTTP parser aligned with Node's llhttp: only methods from `http.METHODS`, valid request-target, strict chunk-size line.
- `res.redirect('back')` removed as in Express 5; `req.body` is `undefined` when no parser ran; asynchronous decompression with a size limit; duplicate request headers handled like Node.
- TLS options the engine does not support (`minVersion`, `ciphers`, ...) now fall back to the Node path instead of being silently ignored.
- Pending upgrade entries expire; abandoned request ids are not reused; `rustls-pemfile` replaced with `rustls-pki-types`; the bridge token is compared in constant time.
- Express 5 parity for the query/urlencoded parser (`%5D`, invalid escapes, `extended: false`) and for routes with `//` and `strict`.
