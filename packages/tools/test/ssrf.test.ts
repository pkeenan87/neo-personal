import { describe, expect, it } from "vitest";
import { analyzeUrl } from "../src/analyzeUrl.js";
import { assertPublicHost, blockedAddressReason, blockedHostnameReason, SsrfError } from "../src/checks/ssrf.js";
import { fakeLookup, fakeTls, html, redirect, routeFetch, testDeps } from "./helpers.js";

describe("blockedAddressReason", () => {
  it.each([
    "127.0.0.1", "127.8.9.10", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "100.127.255.255", "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.250", "255.255.255.255", "240.0.0.1", "192.0.2.10",
    "::", "::1", "fe80::1", "fe80::1%eth0", "fc00::1", "fd12:3456:789a::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "::ffff:192.168.0.1", "64:ff9b::a9fe:a9fe", "2002:c0a8:0101::1", "2001:db8::1", "[::1]",
  ])("blocks %s", (ip) => {
    expect(blockedAddressReason(ip)).not.toBeNull();
  });

  it.each(["93.184.215.14", "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2a00:1450:4001::200e"])(
    "allows public %s",
    (ip) => {
      expect(blockedAddressReason(ip)).toBeNull();
    },
  );

  it("blocks local hostnames without resolving", () => {
    expect(blockedHostnameReason("localhost")).not.toBeNull();
    expect(blockedHostnameReason("printer.local")).not.toBeNull();
    expect(blockedHostnameReason("metadata.google.internal")).not.toBeNull();
    expect(blockedHostnameReason("intranet")).not.toBeNull();
    expect(blockedHostnameReason("example.com")).toBeNull();
  });
});

describe("assertPublicHost", () => {
  it("refuses a hostname if any resolved address is private", async () => {
    const lookup = fakeLookup({ "rebind.example.com": ["93.184.215.14", "10.0.0.5"] });
    await expect(assertPublicHost("rebind.example.com", lookup)).rejects.toBeInstanceOf(SsrfError);
  });

  it("returns addresses for public hosts", async () => {
    const lookup = fakeLookup({ "example.com": ["93.184.215.14"] });
    await expect(assertPublicHost("example.com", lookup)).resolves.toEqual([{ address: "93.184.215.14", family: 4 }]);
  });
});

describe("analyzeUrl SSRF guard", () => {
  it("refuses a private IP literal without any network access", async () => {
    const fetch = routeFetch({});
    const lookup = fakeLookup({});
    const tlsConnect = fakeTls();
    const a = await analyzeUrl("https://192.168.1.1/admin", { deps: testDeps({ fetch, lookup, tlsConnect }) });
    expect(fetch).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(tlsConnect).not.toHaveBeenCalled();
    expect(a.heuristics).toEqual(expect.arrayContaining(["ip_literal_host", "private_ip_host", "ssrf_refused"]));
    expect(a.page).toMatchObject({ refused: expect.stringContaining("192.168.1.1") });
    expect(a.final_url).toBeUndefined();
    expect(a.tls).toEqual({ skipped: "ssrf_refused" });
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const fetch = routeFetch({});
    const lookup = fakeLookup({ "internal.attacker.com": ["127.0.0.1"] });
    const a = await analyzeUrl("https://internal.attacker.com/", { deps: testDeps({ fetch, lookup, env: {} }) });
    expect(fetch).not.toHaveBeenCalledWith("https://internal.attacker.com/", expect.anything());
    expect(a.heuristics).toContain("ssrf_refused");
    expect((a.page as { refused?: string }).refused).toMatch(/resolves to 127\.0\.0\.1/);
  });

  it("refuses a redirect into a private IP and keeps it in the chain as evidence", async () => {
    const fetch = routeFetch({
      "HEAD https://hop.example.com/": redirect("http://169.254.169.254/latest/meta-data/"),
    });
    const lookup = fakeLookup({ "hop.example.com": ["93.184.215.14"] });
    const a = await analyzeUrl("https://hop.example.com/", { deps: testDeps({ fetch, lookup }) });
    const pageCalls = fetch.mock.calls.filter(([u]) => !String(u).startsWith("https://rdap.org/"));
    expect(pageCalls).toHaveLength(1);
    expect(a.redirect_chain).toEqual(["https://hop.example.com/", "http://169.254.169.254/latest/meta-data/"]);
    expect(a.final_url).toBe("https://hop.example.com/");
    expect(a.heuristics).toContain("ssrf_refused");
    expect(a.errors.join()).toMatch(/169\.254\.169\.254/);
  });

  it("re-resolves on every hop (redirect to a hostname that resolves privately)", async () => {
    const fetch = routeFetch({ "HEAD https://a.example.com/": redirect("https://b.example.net/x") });
    const lookup = fakeLookup({ "a.example.com": ["93.184.215.14"], "b.example.net": ["fd00::7"] });
    const a = await analyzeUrl("https://a.example.com/", { deps: testDeps({ fetch, lookup }) });
    expect(lookup).toHaveBeenCalledWith("b.example.net");
    expect(a.heuristics).toContain("ssrf_refused");
  });

  it("refuses non-http(s) schemes, both as input and as a redirect target", async () => {
    const fetch = routeFetch({ "HEAD https://c.example.com/": redirect("file:///etc/passwd") });
    const lookup = fakeLookup({ "c.example.com": ["93.184.215.14"] });
    const js = await analyzeUrl("javascript:alert(document.cookie)", { deps: testDeps({ fetch, lookup }) });
    expect(js.heuristics).toContain("non_http_scheme");
    expect(js.page).toEqual({ skipped: "not_applicable" });
    expect(fetch).not.toHaveBeenCalled();

    const a = await analyzeUrl("https://c.example.com/", { deps: testDeps({ fetch, lookup }) });
    expect(a.redirect_chain).toContain("file:///etc/passwd");
    expect((a.page as { refused?: string }).refused).toMatch(/scheme file:/);
  });

  it("does not forward userinfo credentials when fetching", async () => {
    const fetch = routeFetch({ "https://evil-host.com/": html("<title>x</title>") });
    const lookup = fakeLookup({ "evil-host.com": ["93.184.215.14"] });
    await analyzeUrl("https://user:secret@evil-host.com/", { deps: testDeps({ fetch, lookup }) });
    for (const call of fetch.mock.calls) expect(String(call[0])).not.toContain("secret");
  });
});
