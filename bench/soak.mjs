// Long-running soak test: mixed traffic against one rxpress process while its RSS, heap and open
// descriptors are sampled. Fails if memory or descriptors keep growing after warm-up.
//
//   npm run build && node bench/soak.mjs
//
// Environment:
//   SOAK_MINUTES      total duration (default 1440 = 24 h)
//   SOAK_CONCURRENCY  parallel client loops (default 32)
//   SOAK_RATE         target requests per second across all loops (default 2000); the point is
//                     a steady load for a long time, not peak throughput
//   SOAK_SAMPLE_SEC   sampling interval in seconds (default 30)
//   SOAK_WARMUP_SEC   time excluded from the verdict while caches and the allocator settle
//                     (default 300, or a tenth of the run if that is longer)
//   SOAK_MAX_GROWTH   allowed RSS growth between the start and the end of the run, after
//                     warm-up (default 0.15 = 15%)
//   SOAK_CSV          where to write the samples (default bench/soak-results.csv)
import { fork, execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const minutes = Number(process.env.SOAK_MINUTES || 1440);
const concurrency = Number(process.env.SOAK_CONCURRENCY || 32);
const rate = Number(process.env.SOAK_RATE || 2000);
const sampleSec = Number(process.env.SOAK_SAMPLE_SEC || 30);
const maxGrowth = Number(process.env.SOAK_MAX_GROWTH || 0.15);
const warmupSec = Math.max(Number(process.env.SOAK_WARMUP_SEC || 300), (minutes * 60) / 10);
const csvPath = process.env.SOAK_CSV || join(__dirname, 'soak-results.csv');
const PORT = 4301;
const TLS_PORT = 4302;

// ---- TLS certificate (optional: skipped when openssl is not available) ----
let tmp;
const env = { ...process.env, PORT: String(PORT) };
try {
  tmp = mkdtempSync(join(tmpdir(), 'rxpress-soak-'));
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
      '-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem')],
    { stdio: 'ignore' }
  );
  Object.assign(env, {
    TLS_PORT: String(TLS_PORT),
    TLS_KEY: join(tmp, 'key.pem'),
    TLS_CERT: join(tmp, 'cert.pem'),
  });
} catch {
  console.log('openssl not found: running without the TLS scenario');
}
const withTls = Boolean(env.TLS_PORT);

// ---- Server ----
const server = fork(join(__dirname, 'soak-server.mjs'), [], {
  env,
  execArgv: ['--expose-gc'],
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
const ready = new Set();
await new Promise((resolve, reject) => {
  server.on('message', (m) => {
    if (m?.ready) ready.add(m.ready);
    if (ready.has('http') && (!withTls || ready.has('https'))) resolve();
  });
  server.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
});

// ---- Client helpers ----
const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
const tlsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, rejectUnauthorized: false });
const statsAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });

function request(path, { method = 'GET', body, headers, tls = false, abortAfterMs, ownAgent } = {}) {
  return new Promise((resolve) => {
    const mod = tls ? https : http;
    const req = mod.request(
      {
        host: '127.0.0.1',
        port: tls ? TLS_PORT : PORT,
        path,
        method,
        headers,
        agent: ownAgent ?? (tls ? tlsAgent : agent),
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode));
        res.on('error', () => resolve(-1));
        if (abortAfterMs) setTimeout(() => req.destroy(), abortAfterMs);
      }
    );
    req.on('error', () => resolve(-1));
    req.on('close', () => resolve(-1));
    if (typeof body === 'function') body(req);
    else req.end(body);
  });
}

function pipelined(count) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1');
    let seen = 0;
    sock.on('data', (d) => {
      seen += d.toString('latin1').split('HTTP/1.1 ').length - 1;
      if (seen >= count) sock.end();
    });
    sock.on('error', () => resolve());
    sock.on('close', () => resolve());
    sock.write('GET /json?p=1 HTTP/1.1\r\nHost: x\r\n\r\n'.repeat(count));
    setTimeout(() => sock.destroy(), 5000);
  });
}

const CHUNK = Buffer.alloc(16 * 1024, 0x61);

// Scenarios whose connection is cut on purpose return 'aborted', which is not counted as an error.
const aborted = (p) => p.then(() => 'aborted');

const scenarios = [
  [30, () => request('/json?a=1&b[c]=2')],
  [10, () => request('/json', { method: 'POST', body: JSON.stringify({ a: 1, b: [1, 2, 3] }), headers: { 'content-type': 'application/json' } })],
  [10, () => request('/async')],
  [15, () => request('/static/sample.json')],
  [5, () => request('/missing')],
  [5, () => request('/error')],
  [5, () => pipelined(8)],
  // 1 MiB chunked upload, read as a stream on the server.
  [5, () => request('/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: (req) => {
      let i = 0;
      const write = () => {
        while (i < 64) {
          i++;
          if (!req.write(CHUNK)) return req.once('drain', write);
        }
        req.end();
      };
      write();
    },
  })],
  // Client gives up halfway through an upload.
  [3, () => aborted(request('/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(CHUNK.length * 8) },
    body: (req) => {
      req.write(CHUNK);
      setTimeout(() => req.destroy(), 20);
    },
  }))],
  // SSE client that disconnects mid-stream.
  [4, () => aborted(request('/sse', { abortAfterMs: 50 }))],
  ...(withTls ? [[8, () => request('/json', { tls: true })]] : []),
];
const totalWeight = scenarios.reduce((s, [w]) => s + w, 0);
function pick() {
  let r = Math.random() * totalWeight;
  for (const [w, fn] of scenarios) {
    if ((r -= w) < 0) return fn;
  }
  return scenarios[0][1];
}

// ---- Run ----
const endAt = Date.now() + minutes * 60_000;
let requests = 0;
let failures = 0;
let running = true;

const perLoopMs = (1000 * concurrency) / rate;

async function loop() {
  let next = Date.now();
  while (running && Date.now() < endAt) {
    const status = await pick()();
    requests++;
    if (status === -1) failures++;
    next += perLoopMs;
    const wait = next - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    else next = Date.now();
  }
}

async function stats() {
  await request('/__gc', { method: 'POST', ownAgent: statsAgent });
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: '/__stats', agent: statsAgent }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
}

const samples = [];
const csv = ['elapsed_s,requests,client_errors,rss_mb,heap_mb,external_mb,fds'];
const started = Date.now();
const mb = (n) => (n / 1048576).toFixed(1);

async function sample() {
  const s = await stats();
  const elapsed = Math.round((Date.now() - started) / 1000);
  samples.push({ elapsed, ...s });
  csv.push([elapsed, requests, failures, mb(s.rss), mb(s.heapUsed), mb(s.external), s.fds].join(','));
  writeFileSync(csvPath, csv.join('\n') + '\n');
  console.log(
    `[${new Date().toISOString()}] t=${elapsed}s req=${requests} client-errors=${failures} ` +
      `rss=${mb(s.rss)}MB heap=${mb(s.heapUsed)}MB fds=${s.fds}`
  );
}

console.log(`soak: ${minutes} min, ${concurrency} loops, ~${rate} req/s, TLS ${withTls ? 'on' : 'off'}, samples -> ${csvPath}`);
const sampler = setInterval(() => sample().catch((e) => console.error('sample failed:', e.message)), sampleSec * 1000);
await Promise.all(Array.from({ length: concurrency }, loop));
running = false;
clearInterval(sampler);
await new Promise((r) => setTimeout(r, 2000)); // let aborted connections settle
await sample();

server.kill();
agent.destroy();
tlsAgent.destroy();
statsAgent.destroy();
if (tmp) rmSync(tmp, { recursive: true, force: true });

// ---- Verdict: after warm-up, compare the first and the last tenth of the remaining samples. ----
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const steady = samples.filter((s) => s.elapsed >= warmupSec);
const tenth = Math.max(1, Math.floor(steady.length / 10));
const early = steady.slice(0, tenth);
const late = steady.slice(-tenth);
if (steady.length < 4) {
  console.log(`Not enough samples after the ${warmupSec}s warm-up for a verdict; run longer.`);
  process.exit(0);
}
const rssGrowth = median(late.map((s) => s.rss)) / median(early.map((s) => s.rss)) - 1;
const fdGrowth = median(late.map((s) => s.fds)) - median(early.map((s) => s.fds));
console.log(
  `RSS growth after warm-up: ${(rssGrowth * 100).toFixed(1)}% (limit ${(maxGrowth * 100).toFixed(0)}%), ` +
    `descriptor growth: ${fdGrowth}`
);
const ok = rssGrowth <= maxGrowth && fdGrowth <= 16;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
