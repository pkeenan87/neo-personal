import { lookup as dnsLookup, promises as dnsPromises, type LookupAddress as DnsLookupAddress } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { BRANDS } from "./brands.js";
import { SsrfError, blockedAddressReason } from "./checks/ssrf.js";
import { defaultTlsConnect } from "./checks/tls.js";
import type { FetchLike, LookupFn, UrlAnalysisDeps } from "./types.js";

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | DnsLookupAddress[], family?: number) => void;

/**
 * Connection-time DNS guard. The analyzer already validates each hop before
 * fetching; this second check runs on the addresses the socket actually
 * connects to, which closes the DNS-rebinding gap between check and use.
 */
function guardedLookup(hostname: string, options: { family?: number; all?: boolean } | undefined, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true, family: options?.family ?? 0 }, (err, addresses) => {
    if (err) return callback(err, []);
    for (const a of addresses) {
      const reason = blockedAddressReason(a.address);
      if (reason) return callback(new SsrfError(`refused ${hostname}: resolves to ${a.address} (${reason})`) as NodeJS.ErrnoException, []);
    }
    const first = addresses[0];
    if (!first) return callback(Object.assign(new Error(`no addresses for ${hostname}`), { code: "ENOTFOUND" }), []);
    if (options?.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
}

let agent: Agent | undefined;
function guardedAgent(): Agent {
  agent ??= new Agent({
    connect: { lookup: guardedLookup as never, timeout: 5_000 },
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
    connections: 32,
  });
  return agent;
}

/** `fetch` whose sockets can only reach public addresses. */
export const guardedFetch: FetchLike = (url, init) =>
  undiciFetch(url, { ...(init as object), dispatcher: guardedAgent() } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;

export const defaultLookup: LookupFn = (hostname) => dnsPromises.lookup(hostname, { all: true, verbatim: true });

export function resolveDeps(partial: Partial<UrlAnalysisDeps> = {}): UrlAnalysisDeps {
  const env = partial.env ?? process.env;
  return {
    fetch: partial.fetch ?? guardedFetch,
    lookup: partial.lookup ?? defaultLookup,
    tlsConnect: partial.tlsConnect ?? defaultTlsConnect,
    env,
    ...(partial.cache ? { cache: partial.cache } : {}),
    mock: partial.mock ?? env.MOCK_MODE === "true",
    urlscan: partial.urlscan ?? env.URLSCAN_ENABLED === "true",
    virustotalSubmit: partial.virustotalSubmit ?? env.VIRUSTOTAL_SUBMIT !== "false",
    timeoutMs: partial.timeoutMs ?? 5_000,
    redirectBudgetMs: partial.redirectBudgetMs ?? 15_000,
    urlscanPollMs: partial.urlscanPollMs ?? 20_000,
    urlscanPollIntervalMs: partial.urlscanPollIntervalMs ?? 2_500,
    maxRedirects: partial.maxRedirects ?? 10,
    maxBodyBytes: partial.maxBodyBytes ?? 64 * 1024,
    cacheTtlSeconds: partial.cacheTtlSeconds ?? 24 * 60 * 60,
    brands: partial.brands ?? BRANDS,
    now: partial.now ?? (() => new Date()),
  };
}
