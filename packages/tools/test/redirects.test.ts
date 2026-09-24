import { describe, expect, it, vi } from "vitest";
import { extractPageFacts, followRedirects } from "../src/checks/redirects.js";
import { resolveDeps } from "../src/deps.js";
import type { CheckContext, PageResult } from "../src/types.js";
import { fakeLookup, html, redirect, routeFetch, testDeps } from "./helpers.js";

const lookup = fakeLookup({
  "start.example.com": ["93.184.215.14"],
  "mid.example.net": ["93.184.215.15"],
  "end.example.org": ["2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
  "loop.example.com": ["93.184.215.16"],
});

function ctx(fetch: ReturnType<typeof routeFetch>, over = {}): CheckContext {
  return { deps: resolveDeps(testDeps({ fetch, lookup, ...over })) };
}

describe("followRedirects", () => {
  it("follows a multi-hop chain and records statuses, title, password field, favicon", async () => {
    const fetch = routeFetch({
      "HEAD https://start.example.com/": redirect("https://mid.example.net/r?x=1", 301),
      "HEAD https://mid.example.net/r?x=1": redirect("/landing#frag", 302),
      "HEAD https://mid.example.net/landing": redirect("https://end.example.org/login", 307),
      "HEAD https://end.example.org/login": new Response(null, { status: 200, headers: { "content-type": "text/html" } }),
      "GET https://end.example.org/login": html(
        `<html><head><title> Sign in &amp; verify </title><link rel="shortcut icon" href="/static/fav.png"></head>
         <body><form><input type="email"><input name=p type=password></form></body></html>`,
      ),
    });
    const r = await followRedirects("https://start.example.com/", ctx(fetch));
    expect(r.error).toBeUndefined();
    expect(r.chain).toEqual([
      "https://start.example.com/",
      "https://mid.example.net/r?x=1",
      "https://mid.example.net/landing",
      "https://end.example.org/login",
    ]);
    expect(r.final_url).toBe("https://end.example.org/login");
    expect(r.page.hops.map((h) => [h.status, h.method])).toEqual([
      [301, "HEAD"],
      [302, "HEAD"],
      [307, "HEAD"],
      [200, "GET"],
    ]);
    expect(r.page).toMatchObject({ final_status: 200, title: "Sign in & verify", has_password_field: true, favicon_url: "https://end.example.org/static/fav.png" });
  });

  it("falls back to GET when HEAD fails or is rejected", async () => {
    const fetch = routeFetch({
      "HEAD https://start.example.com/": () => Promise.reject(new TypeError("socket hang up")),
      "GET https://start.example.com/": redirect("https://end.example.org/"),
      "HEAD https://end.example.org/": new Response(null, { status: 405 }),
      "GET https://end.example.org/": html("<title>Done</title>"),
    });
    const r = await followRedirects("https://start.example.com/", ctx(fetch));
    expect(r.page.hops.map((h) => h.method)).toEqual(["GET", "GET"]);
    expect(r.final_url).toBe("https://end.example.org/");
    expect(r.page.title).toBe("Done");
    expect(r.page.has_password_field).toBe(false);
    expect(r.page.favicon_url).toBe("https://end.example.org/favicon.ico");
  });

  it("follows meta refresh as a hop", async () => {
    const fetch = routeFetch({
      "https://start.example.com/": html(`<meta http-equiv="refresh" content="0; url='https://end.example.org/x'">`),
      "https://end.example.org/x": html("<title>Final</title>"),
    });
    const r = await followRedirects("https://start.example.com/", ctx(fetch));
    expect(r.chain).toEqual(["https://start.example.com/", "https://end.example.org/x"]);
    expect(r.page.title).toBe("Final");
  });

  it("stops after 10 redirects", async () => {
    let n = 0;
    const fetch = routeFetch({});
    fetch.mockImplementation(async () => redirect(`https://loop.example.com/${++n}`));
    const r = await followRedirects("https://loop.example.com/0", ctx(fetch));
    expect(r.page.truncated_chain).toBe(true);
    expect(r.page.hops).toHaveLength(11);
    expect(r.chain).toHaveLength(11);
    expect(r.page.final_status).toBeUndefined();
  });

  it("honours a lower maxRedirects", async () => {
    let n = 0;
    const fetch = routeFetch({});
    fetch.mockImplementation(async () => redirect(`https://loop.example.com/${++n}`));
    const r = await followRedirects("https://loop.example.com/0", ctx(fetch, { maxRedirects: 2 }));
    expect(r.page.truncated_chain).toBe(true);
    expect(r.chain).toHaveLength(3);
  });

  it("reads at most 64 KB of the body", async () => {
    const big = `<title>t</title>${"a".repeat(70 * 1024)}<input type="password">`;
    const fetch = routeFetch({ "https://start.example.com/": html(big) });
    const r = await followRedirects("https://start.example.com/", ctx(fetch));
    expect(r.page.title).toBe("t");
    expect(r.page.has_password_field).toBe(false);
  });

  it("times out a hanging hop and reports the error", async () => {
    const fetch = routeFetch({});
    fetch.mockImplementation(
      (_url: string, init: RequestInit = {}) =>
        new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    );
    const r = await followRedirects("https://start.example.com/", ctx(fetch, { timeoutMs: 20 }));
    expect(r.error).toBe("timed out");
    expect(r.final_url).toBeUndefined();
  });

  it("does not read non-HTML bodies", async () => {
    const body = new Response("binary", { headers: { "content-type": "application/octet-stream" } });
    const fetch = routeFetch({ "https://start.example.com/": body });
    const r = await followRedirects("https://start.example.com/", ctx(fetch));
    expect((r.page as PageResult).content_type).toBe("application/octet-stream");
    expect(r.page.title).toBeUndefined();
  });

  it("uses manual redirect mode", async () => {
    const fetch = routeFetch({ "https://start.example.com/": html("") });
    await followRedirects("https://start.example.com/", ctx(fetch));
    for (const [, init] of fetch.mock.calls) expect((init as RequestInit).redirect).toBe("manual");
    expect(vi.isMockFunction(fetch)).toBe(true);
  });
});

describe("extractPageFacts", () => {
  it("ignores non-http favicon and refresh targets", () => {
    const f = extractPageFacts(`<link rel="icon" href="javascript:alert(1)"><meta http-equiv="refresh" content="0;url=data:text/html,x">`, "https://a.example.com/p");
    expect(f.favicon_url).toBe("https://a.example.com/favicon.ico");
    expect(f.meta_refresh).toBeUndefined();
  });
});
