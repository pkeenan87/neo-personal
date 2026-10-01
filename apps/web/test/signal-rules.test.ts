// @vitest-environment node
/**
 * Table-driven tests for lib/server/signals/rules.ts (_specs/signals.md "Rules"): pure
 * functions of one event, the device's expected tools, and recent signals. Covers each row of
 * the spec's rules table, the fail-open branches, expected-tools/peer handling,
 * `warning_bypassed`, and the scam-in-progress correlation (both orders, and outside the
 * 30-minute window).
 */
import type { ExpectedToolRow, SignalOutcome, SignalSeverity } from "@neo/db";
import type { SignalEvent } from "@neo/verdict";
import { describe, expect, it } from "vitest";
import {
  bumpSeverity,
  evaluateEvent,
  findScamInProgress,
  thirtyMinuteBucket,
  type CorrelationEvent,
  type RuleContext,
  type RuleSignalRef,
} from "@/lib/server/signals/rules";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function ctx(overrides: Partial<RuleContext> = {}): RuleContext {
  return { expectedTools: [], recentUserSignals: [], isOwnerDevice: false, ...overrides };
}

function expectedTool(toolId: string, peerIds: string[] = []): ExpectedToolRow {
  return { deviceId: "device-1", toolId, peerIds, createdBy: "user-1", createdAt: NOW };
}

function signalRef(overrides: Partial<RuleSignalRef>): RuleSignalRef {
  return {
    id: uuid(1),
    clientEventId: uuid(2),
    detector: "tech_support_scam",
    severity: null,
    outcome: "recorded" as SignalOutcome,
    verdictId: null,
    observedAt: NOW,
    deviceId: "device-1",
    ...overrides,
  };
}

describe("tech_support_scam", () => {
  const base = { id: uuid(10), type: "page" as const, detector: "tech_support_scam" as const, observedAt: NOW.toISOString() };

  it("2+ indicators → malicious/high/scam_page, alerted", () => {
    const event: SignalEvent = { ...base, domain: "scam.test", indicators: ["fullscreen", "fake_scan"] };
    const r = evaluateEvent(event, ctx());
    expect(r).toMatchObject({ outcome: "alerted", severity: "high", alertKind: "scam_page", verdictLabel: "malicious" });
  });

  it("support_phone_text + a lock indicator → malicious even with only 2 total", () => {
    const event: SignalEvent = { ...base, domain: "scam.test", indicators: ["support_phone_text", "keyboard_lock"] };
    const r = evaluateEvent(event, ctx());
    expect(r.outcome).toBe("alerted");
  });

  it("a single, non-lock indicator → recorded, no verdict or alert", () => {
    const event: SignalEvent = { ...base, domain: "scam.test", indicators: ["looping_audio"] };
    const r = evaluateEvent(event, ctx());
    expect(r).toMatchObject({ outcome: "recorded", severity: null, alertKind: null, verdictLabel: null });
  });

  it("a game page (fullscreen + pointer_lock + looping_audio, no text) → recorded, not alerted", () => {
    const event: SignalEvent = { ...base, domain: "game.test", indicators: ["fullscreen", "pointer_lock", "looping_audio"] };
    const r = evaluateEvent(event, ctx());
    expect(r).toMatchObject({ outcome: "recorded", severity: null, alertKind: null, verdictLabel: null });
  });
});

describe("lookalike_login / dangerous_site", () => {
  it("lookalike_login always escalates", () => {
    const event: SignalEvent = {
      id: uuid(11),
      type: "page",
      detector: "lookalike_login",
      observedAt: NOW.toISOString(),
      domain: "paypa1.test",
      brand: "paypal",
      indicators: ["lookalike_skeleton"],
    };
    const r = evaluateEvent(event, ctx());
    expect(r).toMatchObject({ outcome: "escalate", alertKind: "dangerous_site", severity: null, verdictLabel: null });
  });

  it("dangerous_site always escalates", () => {
    const event: SignalEvent = { id: uuid(12), type: "page", detector: "dangerous_site", observedAt: NOW.toISOString(), domain: "bad.test", source: "safe_browsing_prefix" };
    const r = evaluateEvent(event, ctx());
    expect(r).toMatchObject({ outcome: "escalate", alertKind: "dangerous_site" });
  });
});

describe("remote_tool_download", () => {
  const base = { id: uuid(13), type: "page" as const, detector: "remote_tool_download" as const, observedAt: NOW.toISOString(), toolId: "anydesk", fileName: "AnyDesk.exe" };

  it("official vendor domain → recorded", () => {
    const event: SignalEvent = { ...base, domain: "anydesk.com" };
    expect(evaluateEvent(event, ctx())).toMatchObject({ outcome: "recorded" });
  });

  it("off-vendor domain → suspicious/medium/remote_access, alerted", () => {
    const event: SignalEvent = { ...base, domain: "totally-not-anydesk.test" };
    expect(evaluateEvent(event, ctx())).toMatchObject({ outcome: "alerted", severity: "medium", alertKind: "remote_access", verdictLabel: "suspicious" });
  });
});

describe("warning_bypassed", () => {
  const relatesTo = uuid(20);
  const event: SignalEvent = { id: uuid(21), type: "page", detector: "warning_bypassed", observedAt: NOW.toISOString(), relatesTo, domain: "scam.test" };

  it("unknown relatesTo → rejected relates_to_unknown", () => {
    const r = evaluateEvent(event, ctx());
    expect(r).toMatchObject({ outcome: "rejected", rejectReason: "relates_to_unknown" });
  });

  it("known relatesTo → bumps the related severity one step and alerts with the related kind", () => {
    const related = signalRef({ clientEventId: relatesTo, detector: "tech_support_scam", severity: "high", outcome: "alerted", verdictId: uuid(22) });
    const r = evaluateEvent(event, ctx({ recentUserSignals: [related] }));
    expect(r).toMatchObject({ outcome: "alerted", severity: "critical", alertKind: "scam_page", bypassOf: { relatesTo, relatedVerdictId: uuid(22) } });
  });

  it("a related event that was only recorded (no severity) bumps from nothing to low", () => {
    const related = signalRef({ clientEventId: relatesTo, detector: "tech_support_scam", severity: null, outcome: "recorded" });
    const r = evaluateEvent(event, ctx({ recentUserSignals: [related] }));
    expect(r.severity).toBe("low");
  });
});

describe("remote_access_tool", () => {
  const base = { id: uuid(30), type: "software" as const, detector: "remote_access_tool" as const, observedAt: NOW.toISOString(), toolId: "anydesk", name: "AnyDesk" };

  it("not expected → suspicious/high", () => {
    expect(evaluateEvent(base, ctx())).toMatchObject({ outcome: "alerted", severity: "high", verdictLabel: "suspicious", alertKind: "remote_access" });
  });

  it("expected on this device → suspicious/low (feed-only via severity)", () => {
    const r = evaluateEvent(base, ctx({ expectedTools: [expectedTool("anydesk")] }));
    expect(r).toMatchObject({ outcome: "alerted", severity: "low" });
  });
});

describe("unwanted_software", () => {
  it("publisher_list → suspicious/medium, alerted", () => {
    const event: SignalEvent = { id: uuid(31), type: "software", detector: "unwanted_software", observedAt: NOW.toISOString(), name: "Toolbar Helper", reason: "publisher_list" };
    expect(evaluateEvent(event, ctx())).toMatchObject({ outcome: "alerted", severity: "medium", verdictLabel: "suspicious", alertKind: "unwanted_software" });
  });

  it("unsigned_unknown without a hash → recorded (nothing to check)", () => {
    const event: SignalEvent = { id: uuid(32), type: "software", detector: "unwanted_software", observedAt: NOW.toISOString(), name: "mystery.exe", reason: "unsigned_unknown" };
    expect(evaluateEvent(event, ctx())).toMatchObject({ outcome: "recorded" });
  });

  it("unsigned_unknown with a hash → escalate", () => {
    const event: SignalEvent = {
      id: uuid(33),
      type: "software",
      detector: "unwanted_software",
      observedAt: NOW.toISOString(),
      name: "mystery.exe",
      reason: "unsigned_unknown",
      sha256: "a".repeat(64),
    };
    expect(evaluateEvent(event, ctx())).toMatchObject({ outcome: "escalate", alertKind: "unwanted_software" });
  });
});

describe("remote_access_session", () => {
  const base = { id: uuid(40), type: "remote_session" as const, detector: "remote_access_session" as const, observedAt: NOW.toISOString(), toolId: "anydesk" };

  it("outgoing → recorded, no verdict", () => {
    const event: SignalEvent = { ...base, direction: "outgoing" };
    expect(evaluateEvent(event, ctx())).toMatchObject({ outcome: "recorded" });
  });

  it("incoming, tool not expected → malicious/critical", () => {
    const event: SignalEvent = { ...base, direction: "incoming", peerId: "someone" };
    expect(evaluateEvent(event, ctx())).toMatchObject({ outcome: "alerted", severity: "critical", verdictLabel: "malicious", alertKind: "remote_access" });
  });

  it("incoming, tool expected + known peer → malicious/low (feed-only)", () => {
    const event: SignalEvent = { ...base, direction: "incoming", peerId: "grandmas-owner-id" };
    const r = evaluateEvent(event, ctx({ expectedTools: [expectedTool("anydesk", ["grandmas-owner-id"])] }));
    expect(r).toMatchObject({ outcome: "alerted", severity: "low" });
  });

  it("incoming, tool expected but peer unknown or missing → malicious/high", () => {
    const event: SignalEvent = { ...base, direction: "incoming", peerId: "a-stranger" };
    const r = evaluateEvent(event, ctx({ expectedTools: [expectedTool("anydesk", ["grandmas-owner-id"])] }));
    expect(r).toMatchObject({ outcome: "alerted", severity: "high" });
  });
});

describe("tcc_grant", () => {
  it("a known remote-access tool's bundle id, not expected → malicious/critical", () => {
    const event: SignalEvent = {
      id: uuid(50),
      type: "permission",
      detector: "tcc_grant",
      observedAt: NOW.toISOString(),
      app: "AnyDesk",
      bundleId: "com.anydesk.anydesk",
      service: "accessibility",
    };
    expect(evaluateEvent(event, ctx())).toMatchObject({ outcome: "alerted", severity: "critical", verdictLabel: "malicious", alertKind: "remote_access" });
  });

  it("a known remote-access tool's bundle id, expected → malicious/low", () => {
    const event: SignalEvent = {
      id: uuid(51),
      type: "permission",
      detector: "tcc_grant",
      observedAt: NOW.toISOString(),
      app: "AnyDesk",
      bundleId: "com.anydesk.anydesk",
      service: "accessibility",
    };
    const r = evaluateEvent(event, ctx({ expectedTools: [expectedTool("anydesk")] }));
    expect(r).toMatchObject({ outcome: "alerted", severity: "low" });
  });

  it("screen_recording to an unrelated app → suspicious/medium/permission_grant", () => {
    const event: SignalEvent = { id: uuid(52), type: "permission", detector: "tcc_grant", observedAt: NOW.toISOString(), app: "Some App", service: "screen_recording" };
    expect(evaluateEvent(event, ctx())).toMatchObject({ outcome: "alerted", severity: "medium", verdictLabel: "suspicious", alertKind: "permission_grant" });
  });

  it("full_disk_access to an unrelated app → recorded (ambiguous, fails open)", () => {
    const event: SignalEvent = { id: uuid(53), type: "permission", detector: "tcc_grant", observedAt: NOW.toISOString(), app: "Some App", service: "full_disk_access" };
    expect(evaluateEvent(event, ctx())).toMatchObject({ outcome: "recorded" });
  });
});

describe("bumpSeverity", () => {
  it("raises one step and caps at critical", () => {
    expect(bumpSeverity(null)).toBe("low");
    expect(bumpSeverity("low")).toBe("medium");
    expect(bumpSeverity("medium")).toBe("high");
    expect(bumpSeverity("high")).toBe("critical");
    expect(bumpSeverity("critical")).toBe("critical");
  });
});

describe("findScamInProgress (correlation)", () => {
  function ev(overrides: Partial<CorrelationEvent>): CorrelationEvent {
    return { id: "e", deviceId: "device-1", kind: "scam_page", severity: "high" as SignalSeverity, observedAt: NOW, ...overrides };
  }

  it("a scam page followed by remote access within 30 minutes correlates, oldest first", () => {
    const scam = ev({ id: "scam", kind: "scam_page", severity: "high", observedAt: NOW });
    const remote = ev({ id: "remote", kind: "remote_access", severity: "high", observedAt: new Date(NOW.getTime() + 10 * 60_000) });
    const found = findScamInProgress([scam, remote]);
    expect(found).not.toBeNull();
    expect(found!.events.map((e) => e.id)).toEqual(["scam", "remote"]);
    expect(found!.bucket).toBe(thirtyMinuteBucket(NOW));
  });

  it("also correlates in the other order (remote access first)", () => {
    const remote = ev({ id: "remote", kind: "remote_access", severity: "low", observedAt: NOW });
    const scam = ev({ id: "scam", kind: "dangerous_site", severity: "critical", observedAt: new Date(NOW.getTime() + 5 * 60_000) });
    const found = findScamInProgress([remote, scam]);
    expect(found).not.toBeNull();
    expect(found!.events.map((e) => e.id)).toEqual(["remote", "scam"]);
  });

  it("does not correlate outside the 30-minute window", () => {
    const scam = ev({ id: "scam", kind: "scam_page", severity: "high", observedAt: NOW });
    const remote = ev({ id: "remote", kind: "remote_access", severity: "high", observedAt: new Date(NOW.getTime() + 31 * 60_000) });
    expect(findScamInProgress([scam, remote])).toBeNull();
  });

  it("a low/medium scam-kind severity does not correlate", () => {
    const scam = ev({ id: "scam", kind: "scam_page", severity: "medium", observedAt: NOW });
    const remote = ev({ id: "remote", kind: "remote_access", severity: "high", observedAt: new Date(NOW.getTime() + 5 * 60_000) });
    expect(findScamInProgress([scam, remote])).toBeNull();
  });
});
