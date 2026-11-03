import type { PolicyRules, ServerSignalEvent, SignalEvent } from "@neo/verdict";
import { describe, expect, it } from "vitest";
import {
  MODE_DEFAULTS,
  bumpSeverity,
  effectivePolicy,
  evaluateSignal,
  findScamInProgress,
  thirtyMinuteBucket,
  type CorrelationMember,
  type EngineCatalog,
  type EvaluationContext,
  type RecentSignal,
} from "../src/index.js";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const MIN = 60_000;
const at = (offsetMin: number) => new Date(NOW.getTime() + offsetMin * MIN);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const catalog: EngineCatalog = {
  vendorDomains: (id) => (id === "anydesk" ? ["anydesk.com"] : []),
  toolIdForBundle: (b) => (b.toLowerCase() === "com.anydesk.anydesk" ? "anydesk" : undefined),
};

function ctx(over: Partial<EvaluationContext> = {}): EvaluationContext {
  return { now: NOW, deviceId: "device-1", expectedTools: [], recent: [], catalog, ...over };
}

function row(over: Partial<RecentSignal>): RecentSignal {
  return { id: uuid(100), clientEventId: uuid(101), detector: "remote_access_session", severity: "high", outcome: "alerted", verdictId: null, observedAt: NOW, deviceId: "device-1", payload: { direction: "incoming" }, ...over };
}

const standard = effectivePolicy({ mode: "standard" });
const elder = effectivePolicy({ mode: "elder" });
const base = { observedAt: NOW.toISOString() };

const session = (peerId = "stranger", toolId = "anydesk"): SignalEvent => ({ ...base, id: uuid(1), type: "remote_session", detector: "remote_access_session", toolId, direction: "incoming", peerId });
const unwanted: SignalEvent = { ...base, id: uuid(2), type: "software", detector: "unwanted_software", name: "Optimizer", reason: "publisher_list" };
const payment: SignalEvent = { ...base, id: uuid(3), type: "page", detector: "payment_page", domain: "pay.test", category: "gift_card" };
const scamEvent: SignalEvent = { ...base, id: uuid(4), type: "page", detector: "tech_support_scam", domain: "scam.test", indicators: ["fullscreen", "fake_scan"] };
const disabled: ServerSignalEvent = { id: uuid(5), detector: "protection_disabled", reason: "extension_uninstalled", observedAt: NOW.toISOString() };

describe("effectivePolicy", () => {
  it("merges household → mode → member → device, later layers winning field by field", () => {
    const p = effectivePolicy({
      household: { remote_access: { unknownPeerSeverity: "low", sessionWindowMinutes: 5 }, notify: { helpersNotifyAt: "low" } },
      mode: "elder",
      member: { remote_access: { sessionWindowMinutes: 45 } },
      device: { remote_access: { sessionWindowMinutes: 50 }, notify: { ownersNotifyAt: "medium" } },
    });
    expect(p.remote_access).toEqual({ unknownPeerSeverity: "critical", sessionWindowMinutes: 50 }); // mode beats household, device beats member
    expect(p.notify).toEqual({ helpersNotifyAt: "high", ownersNotifyAt: "medium" });
    expect(p.payments).toEqual({ underPressureWindowMinutes: 60 });
  });

  it("skips an invalid layer whole and drops unknown keys", () => {
    const p = effectivePolicy({ mode: "standard", member: { remote_access: { unknownPeerSeverity: "nope" }, notify: { ownersNotifyAt: "low" } }, device: { remote_access: { unknownPeerSeverity: "medium", junk: 1 }, junk: 2 } });
    expect(p.remote_access).toEqual({ unknownPeerSeverity: "medium" });
    expect(p.notify).toEqual({ ownersNotifyAt: "high" }); // invalid member layer skipped entirely
    expect(p).not.toHaveProperty("junk");
  });

  it("child is no longer Standard (the 10-13 band without a birth year); defaults are not mutated by merging", () => {
    expect(effectivePolicy({ mode: "child" })).not.toEqual(effectivePolicy({ mode: "standard" }));
    expect(effectivePolicy({ mode: "child" })).toEqual(MODE_DEFAULTS.child);
    effectivePolicy({ mode: "elder", member: { remote_access: { sessionWindowMinutes: 1 } } });
    expect(MODE_DEFAULTS.elder.remote_access?.sessionWindowMinutes).toBe(30);
  });
});

describe("rule 1: unknown peer", () => {
  const expectedTools = [{ toolId: "anydesk", peerIds: ["grandson"] }];
  it("standard high, elder critical + notifyNow", () => {
    expect(evaluateSignal(standard, { event: session() }, ctx({ expectedTools }))).toMatchObject({ action: "incident", severity: "high", kind: "remote_access", reasonCodes: ["unexpected_peer"] });
    const d = evaluateSignal(elder, { event: session() }, ctx({ expectedTools }));
    expect(d).toMatchObject({ severity: "critical", notifyNow: true });
  });
  it("known peer stays low in elder; unexpected tool is critical in both", () => {
    expect(evaluateSignal(elder, { event: session("grandson") }, ctx({ expectedTools })).severity).toBe("low");
    expect(evaluateSignal(standard, { event: session() }, ctx()).severity).toBe("critical");
  });
});

describe("rule 2: scam_in_progress", () => {
  it("fires in both modes from the same recent rows, ignoring baseline remote tools", () => {
    const scamRow = row({ id: "scam", clientEventId: uuid(40), detector: "tech_support_scam", observedAt: at(-10), payload: {} });
    for (const policy of [standard, elder]) {
      const d = evaluateSignal(policy, { event: session(), signalId: "now" }, ctx({ recent: [scamRow] }));
      expect(d.correlations).toHaveLength(1);
      expect(d.correlations[0]).toMatchObject({ kind: "scam_in_progress", severity: "critical", signalIds: ["scam", "now"], bucket: thirtyMinuteBucket(at(-10)) });
    }
    const baselineOnly = row({ id: "tool", clientEventId: uuid(41), detector: "remote_access_tool", observedAt: at(-5), payload: { discovery: "baseline" } });
    const scamNow = evaluateSignal(elder, { event: scamEvent }, ctx({ recent: [baselineOnly] }));
    expect(scamNow.correlations).toEqual([]);
  });
  it("counts a high lookalike_login as a dangerous site (already true in standard)", () => {
    const look = row({ id: "look", clientEventId: uuid(42), detector: "lookalike_login", severity: "high", observedAt: at(-20), payload: {} });
    expect(evaluateSignal(elder, { event: session() }, ctx({ recent: [look] })).correlations[0]?.kind).toBe("scam_in_progress");
  });
  it("does not fire beyond 30 minutes", () => {
    const old = row({ id: "scam", clientEventId: uuid(40), detector: "tech_support_scam", observedAt: at(-31), payload: {} });
    expect(evaluateSignal(elder, { event: session() }, ctx({ recent: [old] })).correlations).toEqual([]);
  });
  it("does not double count the current signal's own stored row", () => {
    const own = row({ id: "own", clientEventId: uuid(1), observedAt: NOW });
    expect(evaluateSignal(elder, { event: session(), signalId: "own" }, ctx({ recent: [own] })).correlations).toEqual([]);
  });
});

describe("rule 3: install_during_session", () => {
  const sess = (min: number, over: Partial<RecentSignal> = {}) => row({ id: "sess", clientEventId: uuid(60), severity: "critical", observedAt: at(min), ...over });
  const kinds = (d: ReturnType<typeof evaluateSignal>) => d.correlations.map((c) => c.kind);

  it("fires in elder after an incoming session, including at the exact window edge", () => {
    const d = evaluateSignal(elder, { event: unwanted, signalId: "inst" }, ctx({ recent: [sess(-30)] }));
    expect(d.correlations.find((c) => c.kind === "install_during_session")).toMatchObject({ severity: "critical", signalIds: ["sess", "inst"], notifyNow: true });
  });
  it("does not fire 31 minutes after, before the session, for baseline/outgoing sessions, or in standard", () => {
    expect(kinds(evaluateSignal(elder, { event: unwanted }, ctx({ recent: [sess(-31)] })))).not.toContain("install_during_session");
    expect(kinds(evaluateSignal(elder, { event: unwanted }, ctx({ recent: [sess(5)] })))).not.toContain("install_during_session");
    expect(kinds(evaluateSignal(elder, { event: unwanted }, ctx({ recent: [sess(-5, { payload: { direction: "incoming", discovery: "baseline" } })] })))).not.toContain("install_during_session");
    expect(kinds(evaluateSignal(elder, { event: unwanted }, ctx({ recent: [sess(-5, { payload: { direction: "outgoing" } })] })))).not.toContain("install_during_session");
    expect(kinds(evaluateSignal(standard, { event: unwanted }, ctx({ recent: [sess(-5)] })))).not.toContain("install_during_session");
  });
  it("does not fire after a low (expected-peer) session, but does after a high one", () => {
    expect(kinds(evaluateSignal(elder, { event: unwanted }, ctx({ recent: [sess(-5, { severity: "low" })] })))).not.toContain("install_during_session");
    expect(kinds(evaluateSignal(elder, { event: unwanted }, ctx({ recent: [sess(-5, { severity: "high" })] })))).toContain("install_during_session");
  });
  it("applies to tcc_grant but not to a recorded (non-alerting) one", () => {
    const tcc: SignalEvent = { ...base, id: uuid(61), type: "permission", detector: "tcc_grant", app: "Some App", service: "screen_recording" };
    expect(kinds(evaluateSignal(elder, { event: tcc }, ctx({ recent: [sess(-5)] })))).toContain("install_during_session");
    const fda: SignalEvent = { ...tcc, service: "full_disk_access" };
    const d = evaluateSignal(elder, { event: fda }, ctx({ recent: [sess(-5)] }));
    expect(d.action).toBe("record");
    expect(d.correlations).toEqual([]);
  });
  it("honours a per-member sessionWindowMinutes", () => {
    const short = effectivePolicy({ mode: "elder", member: { remote_access: { sessionWindowMinutes: 10 } } });
    expect(kinds(evaluateSignal(short, { event: unwanted }, ctx({ recent: [sess(-11)] })))).not.toContain("install_during_session");
    expect(kinds(evaluateSignal(short, { event: unwanted }, ctx({ recent: [sess(-10)] })))).toContain("install_during_session");
  });
});

describe("rule 4: payment_page", () => {
  it("standard records", () => {
    expect(evaluateSignal(standard, { event: payment }, ctx())).toMatchObject({ action: "record", kind: null, notifyNow: false });
  });
  it("elder alone → medium payment_under_pressure incident, not notified", () => {
    const d = evaluateSignal(elder, { event: payment }, ctx());
    expect(d).toMatchObject({ action: "incident", kind: "payment_under_pressure", severity: "medium", notifyNow: false, correlations: [] });
  });
  it("critical correlation after a high scam page or incoming session, edge 60 minutes inclusive", () => {
    const scamRow = row({ id: "scam", clientEventId: uuid(70), detector: "tech_support_scam", observedAt: at(-60), payload: {} });
    const d = evaluateSignal(elder, { event: payment, signalId: "pay" }, ctx({ recent: [scamRow] }));
    expect(d.correlations).toEqual([expect.objectContaining({ kind: "payment_under_pressure", severity: "critical", signalIds: ["scam", "pay"], notifyNow: true })]);
    const sess = row({ id: "sess", clientEventId: uuid(71), observedAt: at(-59), severity: "high" });
    expect(evaluateSignal(elder, { event: payment }, ctx({ recent: [sess] })).correlations.map((c) => c.kind)).toContain("payment_under_pressure");
  });
  it("a low (expected-peer) session is not a trigger", () => {
    const helper = row({ id: "h", clientEventId: uuid(74), observedAt: at(-5), severity: "low" });
    expect(evaluateSignal(elder, { event: payment }, ctx({ recent: [helper] })).correlations).toEqual([]);
  });
  it("no correlation at 61 minutes, for a medium scam, or after the payment", () => {
    const old = row({ id: "scam", clientEventId: uuid(70), detector: "tech_support_scam", observedAt: at(-61), payload: {} });
    const weak = row({ id: "w", clientEventId: uuid(72), detector: "tech_support_scam", severity: "medium", observedAt: at(-5), payload: {} });
    const later = row({ id: "l", clientEventId: uuid(73), observedAt: at(5) });
    for (const r of [old, weak, later]) expect(evaluateSignal(elder, { event: payment }, ctx({ recent: [r] })).correlations).toEqual([]);
  });
});

describe("rule 5: protection_disabled", () => {
  it("elder → high incident with notifyNow; standard records", () => {
    expect(evaluateSignal(elder, { event: disabled }, ctx())).toMatchObject({ action: "incident", kind: "protection_disabled", severity: "high", notifyNow: true, reasonCodes: ["extension_uninstalled"], correlations: [] });
    expect(evaluateSignal(standard, { event: disabled }, ctx()).action).toBe("record");
  });
});

describe("notifyNow", () => {
  it("uses the lowest configured threshold, defaulting to high", () => {
    const p: PolicyRules = { notify: { helpersNotifyAt: "medium", ownersNotifyAt: "critical" } };
    expect(evaluateSignal(p, { event: unwanted }, ctx()).notifyNow).toBe(true); // medium >= medium
    expect(evaluateSignal({}, { event: unwanted }, ctx()).notifyNow).toBe(false); // medium < default high
    expect(evaluateSignal({}, { event: scamEvent }, ctx()).notifyNow).toBe(true);
    expect(evaluateSignal(standard, { event: { ...unwanted, reason: "unsigned_unknown", sha256: "a".repeat(64) } as SignalEvent }, ctx()).notifyNow).toBe(false); // escalate, not incident
  });
});

describe("enrichment", () => {
  const lookalike: SignalEvent = { ...base, id: uuid(80), type: "page", detector: "lookalike_login", domain: "paypa1.test", brand: "paypal", indicators: ["lookalike_skeleton"] };
  const dangerous: SignalEvent = { ...base, id: uuid(81), type: "page", detector: "dangerous_site", domain: "bad.test", source: "safe_browsing_prefix" };
  const unsigned = { ...unwanted, id: uuid(82), reason: "unsigned_unknown", sha256: "b".repeat(64) } as SignalEvent;

  it("without enrichment the escalating detectors escalate", () => {
    for (const event of [lookalike, dangerous, unsigned]) expect(evaluateSignal(standard, { event }, ctx())).toMatchObject({ action: "escalate", escalate: true, severity: null });
  });
  it("failed and clean always dismiss", () => {
    for (const event of [lookalike, dangerous, unsigned]) for (const label of ["failed", "clean"] as const) expect(evaluateSignal(elder, { event, enrichment: { label } }, ctx())).toMatchObject({ action: "dismiss", kind: null, severity: null });
  });
  it("malicious/suspicious confirm per detector", () => {
    expect(evaluateSignal(standard, { event: lookalike, enrichment: { label: "malicious", reasonCodes: ["brand_lookalike", "safe_browsing_match"] } }, ctx())).toMatchObject({ action: "incident", severity: "high", verdictLabel: "malicious", kind: "dangerous_site", reasonCodes: ["brand_lookalike", "safe_browsing_match"] });
    expect(evaluateSignal(standard, { event: lookalike, enrichment: { label: "suspicious" } }, ctx())).toMatchObject({ severity: "medium", verdictLabel: "suspicious" });
    expect(evaluateSignal(standard, { event: dangerous, enrichment: { label: "malicious" } }, ctx())).toMatchObject({ severity: "high", reasonCodes: ["safe_browsing_prefix", "safe_browsing_match"] });
    expect(evaluateSignal(standard, { event: dangerous, enrichment: { label: "suspicious" } }, ctx()).action).toBe("dismiss");
    expect(evaluateSignal(standard, { event: unsigned, enrichment: { label: "malicious" } }, ctx())).toMatchObject({ kind: "unwanted_software", severity: "high", reasonCodes: ["unsigned_unknown", "virustotal_malicious"] });
  });
  it("a confirmed dangerous site joins scam_in_progress", () => {
    const remote = row({ id: "r", clientEventId: uuid(83), observedAt: at(-5) });
    const d = evaluateSignal(elder, { event: dangerous, signalId: "d", enrichment: { label: "malicious" } }, ctx({ recent: [remote] }));
    expect(d.correlations[0]).toMatchObject({ kind: "scam_in_progress", signalIds: ["r", "d"] });
  });
});

describe("severity helpers", () => {
  it("bumpSeverity steps and caps", () => {
    expect([null, "low", "medium", "high", "critical"].map((s) => bumpSeverity(s as never))).toEqual(["low", "medium", "high", "critical", "critical"]);
  });
  it("findScamInProgress is order independent and window bound", () => {
    const e = (id: string, kind: CorrelationMember["kind"], m: number): CorrelationMember => ({ id, deviceId: "d", kind, severity: "high", observedAt: at(m) });
    expect(findScamInProgress([e("r", "remote_access", 0), e("s", "dangerous_site", 5)])?.events.map((x) => x.id)).toEqual(["r", "s"]);
    expect(findScamInProgress([e("s", "scam_page", 0), e("r", "remote_access", 31)])).toBeNull();
  });
});
