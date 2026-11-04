// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SignalEvent } from "@neo/verdict";
import { DEFAULT_STATE } from "../lib/types.js";
import { enqueueEvent, SELF_HARM_COALESCE_MS, WEB_BLOCKED_COALESCE_MS } from "../lib/queue.js";

const T0 = Date.parse("2026-11-03T12:00:00Z");

function blocked(domain: string, category: "adult" | "self_harm" | "gambling"): SignalEvent {
  return { id: crypto.randomUUID(), type: "page", detector: "web_blocked", observedAt: new Date(T0).toISOString(), domain, category };
}
function tamper(reason: "bad_policy_signature" | "vpn_app"): SignalEvent {
  return { id: crypto.randomUUID(), type: "tamper", detector: "tamper_detected", observedAt: new Date(T0).toISOString(), reason };
}

function run(events: [SignalEvent, number][]): number {
  let state = DEFAULT_STATE;
  let queued = 0;
  for (const [event, at] of events) {
    const r = enqueueEvent(state, event, at);
    state = r.state;
    if (r.enqueued) queued++;
  }
  return queued;
}

describe("web_blocked coalescing (the 500 events a day cap)", () => {
  it("one event for the same domain and category within 10 minutes, another after", () => {
    expect(run([[blocked("a.example", "adult"), T0], [blocked("a.example", "adult"), T0 + 5 * 60_000], [blocked("a.example", "adult"), T0 + WEB_BLOCKED_COALESCE_MS - 1]])).toBe(1);
    expect(run([[blocked("a.example", "adult"), T0], [blocked("a.example", "adult"), T0 + WEB_BLOCKED_COALESCE_MS]])).toBe(2);
  });

  it("a different domain or category is a different event", () => {
    expect(run([[blocked("a.example", "adult"), T0], [blocked("b.example", "adult"), T0 + 1], [blocked("a.example", "gambling"), T0 + 2]])).toBe(3);
  });

  it("self_harm coalesces for a minute only, so the server's 3-in-an-hour rule can trip", () => {
    const events: [SignalEvent, number][] = [0, 1, 2].map((i) => [blocked("pro-ana.example", "self_harm"), T0 + i * (SELF_HARM_COALESCE_MS + 1)]);
    expect(run(events)).toBe(3);
    expect(run([[blocked("pro-ana.example", "self_harm"), T0], [blocked("pro-ana.example", "self_harm"), T0 + 30_000]])).toBe(1);
  });
});

describe("tamper_detected has no domain: one per reason per hour", () => {
  it("does not flood on a bad bundle every tick", () => {
    const ticks: [SignalEvent, number][] = Array.from({ length: 30 }, (_, i) => [tamper("bad_policy_signature"), T0 + i * 60_000]);
    expect(run(ticks)).toBe(1);
  });
  it("reports again after an hour, and per reason", () => {
    expect(run([[tamper("bad_policy_signature"), T0], [tamper("bad_policy_signature"), T0 + 61 * 60_000]])).toBe(2);
    expect(run([[tamper("bad_policy_signature"), T0], [tamper("vpn_app"), T0 + 1]])).toBe(2);
  });
});

describe("the dedupe record stays small", () => {
  it("drops entries older than the longest window", () => {
    let state = DEFAULT_STATE;
    for (let i = 0; i < 50; i++) state = enqueueEvent(state, blocked(`s${i}.example`, "adult"), T0 + i).state;
    state = enqueueEvent(state, blocked("late.example", "adult"), T0 + 2 * 3600_000).state;
    expect(Object.keys(state.dedupe)).toEqual(["web_blocked:late.example:adult"]);
  });
});
