import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const staticDir = join(__dirname, 'public');

mkdirSync(staticDir, { recursive: true });
writeFileSync(
  join(staticDir, 'sample.json'),
  JSON.stringify({
    framework: 'rxpress',
    poweredBy: 'Rust',
    items: Array.from({ length: 20 }, (_, i) => i),
  })
);

function startServer(script, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'production',
        // The peak-throughput numbers in the README use 4 I/O threads (the default is 1).
        ...(script.includes('rxpress') ? { IO_THREADS: process.env.IO_THREADS || '4' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.stdout.on('data', (d) => {
      if (d.toString().includes(`READY:${port}`)) {
        resolve(child);
      }
    });
    child.on('exit', (code) => {
      reject(new Error(`Server ${script} exited early (${code}): ${stderr}`));
    });
  });
}

function runWrk(url, extraArgs = [], duration = '4s') {
  const args = ['-t4', '-c128', `-d${duration}`, '--latency', ...extraArgs, url];
  const out = execFileSync('wrk', args, { encoding: 'utf8' });
  const rpsMatch = /Requests\/sec:\s+([\d.]+)/.exec(out);
  const latMatch = /Latency\s+([\d.]+\w+)/.exec(out);
  return {
    rps: rpsMatch ? parseFloat(rpsMatch[1]) : 0,
    latency: latMatch ? latMatch[1] : 'N/A',
  };
}

const pipeScript = join(__dirname, 'pipeline.lua');
const postPipeScript = join(__dirname, 'post-pipeline.lua');
const postScript = join(__dirname, 'post.lua');

const scenarios = [
  { name: 'GET /ping (plain text)', path: '/ping', pipe: ['-s', pipeScript], plain: [] },
  { name: 'GET /json (JSON API)', path: '/json', pipe: ['-s', pipeScript], plain: [] },
  {
    name: 'GET /users/:id/posts/:postId?sort=desc',
    path: '/users/42/posts/99?sort=desc',
    pipe: ['-s', pipeScript],
    plain: [],
  },
  { name: 'POST /echo (express.json)', path: '/echo', pipe: ['-s', postPipeScript], plain: ['-s', postScript] },
  { name: 'GET /cors (cors middleware)', path: '/cors', pipe: ['-s', pipeScript], plain: [] },
  { name: 'GET /static/sample.json (express.static)', path: '/static/sample.json', pipe: ['-s', pipeScript], plain: [] },
];

async function main() {
  console.log('Starting Express 5 and rxpress servers (identical 45-route API)...\n');
  const expressProc = await startServer(join(__dirname, 'server-express.mjs'), 4100);
  const rxpressProc = await startServer(join(__dirname, 'server-rxpress.mjs'), 4101);

  try {
    // Warmup both servers
    runWrk('http://127.0.0.1:4100/json', ['-s', pipeScript], '1s');
    runWrk('http://127.0.0.1:4101/json', ['-s', pipeScript], '1s');

    console.log('=== 1. Peak Server Throughput (wrk -t4 -c128, HTTP/1.1 pipeline depth 10) ===\n');
    console.log(
      'Scenario'.padEnd(42) +
        'Express 5'.padStart(15) +
        'rxpress'.padStart(16) +
        'Speedup'.padStart(10)
    );
    console.log('-'.repeat(83));

    let pipeSum = 0;
    for (const s of scenarios) {
      const exp = runWrk(`http://127.0.0.1:4100${s.path}`, s.pipe, '4s');
      const rx = runWrk(`http://127.0.0.1:4101${s.path}`, s.pipe, '4s');
      const ratio = exp.rps > 0 ? rx.rps / exp.rps : 0;
      pipeSum += ratio;

      console.log(
        s.name.padEnd(42) +
          `${Math.round(exp.rps).toLocaleString()} r/s`.padStart(15) +
          `${Math.round(rx.rps).toLocaleString()} r/s`.padStart(16) +
          `${ratio.toFixed(2)}x`.padStart(10)
      );
    }
    console.log('-'.repeat(83));
    console.log(`Average Peak Throughput Speedup: ${(pipeSum / scenarios.length).toFixed(2)}x faster than Express 5\n`);

    console.log('=== 2. Standard Keep-Alive (wrk -t4 -c128, non-pipelined) ===\n');
    console.log(
      'Scenario'.padEnd(42) +
        'Express 5'.padStart(15) +
        'rxpress'.padStart(16) +
        'Speedup'.padStart(10)
    );
    console.log('-'.repeat(83));

    let plainSum = 0;
    for (const s of scenarios) {
      const exp = runWrk(`http://127.0.0.1:4100${s.path}`, s.plain, '3s');
      const rx = runWrk(`http://127.0.0.1:4101${s.path}`, s.plain, '3s');
      const ratio = exp.rps > 0 ? rx.rps / exp.rps : 0;
      plainSum += ratio;

      console.log(
        s.name.padEnd(42) +
          `${Math.round(exp.rps).toLocaleString()} r/s`.padStart(15) +
          `${Math.round(rx.rps).toLocaleString()} r/s`.padStart(16) +
          `${ratio.toFixed(2)}x`.padStart(10)
      );
    }
    console.log('-'.repeat(83));
    console.log(`Average Keep-Alive Speedup: ${(plainSum / scenarios.length).toFixed(2)}x faster than Express 5`);
  } finally {
    expressProc.kill('SIGTERM');
    rxpressProc.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
