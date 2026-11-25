// Server side of the soak test (see soak.mjs). Serves every kind of traffic the driver sends and
// exposes its own memory and descriptor counts on /__stats.
import express from '../dist/index.mjs';
import { readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4301);
const tlsPort = Number(process.env.TLS_PORT || 0);

const app = express();
app.disable('x-powered-by');

app.use('/static', express.static(join(__dirname, 'public')));

app.get('/json', (req, res) => {
  res.json({ ok: true, q: req.query, ua: req.get('user-agent') ?? null });
});

app.post('/json', express.json({ limit: '1mb' }), (req, res) => {
  res.json({ keys: Object.keys(req.body ?? {}).length });
});

app.get('/async', async (_req, res) => {
  await new Promise((r) => setTimeout(r, 2));
  res.send('done');
});

// Streamed upload: hash the body without buffering it.
app.post('/upload', (req, res) => {
  const hash = createHash('sha1');
  let bytes = 0;
  req.on('data', (c) => {
    bytes += c.length;
    hash.update(c);
  });
  req.on('end', () => res.json({ bytes, sha1: hash.digest('hex') }));
  req.on('error', () => {});
});

// SSE: the driver disconnects mid-stream.
app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  let n = 0;
  const timer = setInterval(() => res.write(`data: ${n++}\n\n`), 5);
  req.on('close', () => clearInterval(timer));
});

app.get('/error', () => {
  throw new Error('boom');
});

function fdCount() {
  for (const dir of ['/proc/self/fd', '/dev/fd']) {
    try {
      return readdirSync(dir).length;
    } catch {
      // try the next one
    }
  }
  return -1;
}

app.get('/__stats', (_req, res) => {
  const m = process.memoryUsage();
  res.json({ rss: m.rss, heapUsed: m.heapUsed, external: m.external, fds: fdCount() });
});

app.post('/__gc', (_req, res) => {
  if (typeof globalThis.gc === 'function') globalThis.gc();
  res.json({ gc: typeof globalThis.gc === 'function' });
});

app.listen(port, () => {
  process.send?.({ ready: 'http', port });
});

if (tlsPort && process.env.TLS_KEY && process.env.TLS_CERT) {
  express
    .createHttpsServer({ key: process.env.TLS_KEY, cert: process.env.TLS_CERT }, app)
    .listen(tlsPort, () => process.send?.({ ready: 'https', port: tlsPort }));
}
