import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { LookupFn, TlsConnectFn, TlsPeer, UrlAnalysisDeps } from "../src/types.js";

export const NOW = new Date("2026-01-15T12:00:00.000Z");

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;
}

type Handler = Response | ((url: string, init: RequestInit) => Response | Promise<Response>);

/**
 * Route table fetch mock. Keys are "METHOD url" or "url" (any method).
 * Unrouted requests reject, so tests fail loudly on unexpected network use.
 */
export function routeFetch(routes: Record<string, Handler>) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const h = routes[`${method} ${url}`] ?? routes[url];
    if (!h) throw new TypeError(`fetch failed: no route for ${method} ${url}`);
    const res = typeof h === "function" ? await h(url, init) : h.clone();
    return res;
  });
}

export const html = (body: string, status = 200): Response => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const redirect = (location: string, status = 302): Response => new Response(null, { status, headers: { location } });

export function fakeLookup(table: Record<string, string[]>): LookupFn & ReturnType<typeof vi.fn> {
  return vi.fn(async (host: string) => {
    const addrs = table[host];
    if (!addrs) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }) as unknown as LookupFn & ReturnType<typeof vi.fn>;
}

export const GOOD_PEER: TlsPeer = {
  authorized: true,
  subject: { CN: "example.com" },
  issuer: { C: "US", O: "DigiCert Inc", CN: "DigiCert Global G2 TLS RSA SHA256 2020 CA1" },
  valid_from: "Jan 15 00:00:00 2025 GMT",
  valid_to: "Jan 15 23:59:59 2027 GMT",
  subjectaltname: "DNS:example.com, DNS:www.example.com",
};

export function fakeTls(peer: TlsPeer = GOOD_PEER): TlsConnectFn & ReturnType<typeof vi.fn> {
  return vi.fn(async () => peer) as unknown as TlsConnectFn & ReturnType<typeof vi.fn>;
}

/** Deterministic, offline deps; override per test. */
export function testDeps(over: Partial<UrlAnalysisDeps> = {}): Partial<UrlAnalysisDeps> {
  return {
    fetch: routeFetch({}),
    lookup: fakeLookup({}),
    tlsConnect: fakeTls(),
    env: {},
    mock: false,
    urlscan: false,
    now: () => NOW,
    urlscanPollIntervalMs: 1,
    ...over,
  };
}
