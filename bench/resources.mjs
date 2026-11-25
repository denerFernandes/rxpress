// Memory and CPU of Express 5 vs rxpress under the same wrk load.
//
//   npm run build && node bench/resources.mjs
//
// Both servers run the same app (bench/server-*.mjs) in their own process. The numbers come from
// the whole process (`ps`): RSS and CPU time, including the Rust threads of rxpress. "CPU per
// request" is the CPU time the process used divided by the requests it served, so it does not
// depend on how many requests per second each server manages to handle.
//
//   DUR=8        seconds of load per scenario
//   RUNS=1       repeat the whole comparison n times (Express and rxpress alternate) and report
//                the median; use 5 or more, a single run is noisy on a busy machine
//   IO_THREADS=n run rxpress with `ioThreads: n` (default: the engine's default)
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DURATION = Number(process.env.DUR || 8);
const RUNS = Math.max(1, Number(process.env.RUNS || 1));

const scenarios = [
  { name: 'GET /ping', url: '/ping', c: 64 },
  { name: 'GET /json', url: '/json', c: 64 },
  { name: 'GET /users/:id/posts/:postId?sort=desc', url: '/users/1/posts/2?sort=desc', c: 64 },
  { name: 'POST /echo (express.json())', url: '/echo', c: 64, lua: join(here, 'post.lua') },
  { name: 'GET /cors (cors middleware)', url: '/cors', c: 64 },
  { name: 'GET /static/sample.json', url: '/static/sample.json', c: 64 },
  { name: 'GET /json, 512 connections', url: '/json', c: 512 },
];

/** RSS (MB) and accumulated CPU time (s) of a process. */
function usage(pid) {
  if (process.platform === 'linux') {
    // /proc has 10 ms resolution; `ps` only reports whole seconds on Linux.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[11]) + Number(fields[12]); // utime + stime
    const clock = Number(execFileSync('getconf', ['CLK_TCK']).toString());
    const pages = Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]);
    return { rssMb: (pages * 4096) / 1048576, cpu: ticks / clock };
  }
  const [rss, cpu] = execFileSync('ps', ['-o', 'rss=,cputime=', '-p', String(pid)])
    .toString()
    .trim()
    .split(/\s+/);
  const t = cpu.split(':').map(Number);
  const seconds = t.length === 3 ? t[0] * 3600 + t[1] * 60 + t[2] : t[0] * 60 + t[1];
  return { rssMb: Number(rss) / 1024, cpu: seconds };
}

function wrk(args) {
  return new Promise((resolve, reject) => {
    let out = '';
    const w = spawn('wrk', args);
    w.on('error', () => reject(new Error('wrk is required: https://github.com/wg/wrk')));
    w.stdout.on('data', (d) => (out += d));
    w.on('close', () => resolve(out));
  });
}

async function measure(script, port, env = {}) {
  const child = spawn(process.execPath, [join(here, script)], {
    env: { ...process.env, ...env, PORT: String(port), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) =>
    child.stdout.on('data', (d) => String(d).includes('READY') && resolve())
  );
  await sleep(1500);
  const idle = usage(child.pid);
  let peak = idle.rssMb;
  const rows = [];

  for (const s of scenarios) {
    const before = usage(child.pid);
    let running = true;
    const sampler = (async () => {
      while (running) {
        peak = Math.max(peak, usage(child.pid).rssMb);
        await sleep(200);
      }
    })();
    const out = await wrk([
      '-t4',
      `-c${s.c}`,
      `-d${DURATION}s`,
      ...(s.lua ? ['-s', s.lua] : []),
      `http://127.0.0.1:${port}${s.url}`,
    ]);
    running = false;
    await sampler;
    const after = usage(child.pid);
    const requests = Number(/(\d+) requests in/.exec(out)?.[1] ?? 0);
    rows.push({
      name: s.name,
      rps: Number(/Requests\/sec:\s+([\d.]+)/.exec(out)?.[1] ?? 0),
      failed: Number(/Non-2xx or 3xx responses: (\d+)/.exec(out)?.[1] ?? 0),
      cpuUsPerRequest: ((after.cpu - before.cpu) / requests) * 1e6,
    });
    await sleep(1000);
  }

  await sleep(3000);
  const settled = usage(child.pid);
  child.kill('SIGTERM');
  await sleep(500);
  return { idleMb: idle.rssMb, peakMb: peak, settledMb: settled.rssMb, rows };
}

const rxEnv = process.env.IO_THREADS ? { IO_THREADS: process.env.IO_THREADS } : {};
const runs = { express: [], rxpress: [] };
for (let i = 0; i < RUNS; i++) {
  if (RUNS > 1) console.error(`run ${i + 1}/${RUNS}`);
  runs.express.push(await measure('server-express.mjs', 4310));
  runs.rxpress.push(await measure('server-rxpress.mjs', 4311, rxEnv));
}

const median = (values) => {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};
const pick = (list, fn) => median(list.map(fn));

const less = (a, b) => `${Math.round((1 - b / a) * 100)}% less`;
const mb = (n) => n.toFixed(0).padStart(4);
console.log(`\nMedian of ${RUNS} run(s), ${DURATION} s of load per scenario`);
console.log('\nMemory (RSS, MB)      Express 5   rxpress');
for (const [label, key] of [
  ['idle', 'idleMb'],
  ['peak under load', 'peakMb'],
]) {
  const a = pick(runs.express, (r) => r[key]);
  const b = pick(runs.rxpress, (r) => r[key]);
  console.log(`${label.padEnd(20)} ${mb(a).padStart(9)} ${mb(b).padStart(9)}   ${less(a, b)}`);
}
console.log('\nScenario                                    req/s Express -> rxpress   CPU us/request Express -> rxpress');
for (let i = 0; i < scenarios.length; i++) {
  const rps = (side) => pick(runs[side], (r) => r.rows[i].rps);
  const cpu = (side) => pick(runs[side], (r) => r.rows[i].cpuUsPerRequest);
  const failed = runs.express.some((r) => r.rows[i].failed) || runs.rxpress.some((r) => r.rows[i].failed);
  console.log(
    `${scenarios[i].name.padEnd(42)} ${rps('express').toFixed(0).padStart(8)} -> ${rps('rxpress').toFixed(0).padStart(8)}   ` +
      `${cpu('express').toFixed(1).padStart(6)} -> ${cpu('rxpress').toFixed(1).padStart(5)}  ` +
      `(${less(cpu('express'), cpu('rxpress'))})${failed ? '  failed responses!' : ''}`
  );
}
