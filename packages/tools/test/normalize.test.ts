import { describe, expect, it } from "vitest";
import { HEURISTIC_CODES, normalizeUrl, sortHeuristics } from "../src/checks/normalize.js";

const h = (url: string) => normalizeUrl(url).heuristics;

describe("normalizeUrl", () => {
  it("lowercases host, strips fragment, keeps path and query", () => {
    const n = normalizeUrl("HTTPS://WWW.Example.COM/Path?q=1#section");
    expect(n.href).toBe("https://www.example.com/Path?q=1");
    expect(n.host).toBe("www.example.com");
    expect(n.registrable).toBe("example.com");
    expect(n.subdomain).toBe("www");
    expect(n.heuristics).toEqual([]);
  });

  it("treats bare domains and host:port as https", () => {
    expect(normalizeUrl("paypal.com/login").href).toBe("https://paypal.com/login");
    expect(normalizeUrl("example.com:8080/x").href).toBe("https://example.com:8080/x");
  });

  it("extracts registrable domain across multi-label public suffixes", () => {
    const n = normalizeUrl("https://login.secure.bank.example.co.uk/");
    expect(n.registrable).toBe("example.co.uk");
    expect(n.public_suffix).toBe("co.uk");
  });

  it("keeps punycode for lookups but decodes for display", () => {
    const n = normalizeUrl("https://pаypal.com/"); // Cyrillic a
    expect(n.host).toBe("xn--pypal-4ve.com");
    expect(n.href).toBe("https://xn--pypal-4ve.com/");
    expect(n.host_unicode).toBe("pаypal.com");
    expect(n.display_url).toBe("https://pаypal.com/");
    expect(n.heuristics).toEqual(expect.arrayContaining(["punycode_host", "mixed_script_host"]));
  });

  it("detects IP-literal hosts, including obfuscated and private ones", () => {
    expect(h("http://93.184.215.14/")).toEqual(["plain_http", "ip_literal_host"]);
    const n = normalizeUrl("http://0x7f.1/");
    expect(n.host).toBe("127.0.0.1");
    expect(n.is_private_ip).toBe(true);
    expect(n.heuristics).toEqual(expect.arrayContaining(["ip_literal_host", "private_ip_host"]));
    expect(h("https://[::1]/")).toEqual(expect.arrayContaining(["ip_literal_host", "private_ip_host"]));
  });

  it("detects @ userinfo tricks", () => {
    const n = normalizeUrl("https://www.paypal.com@evil-host.com/login");
    expect(n.host).toBe("evil-host.com");
    expect(n.registrable).toBe("evil-host.com");
    expect(n.heuristics).toContain("userinfo_in_url");
  });

  it("detects excessive subdomains, suspicious TLDs, and credential keywords", () => {
    expect(h("https://a.b.c.example.com/")).toContain("excessive_subdomains");
    expect(h("https://www.a.b.example.com/")).not.toContain("excessive_subdomains");
    expect(h("https://prize.xyz/")).toContain("suspicious_tld");
    expect(h("https://example.com/account/verify?x=1")).toContain("credential_keywords_in_path");
    expect(h("https://secure-login.example.com/")).toContain("credential_keywords_in_host");
    expect(h("https://example.com/blog/cats")).toEqual([]);
  });

  it("detects URL shorteners", () => {
    const n = normalizeUrl("http://bit.ly/3xyz");
    expect(n.is_shortener).toBe(true);
    expect(n.heuristics).toEqual(["plain_http", "url_shortener"]);
    expect(h("https://tinyurl.com/abc")).toContain("url_shortener");
  });

  it("detects hex and base64 blobs and embedded emails", () => {
    expect(h("https://example.com/t/0123456789abcdef0123456789abcdef")).toContain("hex_blob_in_url");
    expect(h("https://example.com/?d=QWxhZGRpbjpvcGVuIHNlc2FtZVRoaXNJc0FMb25nQmxvYjEyMw")).toContain("base64_blob_in_url");
    expect(h("https://example.com/?e=victim@example.org")).toContain("email_in_url");
    expect(h("https://example.com/?e=am9obkBleGFtcGxlLmNvbQ==")).toContain("email_in_url");
  });

  it("detects port oddities and non-http schemes", () => {
    expect(h("https://example.com:8443/")).toContain("nonstandard_port");
    expect(h("https://example.com:443/")).not.toContain("nonstandard_port");
    expect(h("javascript:alert(1)")).toContain("non_http_scheme");
    expect(h("data:text/html,<script>alert(1)</script>")).toContain("non_http_scheme");
  });

  it("throws on unparseable input", () => {
    expect(() => normalizeUrl("https://exa mple.com:99999/")).toThrow();
  });

  it("emits only known codes in a stable order", () => {
    const codes = h("http://user@a.b.c.secure-login.xyz:81/verify/0123456789abcdef0123456789abcdef");
    for (const c of codes) expect(Object.keys(HEURISTIC_CODES)).toContain(c);
    expect(codes).toEqual(sortHeuristics(codes));
  });
});
