import { isIP } from "node:net";
import type { LookupAddress, LookupFn } from "../types.js";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

type V4Range = [number, number, string]; // base (uint32), prefix length, reason

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED: V4Range[] = [
  [v4ToInt("0.0.0.0"), 8, "unspecified/this-network"],
  [v4ToInt("10.0.0.0"), 8, "private (RFC1918)"],
  [v4ToInt("100.64.0.0"), 10, "carrier-grade NAT (RFC6598)"],
  [v4ToInt("127.0.0.0"), 8, "loopback"],
  [v4ToInt("169.254.0.0"), 16, "link-local"],
  [v4ToInt("172.16.0.0"), 12, "private (RFC1918)"],
  [v4ToInt("192.0.0.0"), 24, "IETF protocol assignments"],
  [v4ToInt("192.0.2.0"), 24, "documentation (TEST-NET-1)"],
  [v4ToInt("192.88.99.0"), 24, "6to4 relay anycast"],
  [v4ToInt("192.168.0.0"), 16, "private (RFC1918)"],
  [v4ToInt("198.18.0.0"), 15, "benchmarking"],
  [v4ToInt("198.51.100.0"), 24, "documentation (TEST-NET-2)"],
  [v4ToInt("203.0.113.0"), 24, "documentation (TEST-NET-3)"],
  [v4ToInt("224.0.0.0"), 4, "multicast"],
  [v4ToInt("240.0.0.0"), 4, "reserved/broadcast"],
];

function blockedV4(ip: string): string | null {
  const n = v4ToInt(ip);
  for (const [base, bits, reason] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === (base & mask) >>> 0) return reason;
  }
  return null;
}

/** Parse an IPv6 literal (optionally with embedded IPv4 tail and zone id) to 16 bytes. */
export function parseV6(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    tail = maybeV4.split(".").map(Number);
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const [head = "", rest] = s.split("::");
  const parse = (part: string) => (part ? part.split(":").filter((x) => x !== "") : []);
  const h = parse(head);
  const r = rest === undefined ? [] : parse(rest);
  const fill = rest === undefined ? 0 : 8 - h.length - r.length;
  const groups = [...h, ...Array<string>(fill).fill("0"), ...r].map((g) => parseInt(g, 16));
  if (groups.length !== 8) return null;
  const bytes = groups.flatMap((g) => [(g >> 8) & 0xff, g & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

function blockedV6(ip: string): string | null {
  const b = parseV6(ip);
  if (!b) return "unparseable IPv6";
  const b0 = b[0] ?? 0;
  const b1 = b[1] ?? 0;
  const allZero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const embeddedV4 = (at: number) => b.slice(at, at + 4).join(".");
  if (allZero(0, 16)) return "unspecified (::)";
  if (allZero(0, 15) && b[15] === 1) return "loopback (::1)";
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) return blockedV4(embeddedV4(12)) ?? null;
  if (allZero(0, 12)) return blockedV4(embeddedV4(12)) ?? "IPv4-compatible IPv6";
  // NAT64 64:ff9b::/96
  if (b0 === 0x00 && b1 === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(4, 12)) return blockedV4(embeddedV4(12));
  // 6to4 2002::/16 embeds an IPv4 address
  if (b0 === 0x20 && b1 === 0x02) return blockedV4(embeddedV4(2));
  if (b0 === 0x01 && b1 === 0x00 && allZero(2, 8)) return "discard-only (100::/64)";
  if (b0 === 0x20 && b1 === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "documentation (2001:db8::/32)";
  if ((b0 & 0xfe) === 0xfc) return "unique local (fc00::/7)";
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return "link-local (fe80::/10)";
  if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return "site-local (fec0::/10)";
  if (b0 === 0xff) return "multicast (ff00::/8)";
  return null;
}

/** Why an IP address must not be contacted, or null when it is a public unicast address. */
export function blockedAddressReason(ip: string): string | null {
  const bare = ip.replace(/^\[|\]$/g, "");
  const v = isIP(bare.split("%")[0] ?? "");
  if (v === 4) return blockedV4(bare);
  if (v === 6) return blockedV6(bare);
  return "not an IP address";
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet", ".corp"];

export function blockedHostnameReason(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return "empty hostname";
  if (h === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => h.endsWith(s))) return "local/internal hostname";
  if (!h.includes(".") && isIP(h) === 0) return "single-label hostname";
  return null;
}

export function assertHttpUrl(u: URL): void {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SsrfError(`refused non-http(s) scheme ${u.protocol}`);
}

/**
 * Resolve a hostname and refuse it if it is (or resolves to) any non-public
 * address. Every resolved address must be public: one private answer taints the host.
 */
export async function assertPublicHost(hostname: string, lookup: LookupFn): Promise<LookupAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host.split("%")[0] ?? "");
  if (literal) {
    const reason = blockedAddressReason(host);
    if (reason) throw new SsrfError(`refused ${host}: ${reason}`);
    return [{ address: host, family: literal }];
  }
  const hostReason = blockedHostnameReason(host);
  if (hostReason) throw new SsrfError(`refused ${host}: ${hostReason}`);
  const addrs = await lookup(host);
  if (addrs.length === 0) throw new Error(`DNS lookup for ${host} returned no addresses`);
  for (const a of addrs) {
    const reason = blockedAddressReason(a.address);
    if (reason) throw new SsrfError(`refused ${host}: resolves to ${a.address} (${reason})`);
  }
  return addrs;
}

/** Validate a URL (scheme + host) for server-side fetching. */
export async function assertFetchable(url: string, lookup: LookupFn): Promise<URL> {
  const u = new URL(url);
  assertHttpUrl(u);
  if (u.username || u.password) {
    // Never forward credentials embedded in attacker-supplied URLs.
    u.username = "";
    u.password = "";
  }
  await assertPublicHost(u.hostname, lookup);
  return u;
}
