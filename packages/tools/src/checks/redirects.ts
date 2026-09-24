import type { CheckContext, PageResult, RedirectHop } from "../types.js";
import { errorMessage, timeoutSignal } from "../util.js";
import { SsrfError, assertFetchable } from "./ssrf.js";

const REQUEST_HEADERS = {
  // A mainstream browser UA: phishing kits often cloak (serve benign pages) to obvious bots.
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.8",
};

const isRedirect = (s: number) => s === 301 || s === 302 || s === 303 || s === 307 || s === 308;

export type RedirectOutcome = {
  page: PageResult;
  chain: string[];
  final_url?: string;
  error?: string;
};

/** Read at most `max` bytes of a body, then cancel the rest. */
export async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.subarray(0, Math.min(value.byteLength, max - total));
      chunks.push(take);
      total += take.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  const v = m?.[1] ?? m?.[2] ?? m?.[3];
  return v === undefined ? undefined : decodeEntities(v);
}

export type PageFacts = { title?: string; has_password_field: boolean; favicon_url?: string; meta_refresh?: string };

/** Extract title, password inputs, favicon, and meta refresh target from (untrusted, partial) HTML. */
export function extractPageFacts(html: string, baseUrl: string): PageFacts {
  const facts: PageFacts = { has_password_field: /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html) };
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (t) {
    const title = decodeEntities(t).replace(/\s+/g, " ").trim().slice(0, 200);
    if (title) facts.title = title;
  }
  const resolve = (href: string | undefined) => {
    if (!href) return undefined;
    try {
      const u = new URL(href, baseUrl);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
    } catch {
      return undefined;
    }
  };
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attr(tag, "rel")?.toLowerCase() ?? "";
    if (rel.split(/\s+/).includes("icon")) {
      facts.favicon_url = resolve(attr(tag, "href"));
      if (facts.favicon_url) break;
    }
  }
  if (!facts.favicon_url) facts.favicon_url = resolve("/favicon.ico");
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (attr(tag, "http-equiv")?.toLowerCase() !== "refresh") continue;
    const target = attr(tag, "content")?.match(/url\s*=\s*['"]?([^'"]+)/i)?.[1];
    const resolved = resolve(target?.trim());
    if (resolved) facts.meta_refresh = resolved;
  }
  return facts;
}

/**
 * Follow a redirect chain server-side with the SSRF guard applied before
 * every hop. HEAD first, falling back to GET; meta-refresh redirects count as hops.
 */
export async function followRedirects(startUrl: string, ctx: CheckContext): Promise<RedirectOutcome> {
  const { deps } = ctx;
  const hops: RedirectHop[] = [];
  const chain: string[] = [startUrl];
  const page: PageResult = { hops, has_password_field: false };
  let current = startUrl;

  const request = async (url: URL, method: "HEAD" | "GET") =>
    deps.fetch(url.href, { method, redirect: "manual", headers: REQUEST_HEADERS, signal: timeoutSignal(deps.timeoutMs, ctx.signal) });

  const next = (location: string) => {
    const u = new URL(location, current);
    u.hash = "";
    current = u.href;
    chain.push(current);
  };

  try {
    for (let redirects = 0; ; ) {
      const url = await assertFetchable(current, deps.lookup);

      let res: Response | undefined;
      try {
        res = await request(url, "HEAD");
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        res = undefined;
      }
      let method: "HEAD" | "GET" = "HEAD";
      if (!res || !isRedirect(res.status) || !res.headers.get("location")) {
        await res?.body?.cancel().catch(() => undefined);
        res = await request(url, "GET");
        method = "GET";
      }
      hops.push({ url: current, status: res.status, method });
      const location = res.headers.get("location");

      if (isRedirect(res.status) && location) {
        await res.body?.cancel().catch(() => undefined);
        if (++redirects > deps.maxRedirects) {
          page.truncated_chain = true;
          break;
        }
        next(location);
        continue;
      }

      page.final_status = res.status;
      delete page.title;
      delete page.favicon_url;
      delete page.content_type;
      const contentType = res.headers.get("content-type") ?? undefined;
      if (contentType) page.content_type = contentType;
      if (!contentType || /html|xml|text\/plain/i.test(contentType)) {
        const html = await readCapped(res, deps.maxBodyBytes);
        const facts = extractPageFacts(html, current);
        page.has_password_field = facts.has_password_field;
        if (facts.title) page.title = facts.title;
        if (facts.favicon_url) page.favicon_url = facts.favicon_url;
        if (facts.meta_refresh && facts.meta_refresh !== current) {
          if (++redirects > deps.maxRedirects) {
            page.truncated_chain = true;
            break;
          }
          next(facts.meta_refresh);
          continue;
        }
      } else {
        await res.body?.cancel().catch(() => undefined);
      }
      break;
    }
  } catch (e) {
    if (e instanceof SsrfError) {
      // Keep the refused URL in the chain (it is evidence); final_url is the last page actually fetched.
      page.refused = e.message;
      const lastFetched = hops[hops.length - 1]?.url;
      return { page, chain, ...(lastFetched ? { final_url: lastFetched } : {}) };
    }
    return { page, chain, error: errorMessage(e) };
  }
  return { page, chain, final_url: current };
}
