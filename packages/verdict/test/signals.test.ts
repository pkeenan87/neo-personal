import { describe, expect, it } from "vitest";
import { MAX_SIGNAL_BATCH, SignalEventSchema, isTechSupportScamHit, parseSignalEvent, type SignalEvent } from "../src/index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const RELATES_TO = "22222222-2222-4222-8222-222222222222";
const OBSERVED_AT = "2026-09-29T12:00:00Z";
const OBSERVED_AT_OFFSET = "2026-09-29T12:00:00+02:00";

const validEvents: Record<string, SignalEvent> = {
  tech_support_scam: {
    id: ID,
    type: "page",
    detector: "tech_support_scam",
    observedAt: OBSERVED_AT,
    domain: "paypa1-support.test",
    indicators: ["fullscreen", "support_phone_text"],
    phone: "+15551234567",
  },
  lookalike_login: {
    id: ID,
    type: "page",
    detector: "lookalike_login",
    observedAt: OBSERVED_AT,
    domain: "paypa1-login.test",
    brand: "paypal",
    indicators: ["password_field", "punycode"],
  },
  dangerous_site: {
    id: ID,
    type: "page",
    detector: "dangerous_site",
    observedAt: OBSERVED_AT,
    domain: "malware.test",
    source: "safe_browsing_prefix",
  },
  remote_tool_download: {
    id: ID,
    type: "page",
    detector: "remote_tool_download",
    observedAt: OBSERVED_AT,
    domain: "not-anydesk.test",
    toolId: "anydesk",
    fileName: "AnyDesk.exe",
  },
  warning_bypassed: {
    id: ID,
    type: "page",
    detector: "warning_bypassed",
    observedAt: OBSERVED_AT,
    relatesTo: RELATES_TO,
    domain: "malware.test",
  },
  remote_access_tool: {
    id: ID,
    type: "software",
    detector: "remote_access_tool",
    observedAt: OBSERVED_AT,
    toolId: "anydesk",
    name: "AnyDesk",
    publisher: "AnyDesk Software GmbH",
    version: "8.0.1",
  },
  unwanted_software: {
    id: ID,
    type: "software",
    detector: "unwanted_software",
    observedAt: OBSERVED_AT,
    name: "PC Optimizer Pro",
    publisher: "Systweak Software",
    reason: "publisher_list",
  },
  remote_access_session: {
    id: ID,
    type: "remote_session",
    detector: "remote_access_session",
    observedAt: OBSERVED_AT,
    toolId: "anydesk",
    direction: "incoming",
    peerId: "123 456 789",
  },
  tcc_grant: {
    id: ID,
    type: "permission",
    detector: "tcc_grant",
    observedAt: OBSERVED_AT,
    app: "AnyDesk",
    bundleId: "com.anydesk.anydesk",
    service: "screen_recording",
  },
};

describe("SignalEventSchema", () => {
  it("accepts one valid example of every detector", () => {
    for (const [detector, event] of Object.entries(validEvents)) {
      const result = SignalEventSchema.safeParse(event);
      expect(result.success, `${detector}: ${JSON.stringify(result.success ? null : result.error.issues)}`).toBe(true);
    }
  });

  it("accepts an offset observedAt as well as Z", () => {
    const event = { ...validEvents.dangerous_site, observedAt: OBSERVED_AT_OFFSET };
    expect(SignalEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects a domain with a path, query, port or userinfo", () => {
    const base = validEvents.dangerous_site;
    for (const domain of ["evil.test/path", "evil.test?q=1", "evil.test:8080", "user@evil.test", "evil.test#frag"]) {
      expect(SignalEventSchema.safeParse({ ...base, domain }).success, domain).toBe(false);
    }
  });

  it("rejects an uppercase domain", () => {
    expect(SignalEventSchema.safeParse({ ...validEvents.dangerous_site, domain: "EVIL.test" }).success).toBe(false);
  });

  it("rejects whitespace in a domain", () => {
    expect(SignalEventSchema.safeParse({ ...validEvents.dangerous_site, domain: "evil .test" }).success).toBe(false);
  });

  it("accepts an IPv4 literal and a punycode domain", () => {
    expect(SignalEventSchema.safeParse({ ...validEvents.dangerous_site, domain: "203.0.113.7" }).success).toBe(true);
    expect(SignalEventSchema.safeParse({ ...validEvents.dangerous_site, domain: "xn--pypal-4ve.test" }).success).toBe(true);
  });

  it("rejects an oversize domain (over 253 chars)", () => {
    const long = `${"a".repeat(251)}.co`;
    expect(long.length).toBeGreaterThan(253);
    expect(SignalEventSchema.safeParse({ ...validEvents.dangerous_site, domain: long }).success).toBe(false);
  });

  it("rejects an oversize name/publisher/version/app (over 128 chars)", () => {
    const long = "a".repeat(129);
    expect(SignalEventSchema.safeParse({ ...validEvents.remote_access_tool, name: long }).success).toBe(false);
    expect(SignalEventSchema.safeParse({ ...validEvents.tcc_grant, app: long }).success).toBe(false);
  });

  it("rejects unknown fields (every variant is .strict())", () => {
    expect(SignalEventSchema.safeParse({ ...validEvents.dangerous_site, extra: "nope" }).success).toBe(false);
    expect(SignalEventSchema.safeParse({ ...validEvents.tech_support_scam, extra: "nope" }).success).toBe(false);
  });

  it("rejects a bad sha256", () => {
    const event = { ...validEvents.unwanted_software, reason: "unsigned_unknown", sha256: "not-a-hash" };
    expect(SignalEventSchema.safeParse(event).success).toBe(false);
    const upper = { ...validEvents.unwanted_software, reason: "unsigned_unknown", sha256: "A".repeat(64) };
    expect(SignalEventSchema.safeParse(upper).success).toBe(false);
    const ok = { ...validEvents.unwanted_software, reason: "unsigned_unknown", sha256: "0".repeat(64) };
    expect(SignalEventSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects a bad phone", () => {
    for (const phone of ["5551234567", "+0551234567", "+1555", "+1555abcdefg", "1-555-123-4567"]) {
      expect(SignalEventSchema.safeParse({ ...validEvents.tech_support_scam, phone }).success, phone).toBe(false);
    }
  });

  it("rejects a path in fileName", () => {
    for (const fileName of ["dir/AnyDesk.exe", "..\\AnyDesk.exe", "C:\\Users\\a\\AnyDesk.exe"]) {
      expect(SignalEventSchema.safeParse({ ...validEvents.remote_tool_download, fileName }).success, fileName).toBe(false);
    }
  });

  it("rejects duplicate indicator codes", () => {
    const event = { ...validEvents.tech_support_scam, indicators: ["fullscreen", "fullscreen"] };
    expect(SignalEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects empty indicators", () => {
    const event = { ...validEvents.tech_support_scam, indicators: [] };
    expect(SignalEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects an unknown indicator code", () => {
    const event = { ...validEvents.tech_support_scam, indicators: ["not_a_code"] };
    expect(SignalEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects a bad id and relatesTo", () => {
    expect(SignalEventSchema.safeParse({ ...validEvents.dangerous_site, id: "not-a-uuid" }).success).toBe(false);
    expect(SignalEventSchema.safeParse({ ...validEvents.warning_bypassed, relatesTo: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects a detector/type mismatch", () => {
    expect(SignalEventSchema.safeParse({ ...validEvents.dangerous_site, type: "software" }).success).toBe(false);
  });

  it("exposes MAX_SIGNAL_BATCH", () => {
    expect(MAX_SIGNAL_BATCH).toBe(50);
  });
});

describe("isTechSupportScamHit", () => {
  it("is false for a game page (fullscreen + pointer_lock, no text)", () => {
    expect(isTechSupportScamHit(["fullscreen", "pointer_lock"])).toBe(false);
  });

  it("is true for a text indicator plus one behaviour indicator", () => {
    expect(isTechSupportScamHit(["support_phone_text", "fullscreen"])).toBe(true);
  });

  it("is true for two text indicators", () => {
    expect(isTechSupportScamHit(["fake_scan", "support_phone_text"])).toBe(true);
  });

  it("is false for a single text indicator alone", () => {
    expect(isTechSupportScamHit(["support_phone_text"])).toBe(false);
    expect(isTechSupportScamHit(["fake_scan"])).toBe(false);
  });

  it("does not count duplicates twice", () => {
    expect(isTechSupportScamHit(["support_phone_text", "support_phone_text"])).toBe(false);
    expect(isTechSupportScamHit(["fullscreen", "fullscreen", "support_phone_text"])).toBe(true);
  });
});

describe("parseSignalEvent", () => {
  it("returns ok:true for a valid event", () => {
    const result = parseSignalEvent(validEvents.dangerous_site);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.id).toBe(ID);
  });

  it("returns the id for an invalid event with a valid id", () => {
    const result = parseSignalEvent({ ...validEvents.dangerous_site, domain: "EVIL.test" });
    expect(result).toEqual({ ok: false, id: ID, reason: "invalid" });
  });

  it("returns id: null when the id itself is missing or invalid", () => {
    expect(parseSignalEvent({ ...validEvents.dangerous_site, id: "not-a-uuid" })).toEqual({ ok: false, id: null, reason: "invalid" });
    expect(parseSignalEvent({ domain: "evil.test" })).toEqual({ ok: false, id: null, reason: "invalid" });
    expect(parseSignalEvent("not even an object")).toEqual({ ok: false, id: null, reason: "invalid" });
    expect(parseSignalEvent(null)).toEqual({ ok: false, id: null, reason: "invalid" });
  });
});
