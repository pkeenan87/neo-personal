import type { ServerSignalEvent, SignalEvent } from "@neo/verdict";
import { describe, expect, it } from "vitest";
import { effectivePolicy, evaluateSignal, type EngineCatalog, type EvaluationContext, type RecentSignal } from "../src/index.js";

/**
 * One table for the five Elder escalation rules and Child's parity with them (_specs/v2-m4-hardening.md section 5):
 * each rule fires in Elder and Child and not in Standard (where it does), and each has a near miss that does
 * not fire. The per-rule edge cases (window edges, severities, enrichment) live in policy.test.ts and
 * child-policy.test.ts.
 */
const NOW = new Date("2026-09-29T12:00:00.000Z");
const MIN = 60_000;
const at = (offsetMin: number) => new Date(NOW.getTime() + offsetMin * MIN);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = { observedAt: NOW.toISOString() };
const catalog: EngineCatalog = { vendorDomains: () => [], toolIdForBundle: () => undefined };
const ctx = (over: Partial<EvaluationContext> = {}): EvaluationContext => ({ now: NOW, deviceId: "device-1", expectedTools: [], recent: [], catalog, ...over });
const row = (over: Partial<RecentSignal>): RecentSignal => ({
  id: uuid(100),
  clientEventId: uuid(101),
  detector: "remote_access_session",
  severity: "high",
  outcome: "alerted",
  verdictId: null,
  observedAt: NOW,
  deviceId: "device-1",
  payload: { direction: "incoming" },
  ...over,
});

const session = (peerId: string): SignalEvent => ({ ...base, id: uuid(1), type: "remote_session", detector: "remote_access_session", toolId: "anydesk", direction: "incoming", peerId });
const unwanted: SignalEvent = { ...base, id: uuid(2), type: "software", detector: "unwanted_software", name: "Optimizer", reason: "publisher_list" };
const payment: SignalEvent = { ...base, id: uuid(3), type: "page", detector: "payment_page", domain: "pay.test", category: "gift_card" };
const disabled: ServerSignalEvent = { id: uuid(5), detector: "protection_disabled", reason: "extension_uninstalled", observedAt: NOW.toISOString() };
const knownPeer = { expectedTools: [{ toolId: "anydesk", peerIds: ["grandson"] }] };
const sessionRow = (min: number) => row({ id: "sess", clientEventId: uuid(60), severity: "critical", observedAt: at(min) });
const scamRow = (min: number) => row({ id: "scam", clientEventId: uuid(40), detector: "tech_support_scam", observedAt: at(min), payload: {} });

type Mode = "standard" | "elder" | "child";
/** What a decision escalated to: the incident severity ("incident:high") and the correlation kinds. */
const fired = (d: ReturnType<typeof evaluateSignal>): string[] => [...(d.action === "incident" ? [`incident:${d.severity}`] : []), ...d.correlations.map((c) => c.kind)];

interface Rule {
  rule: string;
  event: SignalEvent | ServerSignalEvent;
  context: Partial<EvaluationContext>;
  /** What each mode escalates to; "!x" means x must not fire (Child has no payment rule: it is Elder-only). */
  expect: Record<Mode, string[]>;
  nearMiss: { name: string; event: SignalEvent | ServerSignalEvent; context: Partial<EvaluationContext>; absent: string[] };
}

const rules: Rule[] = [
  {
    rule: "1 unknown peer",
    event: session("stranger"),
    context: knownPeer,
    expect: { standard: ["incident:high"], elder: ["incident:critical"], child: ["incident:critical"] },
    nearMiss: { name: "a known peer", event: session("grandson"), context: knownPeer, absent: ["incident:critical", "incident:high"] },
  },
  {
    rule: "2 scam in progress",
    event: session("grandson"),
    context: { ...knownPeer, recent: [scamRow(-10)] },
    expect: { standard: ["scam_in_progress"], elder: ["scam_in_progress"], child: ["scam_in_progress"] },
    nearMiss: { name: "a scam row 31 minutes old", event: session("grandson"), context: { ...knownPeer, recent: [scamRow(-31)] }, absent: ["scam_in_progress"] },
  },
  {
    rule: "3 install during a remote session",
    event: unwanted,
    context: { recent: [sessionRow(-5)] },
    expect: { standard: ["!install_during_session"], elder: ["install_during_session"], child: ["install_during_session"] },
    nearMiss: { name: "the session 31 minutes before", event: unwanted, context: { recent: [sessionRow(-31)] }, absent: ["install_during_session"] },
  },
  {
    rule: "4 payment page after a scam signal",
    event: payment,
    context: { recent: [scamRow(-10)] },
    expect: { standard: ["!payment_under_pressure"], elder: ["payment_under_pressure"], child: ["!payment_under_pressure"] },
    nearMiss: { name: "a scam row 61 minutes old", event: payment, context: { recent: [scamRow(-61)] }, absent: ["payment_under_pressure"] },
  },
  {
    rule: "5 protection disabled",
    event: disabled,
    context: {},
    expect: { standard: ["!incident:high"], elder: ["incident:high"], child: ["incident:high"] },
    nearMiss: { name: "a payment page alone is not protection_disabled", event: payment, context: {}, absent: ["incident:high", "incident:critical"] },
  },
];

describe("escalation rules by mode", () => {
  it.each(rules.map((r) => [r.rule, r] as const))("rule %s: fires in the modes that escalate, not in the rest", (_name, r) => {
    for (const mode of ["standard", "elder", "child"] as const) {
      const got = fired(evaluateSignal(effectivePolicy({ mode }), { event: r.event, signalId: "now" }, ctx(r.context)));
      const want = r.expect[mode];
      for (const w of want) {
        if (w.startsWith("!")) expect(got, mode).not.toContain(w.slice(1));
        else expect(got, mode).toContain(w);
      }
    }
  });

  it.each(rules.map((r) => [`${r.rule}: ${r.nearMiss.name}`, r] as const))("near miss, %s: does not fire", (_name, r) => {
    const got = fired(evaluateSignal(effectivePolicy({ mode: "elder" }), { event: r.nearMiss.event, signalId: "now" }, ctx(r.nearMiss.context)));
    for (const k of r.nearMiss.absent) expect(got).not.toContain(k);
  });
});
