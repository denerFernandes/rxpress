// Differential HTTP/1.1 framing vs Node's llhttp.
//
// Every case is sent as raw bytes over TCP to a plain `node:http` server and to an rxpress
// server. Both record the requests whose body they fully received. Invariants:
//   1. rxpress never sees MORE requests on a connection than Node does;
//   2. every request rxpress sees is identical (method, url, body) to the request Node saw at
//      the same position, i.e. rxpress never draws a body boundary Node interprets differently;
//   3. unless whitelisted below, both reach the same verdict (accepted 2xx / rejected 4xx-close).
import fc from 'fast-check';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exchange,
  startNodeTarget,
  startRxpressTarget,
  verdict,
  type DiffTarget,
  type ExchangeResult,
} from './helpers/differential.js';
import { isExpressBaseline } from './helpers/server.js';

const describeRx = isExpressBaseline() ? describe.skip : describe;

let nodeT: DiffTarget;
let rxT: DiffTarget;

beforeAll(async () => {
  if (isExpressBaseline()) return;
  nodeT = await startNodeTarget();
  rxT = await startRxpressTarget();
});

afterAll(async () => {
  await Promise.allSettled([nodeT?.close(), rxT?.close()]);
});

const H = 'Host: t\r\n';
const POST = 'POST /p HTTP/1.1\r\n' + H;
const NEXT = 'GET /smuggled HTTP/1.1\r\n' + H + '\r\n';

/**
 * Cases where rxpress is intentionally stricter than llhttp (rejects what Node accepts).
 * Being stricter is allowed only when rxpress sees no request at all (checked below).
 */
const STRICTER_WHITELIST: Record<string, string> = {
  'http10-te-chunked': 'RFC 9112 6.1: Transfer-Encoding in HTTP/1.0 is a smuggling vector; 400',
  'te-identity-chunked': 'only a bare "chunked" transfer-coding is accepted',
  'te-gzip-chunked': 'transfer-codings other than chunked are not decoded; 400',
  'double-host': 'RFC 9112 3.2: more than one Host field is a 400',
  http09: 'HTTP/0.9 request lines are not supported',
  'http2-version': 'only HTTP/1.0 and HTTP/1.1 request lines are accepted',
  'double-space-request-line': 'request line must be method SP target SP version exactly',
};

/**
 * Both sides saw exactly the same requests, but Node's parser error (data after
 * `Connection: close` / a bad second message) writes its 400 before the deferred 200 of
 * request #1, so the first status differs. Compared on `seen` instead of the first status.
 */
const VERDICT_RACE: Record<string, string> = {
  'pipelined-close-then-get': 'node 400s the bytes after Connection: close before answering #1',
  'pipelined-bad-second': 'node 400s message #2 before answering #1',
  'pipelined-body-misframed-as-method': 'node 400s the unknown method of #2 before answering #1',
};

interface Case {
  name: string;
  raw: string;
}

const CORPUS: Case[] = [
  // Baselines.
  { name: 'get', raw: 'GET / HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'post-cl', raw: POST + 'Content-Length: 5\r\n\r\nhello' },
  { name: 'post-chunked', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n' },
  { name: 'post-chunked-trailer', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\nX-T: 1\r\n\r\n' },
  // CL + TE.
  { name: 'cl-te', raw: POST + 'Content-Length: 6\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n' + NEXT },
  { name: 'te-cl', raw: POST + 'Transfer-Encoding: chunked\r\nContent-Length: 6\r\n\r\n0\r\n\r\n' + NEXT },
  { name: 'cl-te-chunked-body-smuggle', raw: POST + 'Content-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n5c\r\nGPOST / HTTP/1.1\r\n\r\n0\r\n\r\n' },
  // Duplicate / malformed Content-Length.
  { name: 'dup-cl-same', raw: POST + 'Content-Length: 5\r\nContent-Length: 5\r\n\r\nhello' },
  { name: 'dup-cl-diff', raw: POST + 'Content-Length: 5\r\nContent-Length: 6\r\n\r\nhello!' + NEXT },
  { name: 'cl-list', raw: POST + 'Content-Length: 5, 5\r\n\r\nhello' },
  { name: 'cl-negative', raw: POST + 'Content-Length: -5\r\n\r\nhello' },
  { name: 'cl-plus', raw: POST + 'Content-Length: +5\r\n\r\nhello' },
  { name: 'cl-hex', raw: POST + 'Content-Length: 0x5\r\n\r\nhello' },
  { name: 'cl-leading-zeros', raw: POST + 'Content-Length: 005\r\n\r\nhello' },
  { name: 'cl-space-inside', raw: POST + 'Content-Length: 1 0\r\n\r\nhelloworld' },
  { name: 'cl-huge', raw: POST + 'Content-Length: 99999999999999999999\r\n\r\nhello' },
  { name: 'cl-empty', raw: POST + 'Content-Length: \r\n\r\n' + NEXT },
  // Transfer-Encoding variants.
  { name: 'te-chunked-identity', raw: POST + 'Transfer-Encoding: chunked, identity\r\n\r\n5\r\nhello\r\n0\r\n\r\n' },
  { name: 'te-identity-chunked', raw: POST + 'Transfer-Encoding: identity, chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n' },
  { name: 'te-gzip-chunked', raw: POST + 'Transfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n' },
  { name: 'te-identity-only', raw: POST + 'Transfer-Encoding: identity\r\n\r\n' },
  { name: 'te-leading-space', raw: POST + 'Transfer-Encoding:  chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n' },
  { name: 'te-xchunked', raw: POST + 'Transfer-Encoding: xchunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n' },
  { name: 'te-chunked-x', raw: POST + 'Transfer-Encoding: chunkedx\r\n\r\n5\r\nhello\r\n0\r\n\r\n' },
  { name: 'te-uppercase', raw: POST + 'Transfer-Encoding: CHUNKED\r\n\r\n5\r\nhello\r\n0\r\n\r\n' },
  { name: 'te-dup-header', raw: POST + 'Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n' },
  { name: 'te-chunked-chunked', raw: POST + 'Transfer-Encoding: chunked, chunked\r\n\r\n0\r\n\r\n' },
  { name: 'te-tab', raw: POST + 'Transfer-Encoding:\tchunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n' },
  { name: 'te-vtab', raw: POST + 'Transfer-Encoding: \x0bchunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n' },
  { name: 'te-obs-fold', raw: POST + 'Transfer-Encoding:\r\n chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n' },
  { name: 'obs-fold-other', raw: POST + 'X-A: 1\r\n 2\r\nContent-Length: 5\r\n\r\nhello' },
  { name: 'http10-te-chunked', raw: 'POST /p HTTP/1.0\r\n' + H + 'Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n' },
  // Whitespace / line endings.
  { name: 'space-before-colon-cl', raw: POST + 'Content-Length : 5\r\n\r\nhello' },
  { name: 'space-before-colon-te', raw: POST + 'Transfer-Encoding : chunked\r\nContent-Length: 5\r\n\r\nhello' },
  { name: 'bare-lf-headers', raw: 'GET / HTTP/1.1\n' + 'Host: t\n\n' },
  { name: 'bare-lf-mixed', raw: POST + 'Content-Length: 5\n\r\nhello' },
  { name: 'bare-cr', raw: 'GET / HTTP/1.1\r\nHost: t\rX: y\r\n\r\n' },
  { name: 'leading-crlf', raw: '\r\nGET / HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'nul-in-header-value', raw: 'GET / HTTP/1.1\r\n' + H + 'X-A: a\0b\r\n\r\n' },
  { name: 'nul-in-header-name', raw: 'GET / HTTP/1.1\r\n' + H + 'X\0A: b\r\n\r\n' },
  { name: 'ctl-in-header-value', raw: 'GET / HTTP/1.1\r\n' + H + 'X-A: a\x01b\r\n\r\n' },
  { name: 'space-in-header-name', raw: 'GET / HTTP/1.1\r\n' + H + 'X A: b\r\n\r\n' },
  { name: 'no-colon-header', raw: 'GET / HTTP/1.1\r\n' + H + 'Garbage\r\n\r\n' },
  // Chunked body edge cases.
  { name: 'chunk-ext', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5;foo=bar\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-ext-quoted', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5;foo="b;a\\"r"\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-ext-bare-name', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5;foo\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-ext-lf-inside', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5;a=\nb\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-size-oversized', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n10000000000000000\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-size-ffff', raw: POST + 'Transfer-Encoding: chunked\r\n\r\nffffffffffffffff\r\nhello\r\n' },
  { name: 'chunk-size-0x', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n0x5\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-size-negative', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n-5\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-size-leading-zeros', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n0005\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-data-too-long', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5\r\nhelloXX\r\n0\r\n\r\n' + NEXT },
  { name: 'chunk-missing-crlf', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5\r\nhello0\r\n\r\n' },
  { name: 'chunk-lf-only', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5\nhello\n0\n\n' },
  { name: 'chunk-last-no-final-crlf', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n' + NEXT },
  // Chunk-size line whitespace / extension grammar (llhttp strict: no BWS anywhere).
  { name: 'chunk-size-trailing-sp', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5 \r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-size-trailing-tab', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5\t\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-size-leading-sp', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n 5\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-size-sp-before-ext', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5 ;a=b\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-ext-sp-after-semi', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5; a=b\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-ext-sp-around-eq', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5;a = b\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-ext-trailing-sp', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5;a=b \r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-ext-empty', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5;\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-ext-empty-name', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5;=b\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-ext-bad-token', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5;a@b\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-ext-quote-then-token', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5;a="x"y\r\nhello\r\n0\r\n\r\n' },
  { name: 'chunk-last-trailing-sp', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0 \r\n\r\n' + NEXT },
  // Methods: llhttp accepts exactly http.METHODS, case-sensitively.
  { name: 'method-unknown', raw: 'FOO / HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'method-lowercase', raw: 'get / HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'method-prefixed', raw: 'abcGET / HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'method-pri', raw: 'PRI / HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'method-rtsp', raw: 'DESCRIBE / HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'method-m-search', raw: 'M-SEARCH * HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'method-query', raw: 'QUERY /q HTTP/1.1\r\n' + H + 'Content-Length: 2\r\n\r\nhi' },
  { name: 'pipelined-body-misframed-as-method', raw: POST + 'Content-Length: 3\r\n\r\nabcabcGET /smuggled HTTP/1.1\r\n' + H + '\r\n' },
  // Request-target forms.
  { name: 'target-dash', raw: 'GET -p HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'target-relative', raw: 'GET chunked/p HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'target-query-only', raw: 'GET ?x HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'target-authority-non-connect', raw: 'GET t:80 HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'target-scheme-single-slash', raw: 'GET http:/a HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'target-asterisk-suffix', raw: 'GET *x HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'target-double-slash', raw: 'GET //x HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'absolute-form-other-scheme', raw: 'GET ws://t/abs HTTP/1.1\r\n' + H + '\r\n' },
  // Request line / Host.
  { name: 'absolute-form', raw: 'GET http://t/abs HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'absolute-form-other-host', raw: 'GET http://other/abs HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'asterisk-form-get', raw: 'GET * HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'missing-host', raw: 'GET / HTTP/1.1\r\n\r\n' },
  { name: 'double-host', raw: 'GET / HTTP/1.1\r\n' + H + 'Host: u\r\n\r\n' },
  { name: 'http10-no-host', raw: 'GET / HTTP/1.0\r\n\r\n' },
  { name: 'http09', raw: 'GET /\r\n\r\n' },
  { name: 'http2-version', raw: 'GET / HTTP/2.0\r\n' + H + '\r\n' },
  { name: 'http-version-garbage', raw: 'GET / HTTP/1.x\r\n' + H + '\r\n' },
  { name: 'double-space-request-line', raw: 'GET  / HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'tab-in-request-line', raw: 'GET\t/ HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'space-in-uri', raw: 'GET /a b HTTP/1.1\r\n' + H + '\r\n' },
  // Pipelining.
  { name: 'pipelined-get-get', raw: 'GET /1 HTTP/1.1\r\n' + H + '\r\nGET /2 HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'pipelined-post-get', raw: POST + 'Content-Length: 5\r\n\r\nhelloGET /2 HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'pipelined-chunked-get', raw: POST + 'Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\nGET /2 HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'pipelined-get-body-ignored', raw: 'GET /1 HTTP/1.1\r\n' + H + 'Content-Length: 25\r\n\r\nGET /2 HTTP/1.1\r\nHost: t\r\n\r\n' },
  { name: 'pipelined-close-then-get', raw: 'GET /1 HTTP/1.1\r\n' + H + 'Connection: close\r\n\r\nGET /2 HTTP/1.1\r\n' + H + '\r\n' },
  { name: 'pipelined-bad-second', raw: 'GET /1 HTTP/1.1\r\n' + H + '\r\nGET /2 HTTP/1.1\r\n' + H + 'Content-Length: x\r\n\r\n' },
];

interface Outcome {
  node: ExchangeResult;
  rx: ExchangeResult;
}

async function runBoth(raw: Buffer): Promise<Outcome> {
  const [node, rx] = await Promise.all([exchange(nodeT, raw), exchange(rxT, raw)]);
  return { node, rx };
}

/** Invariants 1 and 2. Returns a description of the violation, or null. */
function boundaryViolation(o: Outcome): string | null {
  const rxSeen = o.rx.seen;
  if (rxSeen.length > o.node.seen.length) {
    return `rxpress saw ${rxSeen.length} requests, node ${o.node.seen.length}`;
  }
  for (let i = 0; i < rxSeen.length; i++) {
    const a = rxSeen[i];
    const b = o.node.seen[i];
    // Node keeps absolute-form in req.url; rxpress's originalUrl is the path. Compare paths.
    const path = (u: string) => u.replace(/^[a-z]+:\/\/[^/]*/i, '') || '/';
    if (a.method !== b.method || path(a.url) !== path(b.url) || a.body !== b.body) {
      return `request #${i} differs: rxpress=${JSON.stringify(a)} node=${JSON.stringify(b)}`;
    }
  }
  return null;
}

function summary(o: Outcome): string {
  const s = (r: ExchangeResult) =>
    `${verdict(r)} statuses=${JSON.stringify(r.statuses)} seen=${r.seen.length}${r.closedByServer ? ' closed' : ''}`;
  return `node: ${s(o.node)} | rxpress: ${s(o.rx)}`;
}

describeRx('differential framing vs node:http (llhttp): hand-written smuggling corpus', () => {
  const results = new Map<string, Outcome>();

  it(`runs ${CORPUS.length} cases; rxpress never sees more requests or different bodies`, async () => {
    const violations: string[] = [];
    for (const c of CORPUS) {
      const o = await runBoth(Buffer.from(c.raw, 'latin1'));
      results.set(c.name, o);
      const v = boundaryViolation(o);
      if (v) violations.push(`${c.name}: ${v} (${summary(o)})`);
    }
    if (process.env.DIFF_VERBOSE) {
      for (const [n, o] of results) console.log(n.padEnd(30), summary(o));
    }
    expect(violations).toEqual([]);
  });

  it('verdicts (accepted / rejected) match node unless whitelisted', () => {
    const diffs: string[] = [];
    for (const c of CORPUS) {
      const o = results.get(c.name);
      if (!o) continue;
      const vn = verdict(o.node);
      const vr = verdict(o.rx);
      if (vn === vr) continue;
      if (vn === 'accepted' && vr === 'rejected' && STRICTER_WHITELIST[c.name]) continue;
      if (VERDICT_RACE[c.name] && o.node.seen.length === o.rx.seen.length) continue;
      diffs.push(`${c.name}: ${summary(o)}`);
    }
    expect(diffs).toEqual([]);
  });

  it('whitelisted stricter cases: rxpress rejects and sees nothing', () => {
    for (const name of Object.keys(STRICTER_WHITELIST)) {
      const o = results.get(name);
      expect(o, name).toBeDefined();
      if (!o) continue;
      expect(o.rx.seen, name).toEqual([]);
      expect(verdict(o.rx), name).not.toBe('accepted');
    }
  });

  it('every smuggling probe that targets /smuggled is never routed by rxpress', () => {
    for (const [name, o] of results) {
      const smuggled = o.rx.seen.filter((r) => r.url === '/smuggled');
      const nodeSmuggled = o.node.seen.filter((r) => r.url === '/smuggled');
      expect(smuggled.length, name).toBeLessThanOrEqual(nodeSmuggled.length);
    }
  });
});

describeRx('differential framing vs node:http (llhttp): request line and chunk-size regressions', () => {
  // Formerly accepted by rxpress, rejected by llhttp: chunk-size whitespace (RFC 9112 7.1
  // chunk-size = 1*HEXDIG, no BWS), methods outside http.METHODS, and request-targets that
  // are not origin-form / absolute-form / `*` (CONNECT: authority-form).
  it('chunk size with whitespace ("5 ", "5\\t", "5 ;a") is a 400 and the request is not seen', async () => {
    for (const line of ['5 ', '5\t', '5 ;a=b', '5;a ']) {
      const o = await runBoth(Buffer.from(POST + `Transfer-Encoding: chunked\r\n\r\n${line}\r\nhello\r\n0\r\n\r\n`, 'latin1'));
      expect(verdict(o.node), JSON.stringify(line)).toBe('rejected');
      expect(verdict(o.rx), JSON.stringify(line)).toBe('rejected');
      expect(o.rx.seen, JSON.stringify(line)).toEqual([]);
    }
  });

  it('unknown / lowercase methods are a 400; a body mis-framed as `abcGET` is never dispatched', async () => {
    for (const m of ['FOO', 'get', 'abcGET', 'PRI']) {
      const o = await runBoth(Buffer.from(`${m} / HTTP/1.1\r\n${H}\r\n`, 'latin1'));
      expect(verdict(o.node), m).toBe('rejected');
      expect(verdict(o.rx), m).toBe('rejected');
      expect(o.rx.seen, m).toEqual([]);
    }
  });

  it('request-target not starting with "/", "*" or a scheme is a 400', async () => {
    for (const t of ['-p', 'chunked/p', 'p', '?x', 't:80']) {
      const o = await runBoth(Buffer.from(`GET ${t} HTTP/1.1\r\n${H}\r\n`, 'latin1'));
      expect(verdict(o.node), t).toBe('rejected');
      expect(verdict(o.rx), t).toBe('rejected');
      expect(o.rx.seen, t).toEqual([]);
    }
  });

  it('every method in http.METHODS (except CONNECT) is accepted by both', async () => {
    const diffs: string[] = [];
    for (const m of http.METHODS) {
      if (m === 'CONNECT') continue; // node routes it to the 'connect' event, not the handler
      const o = await runBoth(Buffer.from(`${m} / HTTP/1.1\r\n${H}Content-Length: 0\r\n\r\n`, 'latin1'));
      if (verdict(o.node) !== 'accepted' || verdict(o.rx) !== 'accepted' || o.rx.seen.length !== 1) {
        diffs.push(`${m}: ${summary(o)}`);
      }
    }
    expect(diffs).toEqual([]);
  });
});

// --- Mutation fuzzing ------------------------------------------------------------------

const SEEDS = [
  'GET /a?x=1 HTTP/1.1\r\nHost: t\r\nX-A: b\r\n\r\n',
  'POST /p HTTP/1.1\r\nHost: t\r\nContent-Length: 5\r\n\r\nhello',
  'POST /p HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n',
  'POST /p HTTP/1.1\r\nHost: t\r\nContent-Length: 3\r\n\r\nabcGET /2 HTTP/1.1\r\nHost: t\r\n\r\n',
  'POST /p HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\nGET /2 HTTP/1.1\r\nHost: t\r\n\r\n',
];

const INSERTS = [
  ' ', '\t', '\r', '\n', '\r\n', '\0', ':', ',', ';', '0', '5', 'a', 'f', '-', '+', '"', '\x0b', '\x7f', '\xff',
  'Content-Length: 5\r\n', 'Transfer-Encoding: chunked\r\n', 'Content-Length: 0\r\n', '\r\n ', 'chunked',
];

type Mutation =
  | { k: 'insert'; at: number; s: string }
  | { k: 'delete'; at: number; n: number }
  | { k: 'replace'; at: number; s: string }
  | { k: 'dupline'; at: number };

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ k: fc.constant('insert' as const), at: fc.nat(400), s: fc.constantFrom(...INSERTS) }),
  fc.record({ k: fc.constant('delete' as const), at: fc.nat(400), n: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ k: fc.constant('replace' as const), at: fc.nat(400), s: fc.constantFrom(...INSERTS) }),
  fc.record({ k: fc.constant('dupline' as const), at: fc.nat(400) })
);

function applyMutation(raw: string, m: Mutation): string {
  const at = m.at % (raw.length + 1);
  switch (m.k) {
    case 'insert':
      return raw.slice(0, at) + m.s + raw.slice(at);
    case 'delete':
      return raw.slice(0, at) + raw.slice(at + m.n);
    case 'replace':
      return raw.slice(0, at) + m.s + raw.slice(at + 1);
    case 'dupline': {
      const start = raw.lastIndexOf('\r\n', at) + 2;
      const end = raw.indexOf('\r\n', at);
      if (start < 2 || end === -1) return raw;
      const line = raw.slice(start, end + 2);
      return raw.slice(0, start) + line + raw.slice(start);
    }
  }
}

describeRx('differential framing vs node:http (llhttp): mutation fuzzing', () => {
  it('mutated valid requests never make rxpress see more / different requests than node', async () => {
    const violations: string[] = [];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SEEDS),
        fc.array(mutationArb, { minLength: 1, maxLength: 3 }),
        async (seed, muts) => {
          const raw = muts.reduce(applyMutation, seed);
          const o = await runBoth(Buffer.from(raw, 'latin1'));
          const v = boundaryViolation(o);
          if (v && violations.length < 10) violations.push(`${JSON.stringify(raw)}: ${v} (${summary(o)})`);
        }
      ),
      { seed: 0x5eed_2026, numRuns: Number(process.env.DIFF_RUNS ?? 120), endOnFailure: true }
    );
    expect(violations).toEqual([]);
  }, 120_000);
});
