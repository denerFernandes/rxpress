import { isUnsafeKey } from './query-body.js';

// ---- Content Negotiation (matching negotiator) ----

interface ParsedMediaRange {
  type: string;
  subtype: string;
  params: Record<string, string>;
  q: number;
  o: number;
}

const SIMPLE_MEDIA_TYPE_REGEXP = /^\s*([^\s/;]+)\/([^;\s]+)\s*(?:;(.*))?$/;

function splitMediaParams(str: string): Record<string, string> {
  const params: Record<string, string> = Object.create(null);
  const parts = str.split(';');
  for (let i = 0; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq === -1) continue;
    const k = parts[i].slice(0, eq).trim().toLowerCase();
    let v = parts[i].slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      v = v.slice(1, -1);
    }
    if (k && !isUnsafeKey(k)) params[k] = v;
  }
  return params;
}

function parseAcceptRanges(accept: string): ParsedMediaRange[] {
  const out: ParsedMediaRange[] = [];
  const parts = accept.split(',');
  for (let i = 0; i < parts.length; i++) {
    const m = SIMPLE_MEDIA_TYPE_REGEXP.exec(parts[i]);
    if (!m) continue;
    const type = m[1].toLowerCase();
    const subtype = m[2].toLowerCase();
    let q = 1;
    const params: Record<string, string> = Object.create(null);
    if (m[3]) {
      const parsed = splitMediaParams(m[3]);
      for (const k of Object.keys(parsed)) {
        if (k === 'q') {
          const parsedQ = parseFloat(parsed.q);
          // negotiator: an unparsable q never ranks as acceptable
          q = Number.isFinite(parsedQ) ? parsedQ : 0;
        } else {
          params[k] = parsed[k];
        }
      }
    }
    if (q >= 0) {
      out.push({ type, subtype, params, q, o: i });
    }
  }
  return out;
}

function getMediaTypePriority(
  type: string,
  accepted: ParsedMediaRange[],
  index: number
): { i: number; o: number; q: number; s: number } {
  const m = SIMPLE_MEDIA_TYPE_REGEXP.exec(type);
  if (!m) return { i: index, o: -1, q: 0, s: 0 };
  const candType = m[1].toLowerCase();
  const candSub = m[2].toLowerCase();
  const candParams = m[3] ? splitMediaParams(m[3]) : null;

  let best: { i: number; o: number; q: number; s: number } = {
    i: index,
    o: -1,
    q: 0,
    s: 0,
  };

  for (let j = 0; j < accepted.length; j++) {
    const spec = accepted[j];
    let s = 0;
    if (spec.type === candType || spec.type === '*') {
      if (spec.subtype === candSub || spec.subtype === '*') {
        let paramsMatch = true;
        let paramMatches = 0;
        const specKeys = Object.keys(spec.params);
        for (let k = 0; k < specKeys.length; k++) {
          const pk = specKeys[k];
          const sv = spec.params[pk];
          const cv = candParams ? candParams[pk] : undefined;
          if (sv !== '*' && (!cv || sv.toLowerCase() !== cv.toLowerCase())) {
            paramsMatch = false;
            break;
          }
          paramMatches++;
        }
        if (paramsMatch) {
          if (spec.type === candType) s |= 4;
          if (spec.subtype === candSub) s |= 2;
          if (paramMatches > 0) s |= 1;
        }
      }
    }
    if (s > 0 || (spec.type === '*' && spec.subtype === '*' && Object.keys(spec.params).length === 0)) {
      const cur = { i: index, o: spec.o, q: spec.q, s };
      if ((best.s - cur.s || best.q - cur.q || best.o - cur.o) < 0) {
        best = cur;
      }
    }
  }

  return best;
}

function compareMediaSpecs(
  a: { i: number; o: number; q: number; s: number },
  b: { i: number; o: number; q: number; s: number }
): number {
  return b.q - a.q || b.s - a.s || a.o - b.o || a.i - b.i;
}

/** Zero-argument `req.accepts()`: acceptable media ranges, best first (negotiator order). */
export function listAcceptedMediaTypes(acceptHeader: string): string[] {
  return parseAcceptRanges(acceptHeader)
    .filter((r) => r.q > 0)
    .sort((a, b) => b.q - a.q || a.o - b.o)
    .map((r) => `${r.type}/${r.subtype}`);
}

export function negotiateAccept(
  acceptHeader: string,
  candidates: string[],
  normalizeShorthand: (t: string) => string
): string | false {
  const accepted = parseAcceptRanges(acceptHeader);
  const priorities = candidates
    .map((c, idx) => ({
      candidate: c,
      prio: getMediaTypePriority(normalizeShorthand(c), accepted, idx),
    }))
    .filter((x) => x.prio.q > 0)
    .sort((a, b) => compareMediaSpecs(a.prio, b.prio));

  return priorities.length > 0 ? priorities[0].candidate : false;
}

interface ParsedTokenRange {
  token: string;
  q: number;
  o: number;
}

function parseTokenAcceptHeader(header: string): ParsedTokenRange[] {
  const out: ParsedTokenRange[] = [];
  const parts = header.split(',');
  for (let i = 0; i < parts.length; i++) {
    const segs = parts[i].trim().split(';');
    const token = segs[0].trim().toLowerCase();
    if (!token) continue;
    let q = 1;
    for (let j = 1; j < segs.length; j++) {
      const eq = segs[j].indexOf('=');
      if (eq !== -1 && segs[j].slice(0, eq).trim().toLowerCase() === 'q') {
        const pq = parseFloat(segs[j].slice(eq + 1).trim());
        q = Number.isFinite(pq) ? pq : 0;
      }
    }
    out.push({ token, q, o: i });
  }
  return out;
}

export function negotiateSimpleTokens(
  header: string,
  candidates: string[],
  isLanguage = false
): string | string[] | false {
  const parsed = parseTokenAcceptHeader(header);
  if (candidates.length === 0) {
    return parsed.filter((p) => p.q > 0).sort((a, b) => b.q - a.q || a.o - b.o).map((p) => p.token);
  }

  let bestCandidate: string | false = false;
  let bestQ = 0;
  let bestS = -1;
  let bestO = Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const lc = cand.toLowerCase();
    let candBestQ = 0;
    let candBestS = -1;
    let candBestO = Infinity;
    let explicitlyRejected = false;

    for (let j = 0; j < parsed.length; j++) {
      const spec = parsed[j];
      let s = -1;
      if (spec.token === lc) {
        s = 4;
      } else if (isLanguage && (spec.token.startsWith(`${lc}-`) || lc.startsWith(`${spec.token}-`))) {
        s = 2;
      } else if (spec.token === '*') {
        s = 1;
      }
      if (s > candBestS) {
        candBestS = s;
        candBestQ = spec.q;
        candBestO = spec.o;
        explicitlyRejected = spec.q === 0;
      }
    }

    if (!explicitlyRejected && candBestQ > 0) {
      if (
        candBestQ > bestQ ||
        (candBestQ === bestQ && candBestS > bestS) ||
        (candBestQ === bestQ && candBestS === bestS && candBestO < bestO)
      ) {
        bestQ = candBestQ;
        bestS = candBestS;
        bestO = candBestO;
        bestCandidate = cand;
      }
    }
  }

  return bestCandidate;
}

