import { describe, expect, it } from "vitest";
import { analyzeEmail } from "../src/email/analyzeEmail.js";
import { parseEventTime, parseSigninAlert } from "../src/signin/parse.js";
import { SIGNIN_ALERT_DOMAINS, SIGNIN_ALERT_SENDERS } from "../src/signin/providers.js";
import { SIGNIN_ALERT_TEMPLATES } from "../src/signin/index.js";
import { buildMessage, CASES, genuine, NEGATIVES, PROVIDER_FROM } from "./fixtures/signin/cases.js";

const MOCK = { mock: true, env: {} };
const analyze = (raw: string) => analyzeEmail({ raw }, { deps: MOCK });

describe("sign-in alert templates", () => {
  it("covers every provider and keeps every template unverified by default", () => {
    expect(new Set(SIGNIN_ALERT_TEMPLATES.map((t) => t.provider))).toEqual(new Set(["google", "microsoft", "apple", "meta", "amazon", "paypal"]));
    expect(SIGNIN_ALERT_TEMPLATES.every((t) => t.verified === false)).toBe(true);
    expect(CASES.map((c) => c.template).sort()).toEqual(SIGNIN_ALERT_TEMPLATES.map((t) => t.id).sort());
  });

  it("exports sender addresses/domains for every provider", () => {
    for (const p of Object.keys(SIGNIN_ALERT_DOMAINS) as (keyof typeof SIGNIN_ALERT_SENDERS)[]) {
      expect(SIGNIN_ALERT_SENDERS[p].length).toBeGreaterThan(0);
      const from = PROVIDER_FROM[p].match(/<([^>]+)>/)![1]!;
      expect(SIGNIN_ALERT_SENDERS[p]).toContain(from);
    }
  });

  it.each(CASES.map((c) => [c.template, c] as const))("%s: exact fields from a genuine-looking message", async (_id, c) => {
    const a = await analyze(genuine(c));
    const s = a.signin_alert;
    expect(s, "signin_alert").toBeDefined();
    expect(s!.template_id).toBe(c.template);
    expect(s!.provider).toBe(c.provider);
    expect(s!.event).toBe(c.event);
    expect(s!.device).toBe(c.expect.device);
    expect(s!.location).toBe(c.expect.location);
    expect(s!.ip_addresses).toEqual(c.expect.ip ?? []);
    expect(s!.event_time).toBe(c.expect.time);
    expect(s!.account_hint).toBe(c.expect.account_hint);
    expect(s!.warnings).toEqual(["template_unverified"]);
    expect(s!.analyzed_at).toBe(a.analyzed_at);
    expect(s!.evidence.length).toBeGreaterThan(0);
    // Normal analysis is preserved on the same message.
    expect(a.authentication.dkim).toBe("pass");
    expect(a.urls.length).toBe(1);
    // No full address, URL or code ever appears in the extracted facts.
    expect(JSON.stringify(s)).not.toMatch(/jordan@example\.com|https?:\/\//);
  });

  it("parses plain-text bodies the same way", async () => {
    const c = CASES[0]!;
    const a = await analyze(genuine(c, { html: false }));
    expect(a.signin_alert?.template_id).toBe(c.template);
    expect(a.signin_alert?.device).toBe("Windows");
  });

  it.each(NEGATIVES.map((n) => [n.name, n] as const))("returns null for %s", (_name, n) => {
    expect(parseSigninAlert({ subject: n.subject, body: n.body, analyzedAt: "x" })).toBeNull();
  });

  it("leaves the ordinary email path unchanged for non-alert mail", async () => {
    const a = await analyze(buildMessage({ from: "Sender <sender@example.org>", subject: "Hello", lines: ["Lunch on Friday?"], auth: "absent" }));
    expect(a.signin_alert).toBeUndefined();
    expect("signin_alert" in a).toBe(false);
  });

  it("takes IPs only from the event section, deduplicated and bounded", () => {
    const body = ["A new sign-in on Windows", "Your Google Account was signed in.", "IP address: 203.0.113.1", "IP: 203.0.113.1", "Also 203.0.113.2 and 203.0.113.3 and 203.0.113.4", "If this wasn't you, secure your account.", "IP address: 203.0.113.99"].join("\n");
    const s = parseSigninAlert({ subject: "Security alert", body, analyzedAt: "x" })!;
    expect(s.ip_addresses).toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3"]);
  });

  it("rejects out-of-range IPv4 and unlabelled IPv6/time lookalikes", () => {
    const body = "A new sign-in on Windows\nYour Google Account.\nVersion 999.1.1.1 at 12:00:00 and 10:20:30:40";
    expect(parseSigninAlert({ subject: "Security alert", body, analyzedAt: "x" })!.ip_addresses).toEqual([]);
  });

  describe("time", () => {
    it("normalizes only unambiguous zones to UTC", () => {
      expect(parseEventTime("January 15, 2026 at 12:00 PM UTC")).toBe("2026-01-15T12:00:00.000Z");
      expect(parseEventTime("2026-01-15 04:00 -08:00")).toBe("2026-01-15T12:00:00.000Z");
      expect(parseEventTime("Jan 15, 2026, 12:00 AM UTC")).toBe("2026-01-15T00:00:00.000Z");
      expect(parseEventTime("2026-01-15T12:00:00Z")).toBe("2026-01-15T12:00:00.000Z");
    });
    it("omits ambiguous or invalid times", () => {
      expect(parseEventTime("January 15, 2026 at 12:00 PM PST")).toBeUndefined();
      expect(parseEventTime("January 15, 2026 at 12:00 PM")).toBeUndefined();
      expect(parseEventTime("February 31, 2026 at 12:00 PM UTC")).toBeUndefined();
      expect(parseEventTime("2026-01-15 25:00 UTC")).toBeUndefined();
    });
  });

  describe("sanitization", () => {
    const base = (device: string) =>
      parseSigninAlert({ subject: "Security alert", body: `A new sign-in on ${device}\nYour Google Account was signed in.\nLocation: ${device.slice(0, 20)}\u202E${"B".repeat(100)}`, analyzedAt: "x" })!;
    it("strips control, bidi-override and zero-width characters and bounds length", () => {
      const s = base("Win\u202Edows\u200B\u0007 \u2066x\u2069" + "A".repeat(500));
      // eslint-disable-next-line no-control-regex
      expect(s.device).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u0000-\u0008\uFEFF]/);
      expect(s.device!.length).toBeLessThanOrEqual(80);
      expect(s.location!.length).toBeLessThanOrEqual(80);
      expect(s.location).not.toMatch(/[\u202A-\u202E\u200B]/);
    });
    it("drops values that carry links or addresses", () => {
      const s = parseSigninAlert({ subject: "Security alert", body: "A new sign-in on Windows\nYour Google Account.\nLocation: visit https://evil.example/x or mail a@evil.example", analyzedAt: "x" })!;
      expect(s.location).toBeUndefined();
    });
    it("omits the account hint when several addresses appear", () => {
      const s = parseSigninAlert({ subject: "Security alert", body: "A new sign-in on Windows\nYour Google Account a@example.com and b@example.com", analyzedAt: "x" })!;
      expect(s.account_hint).toBeUndefined();
    });
  });
});
