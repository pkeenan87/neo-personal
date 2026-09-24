import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { VerdictSchema, summarizeVerdict, verdictJsonSchema, verdictSeverityRank, type Verdict } from "../src/index.js";

const malicious: Verdict = {
  subject_type: "url",
  verdict: "malicious",
  confidence: 0.92,
  headline: "This link imitates PayPal and asks for your password on a domain registered 3 days ago.",
  indicators: [
    { severity: "high", category: "lookalike_domain", evidence: "paypa1-secure-login.com", explanation: "Uses the digit 1 in place of the letter l to imitate paypal.com." },
    { severity: "critical", category: "credential_form", evidence: "password field on final page", explanation: "The page asks for a password on a domain that is not PayPal." },
    { severity: "medium", category: "young_domain", evidence: "registered 3 days ago", explanation: "Phishing domains are usually brand new." },
  ],
  recommended_actions: [
    { action: "Do not enter any information on this page.", urgency: "now" },
    { action: "If you already entered your password, change it at paypal.com.", urgency: "now", deep_link: "https://www.paypal.com/myaccount/security" },
  ],
  iocs: { urls: ["https://paypa1-secure-login.com/verify"], domains: ["paypa1-secure-login.com"], ips: ["203.0.113.7"], hashes: [], phone_numbers: [] },
  raw_ref: "art_123",
};

const safe: Verdict = {
  subject_type: "url",
  verdict: "likely_safe",
  confidence: 0.8,
  headline: "example.com is a long-standing reserved domain with no threat reports.",
  indicators: [],
  recommended_actions: [],
  iocs: { urls: [], domains: [], ips: [], hashes: [], phone_numbers: [] },
};

describe("VerdictSchema", () => {
  it("accepts fixtures", () => {
    expect(VerdictSchema.parse(malicious)).toEqual(malicious);
    expect(VerdictSchema.parse(safe)).toEqual(safe);
  });

  it("rejects out-of-range confidence", () => {
    expect(VerdictSchema.safeParse({ ...safe, confidence: 1.2 }).success).toBe(false);
    expect(VerdictSchema.safeParse({ ...safe, confidence: -0.1 }).success).toBe(false);
    expect(VerdictSchema.safeParse({ ...safe, confidence: "high" }).success).toBe(false);
  });

  it("rejects unknown enum values and extra keys", () => {
    expect(VerdictSchema.safeParse({ ...safe, verdict: "fine" }).success).toBe(false);
    expect(VerdictSchema.safeParse({ ...safe, extra: 1 }).success).toBe(false);
    expect(VerdictSchema.safeParse({ ...safe, iocs: { ...safe.iocs, emails: [] } }).success).toBe(false);
  });
});

describe("verdictJsonSchema", () => {
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(verdictJsonSchema);

  it("is a valid JSON schema that accepts fixtures (round-trip)", () => {
    const roundTripped = JSON.parse(JSON.stringify(malicious)) as unknown;
    expect(validate(roundTripped)).toBe(true);
    expect(VerdictSchema.parse(roundTripped)).toEqual(malicious);
    expect(validate(safe)).toBe(true);
  });

  it("rejects extra properties at every level", () => {
    expect(validate({ ...safe, extra: true })).toBe(false);
    expect(validate({ ...malicious, indicators: [{ ...malicious.indicators[0], x: 1 }] })).toBe(false);
    expect(validate({ ...safe, iocs: { ...safe.iocs, x: [] } })).toBe(false);
  });

  it("has additionalProperties:false on every object and no unsupported keywords", () => {
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== "object") return;
      const o = n as Record<string, unknown>;
      if (o.type === "object") expect(o.additionalProperties).toBe(false);
      for (const k of ["minimum", "maximum", "minLength", "$schema"]) expect(o).not.toHaveProperty(k);
      Object.values(o).forEach(walk);
    };
    walk(verdictJsonSchema);
  });
});

describe("helpers", () => {
  it("summarizeVerdict is one line", () => {
    const s = summarizeVerdict(malicious);
    expect(s).toBe("[MALICIOUS 92%] url: This link imitates PayPal and asks for your password on a domain registered 3 days ago. (3 indicators, top: critical credential_form)");
    expect(s).not.toContain("\n");
    expect(summarizeVerdict(safe)).toBe("[LIKELY SAFE 80%] url: example.com is a long-standing reserved domain with no threat reports.");
  });

  it("verdictSeverityRank orders verdicts and severities", () => {
    expect(verdictSeverityRank(malicious)).toBeGreaterThan(verdictSeverityRank(safe));
    expect(verdictSeverityRank("suspicious")).toBeGreaterThan(verdictSeverityRank("insufficient_evidence"));
    expect(verdictSeverityRank("insufficient_evidence")).toBeGreaterThan(verdictSeverityRank("likely_safe"));
    expect(verdictSeverityRank("critical")).toBeGreaterThan(verdictSeverityRank("high"));
    expect(verdictSeverityRank("low")).toBe(1);
  });
});
