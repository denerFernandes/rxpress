// ---- Trust Proxy Evaluator (IPv4, IPv6, CIDR, Presets, Hops, Function) ----

export type TrustProxyFn = (ip: string, hopIndex: number) => boolean;

interface CidrV4 {
  kind: 4;
  net: number;
  mask: number;
}

interface CidrV6 {
  kind: 6;
  net: bigint;
  mask: bigint;
}

type ParsedSubnet = CidrV4 | CidrV6;

function parseIpv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (let i = 0; i < 4; i++) {
    const p = parts[i];
    if (p.length === 0 || p.length > 3) return null;
    for (let j = 0; j < p.length; j++) {
      const c = p.charCodeAt(j);
      if (c < 48 || c > 57) return null;
    }
    const n = Number(p);
    if (n > 255) return null;
    acc = (acc << 8) | n;
  }
  return acc >>> 0;
}

function parseIpv6(raw: string): bigint | null {
  let ip = raw;
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) {
    ip = ip.slice(0, zoneIdx);
  }
  if (!ip.includes(':')) return null;

  // Handle IPv4-embedded suffix (e.g., ::ffff:127.0.0.1)
  const lastColon = ip.lastIndexOf(':');
  let embeddedV4: number | null = null;
  if (ip.indexOf('.', lastColon + 1) !== -1) {
    embeddedV4 = parseIpv4(ip.slice(lastColon + 1));
    if (embeddedV4 === null) return null;
    ip = ip.slice(0, lastColon + 1) + '0:0';
  }

  const dbl = ip.indexOf('::');
  let head: string[];
  let tail: string[];
  if (dbl !== -1) {
    if (ip.indexOf('::', dbl + 2) !== -1) return null;
    const hStr = ip.slice(0, dbl);
    const tStr = ip.slice(dbl + 2);
    head = hStr ? hStr.split(':') : [];
    tail = tStr ? tStr.split(':') : [];
    if (head.length + tail.length > 8) return null;
  } else {
    head = ip.split(':');
    tail = [];
    if (head.length !== 8) return null;
  }

  const groups = new Array<number>(8).fill(0);
  for (let i = 0; i < head.length; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(head[i])) return null;
    groups[i] = parseInt(head[i], 16);
  }
  const tailStart = 8 - tail.length;
  for (let i = 0; i < tail.length; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(tail[i])) return null;
    groups[tailStart + i] = parseInt(tail[i], 16);
  }

  let acc = 0n;
  for (let i = 0; i < 8; i++) {
    acc = (acc << 16n) | BigInt(groups[i]);
  }
  if (embeddedV4 !== null) {
    acc = (acc & ~0xffffffffn) | BigInt(embeddedV4);
  }
  return acc;
}

function normalizeIpForMatch(rawIp: string): { v4: number | null; v6: bigint | null } {
  let ip = rawIp.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1);
  }
  const v4 = parseIpv4(ip);
  if (v4 !== null) {
    return { v4, v6: null };
  }
  const v6 = parseIpv6(ip);
  if (v6 !== null) {
    // Detect IPv4-mapped IPv6 ::ffff:a.b.c.d (0x0000_0000_0000_0000_0000_ffff_xxxx_xxxx)
    if ((v6 >> 32n) === 0xffffn) {
      return { v4: Number(v6 & 0xffffffffn), v6 };
    }
    return { v4: null, v6 };
  }
  return { v4: null, v6: null };
}

function expandPreset(token: string): string[] {
  switch (token.toLowerCase()) {
    case 'loopback':
      return ['127.0.0.1/8', '::1/128'];
    case 'linklocal':
      return ['169.254.0.0/16', 'fe80::/10'];
    case 'uniquelocal':
      return ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'];
    default:
      return [token];
  }
}

function parseSubnetToken(token: string): ParsedSubnet | null {
  const slash = token.indexOf('/');
  const addrPart = (slash === -1 ? token : token.slice(0, slash)).trim();
  const maskPart = slash === -1 ? null : token.slice(slash + 1).trim();

  const v4 = parseIpv4(addrPart);
  if (v4 !== null) {
    let mask = 0xffffffff;
    if (maskPart !== null) {
      if (/^\d+$/.test(maskPart)) {
        const prefix = Number(maskPart);
        if (prefix < 0 || prefix > 32) return null;
        mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      } else {
        const dotted = parseIpv4(maskPart);
        if (dotted === null) return null;
        mask = dotted;
      }
    }
    return { kind: 4, net: (v4 & mask) >>> 0, mask };
  }

  const v6 = parseIpv6(addrPart);
  if (v6 !== null) {
    let prefix = 128;
    if (maskPart !== null) {
      if (!/^\d+$/.test(maskPart)) return null;
      prefix = Number(maskPart);
      if (prefix < 0 || prefix > 128) return null;
    }
    const allOnes = (1n << 128n) - 1n;
    const mask = prefix === 0 ? 0n : (allOnes << BigInt(128 - prefix)) & allOnes;
    return { kind: 6, net: v6 & mask, mask };
  }

  return null;
}

export function parseTrustProxy(val: unknown): TrustProxyFn | null {
  if (!val) return null;
  if (val === true) return () => true;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0) return null;
    const maxHops = Math.floor(val);
    return (_ip: string, idx: number) => idx < maxHops;
  }
  if (typeof val === 'function') {
    return val as TrustProxyFn;
  }

  const rawList: string[] = Array.isArray(val)
    ? val.map(String)
    : typeof val === 'string'
      ? val.split(',')
      : [];

  const subnets: ParsedSubnet[] = [];
  for (const raw of rawList) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    for (const expanded of expandPreset(trimmed)) {
      const parsed = parseSubnetToken(expanded);
      if (parsed) subnets.push(parsed);
    }
  }

  if (subnets.length === 0) return null;

  return (ip: string): boolean => {
    const { v4, v6 } = normalizeIpForMatch(ip);
    for (let i = 0; i < subnets.length; i++) {
      const s = subnets[i];
      if (s.kind === 4 && v4 !== null) {
        if (((v4 & s.mask) >>> 0) === s.net) return true;
      } else if (s.kind === 6 && v6 !== null) {
        if ((v6 & s.mask) === s.net) return true;
      }
    }
    return false;
  };
}

