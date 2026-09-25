import { describe, expect, it } from "vitest";
import { authHeuristics, evaluateAuthentication, parseAuthResultsValue } from "../src/email/auth.js";

const h = (name: string, value: string) => ({ name, value });
const received = (by: string) => h("Received", `from sender.example.org (sender.example.org [198.51.100.9]) by ${by} with ESMTPS id x; Mon, 12 Jan 2026 09:00:00 +0000`);

describe("parseAuthResultsValue", () => {
  it("reads authserv-id, methods, and properties; ignores comments", () => {
    const p = parseAuthResultsValue(
      "mx.google.com;\n dkim=pass header.i=@example.com header.s=s1 header.b=abc;\n spf=pass (google.com: domain of a@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=a@example.com;\n dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com",
    );
    expect(p.authservId).toBe("mx.google.com");
    expect(p.results).toEqual([
      { method: "dkim", result: "pass", props: { "header.i": "@example.com", "header.s": "s1", "header.b": "abc" } },
      { method: "spf", result: "pass", props: { "smtp.mailfrom": "a@example.com" } },
      { method: "dmarc", result: "pass", props: { "header.from": "example.com" } },
    ]);
  });

  it("handles Microsoft headers without an authserv-id and with compauth", () => {
    const p = parseAuthResultsValue(
      "spf=pass (sender IP is 192.0.2.7) smtp.mailfrom=example.com; dkim=pass (signature was verified) header.d=example.com;dmarc=pass action=none header.from=example.com;compauth=pass reason=100",
    );
    expect(p.authservId).toBeUndefined();
    expect(p.results.map((r) => `${r.method}=${r.result}`)).toEqual(["spf=pass", "dkim=pass", "dmarc=pass", "compauth=pass"]);
  });

  it("tolerates results that are not separated by semicolons", () => {
    const p = parseAuthResultsValue("mx.example.com; spf=fail smtp.mailfrom=x@example.net dkim=none dmarc=fail header.from=example.com");
    expect(p.results.map((r) => r.method)).toEqual(["spf", "dkim", "dmarc"]);
  });
});

describe("evaluateAuthentication", () => {
  it("Google: pass and aligned", () => {
    const a = evaluateAuthentication(
      [
        received("mx.google.com"),
        h("Authentication-Results", "mx.google.com; dkim=pass header.i=@github.com header.s=pf2023; spf=pass smtp.mailfrom=noreply@github.com; dmarc=pass (p=REJECT) header.from=github.com"),
      ],
      "github.com",
    );
    expect(a).toEqual({ spf: "pass", dkim: "pass", dkim_domains: ["github.com"], dmarc: "pass", aligned: true, source: "authentication_results", evaluated_by: "mx.google.com" });
  });

  it("Microsoft: compauth is reported, no evaluated_by", () => {
    const a = evaluateAuthentication(
      [
        received("BN8NAM12FT012.mail.protection.outlook.com"),
        h("Authentication-Results", "spf=fail (sender IP is 203.0.113.5) smtp.mailfrom=example.com; dkim=none (message not signed) header.d=none;dmarc=fail action=quarantine header.from=example.com;compauth=fail reason=000"),
      ],
      "example.com",
    );
    expect(a).toMatchObject({ spf: "fail", dkim: "none", dmarc: "fail", aligned: false, compauth: "fail", source: "authentication_results" });
    expect(a.evaluated_by).toBeUndefined();
    expect(authHeuristics(a, "example.com", true)).toEqual(["spf_fail", "dmarc_fail"]);
  });

  it("Yahoo: relaxed alignment on a DKIM subdomain", () => {
    const a = evaluateAuthentication(
      [
        received("atlas-production.v2.mail.yahoo.com"),
        h("Authentication-Results", "atlas-production.v2.mail.yahoo.com; dkim=pass header.i=@mail.example.com header.s=s2048; spf=pass smtp.mailfrom=bounces.example-esp.net; dmarc=pass(p=REJECT) header.from=example.com;"),
      ],
      "example.com",
    );
    expect(a).toMatchObject({ spf: "pass", dkim: "pass", dkim_domains: ["mail.example.com"], dmarc: "pass", aligned: true, evaluated_by: "atlas-production.v2.mail.yahoo.com" });
    expect(authHeuristics(a, "example.com", true)).toEqual([]);
  });

  it("Apple iCloud: merges one provider's per-method headers", () => {
    const a = evaluateAuthentication(
      [
        received("mx01.mail.icloud.com"),
        h("Authentication-Results", "bimi.icloud.com; bimi=skipped reason=insufficient"),
        h("Authentication-Results", "dmarc.icloud.com; dmarc=pass header.from=example.com"),
        h("Authentication-Results", "dkim-verifier.icloud.com; dkim=pass (2048-bit key) header.d=example.com header.i=@example.com header.b=x"),
        h("Authentication-Results", "spf.icloud.com; spf=pass (spf.icloud.com: domain of a@example.com designates 192.0.2.3 as permitted sender) smtp.mailfrom=a@example.com"),
        h("Authentication-Results", "attacker.example.net; dkim=pass header.d=example.com; spf=pass; dmarc=pass"),
      ],
      "example.com",
    );
    expect(a).toMatchObject({ spf: "pass", dkim: "pass", dmarc: "pass", aligned: true, evaluated_by: "bimi.icloud.com" });
  });

  it("prefers the receiving provider's header and never sums across authserv-ids", () => {
    const a = evaluateAuthentication(
      [
        received("mx.example.com"),
        h("Authentication-Results", "relay.example.net; spf=pass smtp.mailfrom=example.org; dkim=pass header.d=example.org; dmarc=pass header.from=example.org"),
        h("Authentication-Results", "mx.example.com; spf=fail smtp.mailfrom=example.org; dkim=fail header.d=example.org; dmarc=fail header.from=example.org"),
        h("Authentication-Results", "mx.example.com; dkim=pass header.d=example.org"),
      ],
      "example.org",
    );
    expect(a).toMatchObject({ spf: "fail", dkim: "fail", dmarc: "fail", aligned: false, evaluated_by: "mx.example.com" });
  });

  it("falls back to the newest ARC-Authentication-Results", () => {
    const a = evaluateAuthentication(
      [
        h("ARC-Authentication-Results", "i=2; mx.example.com; spf=fail smtp.mailfrom=list.example.org; dkim=pass header.d=example.com; dmarc=pass header.from=example.com"),
        h("ARC-Authentication-Results", "i=1; mx.google.com; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com"),
      ],
      "example.com",
    );
    expect(a).toMatchObject({ source: "arc", evaluated_by: "mx.example.com", spf: "fail", dkim: "pass", dmarc: "pass", aligned: true });
  });

  it("falls back to Received-SPF plus DKIM-Signature (a signature alone is not a pass)", () => {
    const a = evaluateAuthentication(
      [
        h("Received-SPF", "Pass (mailfrom) identity=mailfrom; client-ip=192.0.2.9; helo=mail.example.com; envelope-from=bounce@example.com; receiver=mx.neo.test"),
        h("DKIM-Signature", "v=1; a=rsa-sha256; d=example.com; s=s1; bh=x; b=y"),
      ],
      "example.com",
    );
    expect(a).toEqual({ spf: "pass", dkim: "none", dkim_domains: ["example.com"], dmarc: "absent", aligned: true, source: "received_spf_and_dkim_signature" });
  });

  it("absent headers are absent, not failures", () => {
    const a = evaluateAuthentication([received("mx.example.com"), h("Subject", "hi")], "example.com");
    expect(a).toEqual({ spf: "absent", dkim: "absent", dkim_domains: [], dmarc: "absent", aligned: null, source: "none" });
    expect(authHeuristics(a, "example.com", true)).toEqual(["auth_absent"]);
    expect(authHeuristics(a, "example.com", false)).toEqual([]);
  });

  it("flags DKIM that passes only for an unrelated domain", () => {
    const a = evaluateAuthentication(
      [h("Authentication-Results", "mx.example.com; spf=softfail smtp.mailfrom=esp.example.net; dkim=pass header.d=esp.example.net; dmarc=none header.from=example.org")],
      "example.org",
    );
    expect(a).toMatchObject({ spf: "softfail", dkim: "pass", dmarc: "none", aligned: false });
    expect(authHeuristics(a, "example.org", true)).toEqual(["spf_softfail", "unaligned_dkim"]);
  });
});
