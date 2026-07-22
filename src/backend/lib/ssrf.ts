/**
 * SSRF guard for outbound fetches on the publish/read path (icon re-host and
 * README fetches). Ported from yurucommu/src/backend/lib/ssrf.ts — the synchronous
 * URL-shape + private-IP-literal classifier subset. A publisher is an
 * authenticated actor, so the threat model is lower than yurucommu's pre-auth
 * federation; the full DoH-resolution + connection-pinning hardening is a
 * future addition (documented gap), but blocking private/loopback/link-local
 * literals and non-https targets closes the obvious holes.
 */
const HOSTNAME_PATTERN = /^[a-z0-9.-]+$/i;

function parseIPv4(hostname: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null;
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}

function isPrivateIPv4(hostname: string): boolean {
  const parts = parseIPv4(hostname);
  if (!parts) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function expandIPv6(input: string): number[] | null {
  let s = input.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (s.length === 0) return null;

  if (s.includes(".")) {
    const m = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (!m) return null;
    const v4 = parseIPv4(m[2]);
    if (!v4) return null;
    const h1 = ((v4[0] << 8) | v4[1]).toString(16);
    const h2 = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${m[1]}${h1}:${h2}`;
  }

  const doubleIdx = s.indexOf("::");
  if (doubleIdx !== s.lastIndexOf("::")) return null;

  const parseGroups = (str: string): number[] | null => {
    if (str === "") return [];
    const out: number[] = [];
    for (const g of str.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  let groups: number[];
  if (doubleIdx !== -1) {
    const head = parseGroups(s.slice(0, doubleIdx));
    const tail = parseGroups(s.slice(doubleIdx + 2));
    if (head === null || tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array(missing).fill(0), ...tail];
  } else {
    const all = parseGroups(s);
    if (all === null) return null;
    groups = all;
  }
  return groups.length === 8 ? groups : null;
}

function embeddedV4IsPrivate(hi: number, lo: number): boolean {
  return isPrivateIPv4(
    `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`,
  );
}

function isPrivateIPv6(ipv6Raw: string): boolean {
  const g = expandIPv6(ipv6Raw);
  if (!g) return true; // unparseable IPv6 → fail closed
  const allZeroHigh =
    g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (allZeroHigh && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) {
    return true;
  }
  const hi8 = g[0] >> 8;
  if (hi8 === 0xfc || hi8 === 0xfd) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xffc0) === 0xfec0) return true;
  if (hi8 === 0xff) return true;
  if (allZeroHigh && g[5] === 0xffff) return embeddedV4IsPrivate(g[6], g[7]);
  if (allZeroHigh && g[5] === 0) return embeddedV4IsPrivate(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b) return embeddedV4IsPrivate(g[6], g[7]);
  if (g[0] === 0x2002) return embeddedV4IsPrivate(g[1], g[2]);
  return false;
}

export function isPrivateIpAddress(host: string): boolean {
  if (isPrivateIPv4(host)) return true;
  if (host.includes(":")) return isPrivateIPv6(host);
  return false;
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  return normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
}

const BLOCKED_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
];

function isBlockedHostname(hostname: string): boolean {
  const lower = normalizeHostname(hostname);
  if (lower === "localhost") return true;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return true;
  }
  return isPrivateIpAddress(lower);
}

/** https/http only, parsable, no embedded credentials, public host. */
export function isSafeRemoteUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (!HOSTNAME_PATTERN.test(parsed.hostname)) return false;
    if (!parsed.hostname.includes(".")) return false;
    if (isBlockedHostname(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}
