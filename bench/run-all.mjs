import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(__dirname, 'public'), { recursive: true });
writeFileSync(
  join(__dirname, 'public', 'sample.json'),
  JSON.stringify({ framework: 'rxpress', poweredBy: 'Rust', items: Array.from({ length: 20 }, (_, i) => i) })
);

const servers = [
  { name: 'Express 5', script: 'server-express.mjs', port: 4100 },
  { name: 'Fastify', script: 'server-fastify.mjs', port: 4102 },
  { name: 'rxpress', script: 'server-rxpress.mjs', port: 4101 },
];

function start(s) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, s.script)], {
      env: {
        ...process.env,
        PORT: String(s.port),
        NODE_ENV: 'production',
        // The peak-throughput numbers in the README use 4 I/O threads (the default is 1).
        ...(s.script.includes('rxpress') ? { IO_THREADS: process.env.IO_THREADS || '4' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => d.toString().includes(`READY:${s.port}`) && resolve(child));
    child.on('exit', (c) => reject(new Error(`${s.script} exited (${c}): ${err}`)));
  });
}

function wrk(url, args, dur) {
  const out = execFileSync('wrk', ['-t4', '-c128', `-d${dur}`, ...args, url], { encoding: 'utf8' });
  return parseFloat(/Requests\/sec:\s+([\d.]+)/.exec(out)?.[1] ?? '0');
}

const pipe = ['-s', join(__dirname, 'pipeline.lua')];
const postPipe = ['-s', join(__dirname, 'post-pipeline.lua')];
const post = ['-s', join(__dirname, 'post.lua')];
const scenarios = [
  ['GET /ping', '/ping', pipe, []],
  ['GET /json', '/json', pipe, []],
  ['GET /users/:id/posts/:postId', '/users/42/posts/99?sort=desc', pipe, []],
  ['POST /echo (JSON body)', '/echo', postPipe, post],
  ['GET /cors', '/cors', pipe, []],
  ['GET /static/sample.json', '/static/sample.json', pipe, []],
];

const fmt = (n) => `${Math.round(n).toLocaleString('en-US')}`.padStart(11);

const procs = [];
try {
  for (const s of servers) procs.push(await start(s));
  for (const s of servers) wrk(`http://127.0.0.1:${s.port}/json`, pipe, '1s');

  for (const [title, mode, dur] of [
    ['Pipelined (depth 10)', 'pipe', '3s'],
    ['Keep-alive (no pipelining)', 'plain', '3s'],
  ]) {
    console.log(`\n=== ${title} — req/s (wrk -t4 -c128) ===`);
    console.log('Scenario'.padEnd(32) + servers.map((s) => s.name.padStart(11)).join('') + '  rx/Express  rx/Fastify');
    for (const [name, path, p, pl] of scenarios) {
      const args = mode === 'pipe' ? p : pl;
      const r = servers.map((s) => wrk(`http://127.0.0.1:${s.port}${path}`, args, dur));
      console.log(
        name.padEnd(32) + r.map(fmt).join('') +
        `  ${(r[2] / r[0]).toFixed(2)}x`.padStart(12) + `  ${(r[2] / r[1]).toFixed(2)}x`.padStart(11)
      );
    }
  }
} finally {
  procs.forEach((p) => p.kill('SIGTERM'));
}
