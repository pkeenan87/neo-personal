import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_HARDENING_V1,
  ACCOUNT_HARDENING_STALE_AFTER_MS,
  scoreAccountHardening,
  type AccountHardeningAnswerInput,
  type AccountHardeningEvidence,
  type AccountHardeningItemId,
} from "../src/account-hardening.js";

const ASOF = new Date("2026-10-05T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const fresh = new Date(+ASOF - DAY);
const ans = (itemId: AccountHardeningItemId, value: boolean | "not_applicable", answeredAt = fresh): AccountHardeningAnswerInput =>
  ({ itemId, value, checklistVersion: "account-hardening-v1", answeredAt });
const ALL_NEEDS: AccountHardeningEvidence = { forwarding_used_30d: "needs_action", browser_extension_enrolled: "needs_action", desktop_agent_enrolled: "needs_action" };
const state = (s: ReturnType<typeof scoreAccountHardening>, id: AccountHardeningItemId) => s.items.find(i => i.id === id)!.state;

describe("account-hardening-v1 manifest", () => {
  it("has the ten fixed items with weights summing to 100", () => {
    expect(ACCOUNT_HARDENING_V1.items.map(i => [i.id, i.weight])).toEqual([
      ["primary_email_2fa", 15], ["passkey_or_hardware_key", 15], ["password_manager", 15], ["recovery_contacts_current", 10],
      ["carrier_port_out_pin", 10], ["credit_freeze", 10], ["os_browser_auto_update", 10],
      ["forwarding_used_30d", 5], ["browser_extension_enrolled", 5], ["desktop_agent_enrolled", 5],
    ]);
    expect(ACCOUNT_HARDENING_V1.items.reduce((n, i) => n + i.weight, 0)).toBe(100);
    expect(ACCOUNT_HARDENING_V1.items.filter(i => i.source === "self_attested")).toHaveLength(7);
    expect(ACCOUNT_HARDENING_V1.items.filter(i => i.notApplicableWhen).map(i => i.id).sort())
      .toEqual(["carrier_port_out_pin", "credit_freeze", "desktop_agent_enrolled"]);
  });
  it("links every self-attested item to first-party HTTPS pages only", () => {
    for (const item of ACCOUNT_HARDENING_V1.items) {
      if (item.source === "self_attested") expect(item.helpLinks.length).toBeGreaterThan(0);
      for (const l of item.helpLinks) {
        const u = new URL(l.href);
        expect(u.protocol).toBe("https:");
        expect(u.hostname).toMatch(/^(support\.(google|microsoft|apple|mozilla)\.com|support\.mozilla\.org|www\.(verizon|t-mobile|att|equifax|experian|transunion)\.com)$/);
      }
    }
  });
  it("does not depend on a model or I/O", () => {
    const src = readFileSync(new URL("../src/account-hardening.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^import /m);
  });
});

describe("scoreAccountHardening", () => {
  it("shows not enough answers below three answered self-attested items", () => {
    const s = scoreAccountHardening({ answers: [ans("primary_email_2fa", true), ans("password_manager", true)], evidence: ALL_NEEDS, asOf: ASOF });
    expect(s.scorePercent).toBeNull();
    expect(scoreAccountHardening({ answers: [], evidence: ALL_NEEDS, asOf: ASOF }).scorePercent).toBeNull();
  });
  it("scores weighted percent once three are answered; false and unanswered earn zero", () => {
    const s = scoreAccountHardening({
      answers: [ans("primary_email_2fa", true), ans("passkey_or_hardware_key", false), ans("password_manager", true)],
      evidence: { ...ALL_NEEDS, forwarding_used_30d: "complete" }, asOf: ASOF,
    });
    expect(s.scorePercent).toBe(35); // 15 + 15 + 5 of 100
    expect(state(s, "passkey_or_hardware_key")).toBe("needs_action");
    expect(state(s, "credit_freeze")).toBe("unanswered");
    expect(s.partial).toBe(false);
    expect(s.checklistVersion).toBe("account-hardening-v1");
  });
  it("treats exactly 180 days as stale and 180 days minus 1 ms as fresh", () => {
    const at = (age: number) => scoreAccountHardening({ answers: [ans("primary_email_2fa", true, new Date(+ASOF - age))], evidence: ALL_NEEDS, asOf: ASOF });
    expect(state(at(ACCOUNT_HARDENING_STALE_AFTER_MS), "primary_email_2fa")).toBe("stale");
    expect(state(at(ACCOUNT_HARDENING_STALE_AFTER_MS + 1), "primary_email_2fa")).toBe("stale");
    expect(state(at(ACCOUNT_HARDENING_STALE_AFTER_MS - 1), "primary_email_2fa")).toBe("complete");
  });
  it("stale answers earn zero and stay in the denominator but do not count toward the minimum", () => {
    const old = new Date(+ASOF - 200 * DAY);
    const s = scoreAccountHardening({ answers: [ans("primary_email_2fa", true, old), ans("passkey_or_hardware_key", true), ans("password_manager", true), ans("credit_freeze", true)], evidence: ALL_NEEDS, asOf: ASOF });
    expect(s.scorePercent).toBe(40);
    expect(s.items.find(i => i.id === "primary_email_2fa")).toMatchObject({ state: "stale", answeredAt: old.toISOString() });
  });
  it("needs three fresh answers: stale ones never count", () => {
    const old = new Date(+ASOF - 200 * DAY);
    const run = (answers: AccountHardeningAnswerInput[]) => scoreAccountHardening({ answers, evidence: ALL_NEEDS, asOf: ASOF }).scorePercent;
    expect(run([ans("primary_email_2fa", true, old), ans("passkey_or_hardware_key", true, old), ans("password_manager", true, old)])).toBeNull();
    expect(run([ans("primary_email_2fa", true), ans("passkey_or_hardware_key", true), ans("password_manager", true, old)])).toBeNull();
    expect(run([ans("primary_email_2fa", true), ans("passkey_or_hardware_key", true), ans("password_manager", true)])).toBeTypeOf("number");
  });
  it("counts N/A on a self-attested item as a fresh answer", () => {
    expect(scoreAccountHardening({ answers: [ans("primary_email_2fa", true), ans("credit_freeze", "not_applicable"), ans("carrier_port_out_pin", "not_applicable")], evidence: ALL_NEEDS, asOf: ASOF }).scorePercent).toBeTypeOf("number");
  });
  it("removes N/A items from the denominator", () => {
    const s = scoreAccountHardening({
      answers: [ans("primary_email_2fa", true), ans("credit_freeze", "not_applicable"), ans("carrier_port_out_pin", "not_applicable"), ans("desktop_agent_enrolled", "not_applicable")],
      evidence: ALL_NEEDS, asOf: ASOF,
    });
    expect(state(s, "credit_freeze")).toBe("not_applicable");
    expect(state(s, "desktop_agent_enrolled")).toBe("not_applicable");
    expect(s.scorePercent).toBe(20); // 15 of (100 - 10 - 10 - 5)
  });
  it("ages N/A answers out after 180 days, including the desktop agent", () => {
    const old = new Date(+ASOF - 180 * DAY);
    const s = scoreAccountHardening({ answers: [ans("desktop_agent_enrolled", "not_applicable", old), ans("credit_freeze", "not_applicable", old)], evidence: ALL_NEEDS, asOf: ASOF });
    expect(state(s, "desktop_agent_enrolled")).toBe("stale");
    expect(state(s, "credit_freeze")).toBe("stale");
  });
  it("keeps an N/A desktop agent complete and in the denominator when an active agent is detected", () => {
    const answers = [ans("primary_email_2fa", true), ans("passkey_or_hardware_key", true), ans("password_manager", true), ans("desktop_agent_enrolled", "not_applicable")];
    const s = scoreAccountHardening({ answers, evidence: { ...ALL_NEEDS, desktop_agent_enrolled: "complete" }, asOf: ASOF });
    expect(state(s, "desktop_agent_enrolled")).toBe("complete");
    expect(s.scorePercent).toBe(50); // 15 + 15 + 15 + 5 of 100
  });
  it("does not let N/A override a complete detection or apply to other items", () => {
    const s = scoreAccountHardening({
      answers: [ans("desktop_agent_enrolled", "not_applicable"), ans("primary_email_2fa", "not_applicable"), ans("browser_extension_enrolled", "not_applicable")],
      evidence: { ...ALL_NEEDS, desktop_agent_enrolled: "complete" }, asOf: ASOF,
    });
    expect(state(s, "desktop_agent_enrolled")).toBe("complete");
    expect(state(s, "primary_email_2fa")).toBe("unanswered");
    expect(state(s, "browser_extension_enrolled")).toBe("needs_action");
  });
  it("computes a partial score over known items when a detected item is unknown", () => {
    const s = scoreAccountHardening({
      answers: [ans("primary_email_2fa", true), ans("passkey_or_hardware_key", true), ans("password_manager", true)],
      evidence: { forwarding_used_30d: "unknown", browser_extension_enrolled: "needs_action", desktop_agent_enrolled: "needs_action" }, asOf: ASOF,
    });
    expect(state(s, "forwarding_used_30d")).toBe("unknown");
    expect(s.partial).toBe(true);
    expect(s.scorePercent).toBe(Math.round((45 / 95) * 100));
    expect(s.nextActions).not.toContain("forwarding_used_30d");
    // Missing evidence is unknown, not failed.
    expect(state(scoreAccountHardening({ answers: [], evidence: {}, asOf: ASOF }), "forwarding_used_30d")).toBe("unknown");
  });
  it("lists at most three actionable items by weight then id, never unknown or N/A", () => {
    const s = scoreAccountHardening({
      answers: [ans("os_browser_auto_update", false), ans("credit_freeze", "not_applicable")],
      evidence: { forwarding_used_30d: "unknown", browser_extension_enrolled: "needs_action", desktop_agent_enrolled: "needs_action" }, asOf: ASOF,
    });
    expect(s.nextActions).toEqual(["passkey_or_hardware_key", "password_manager", "primary_email_2fa"]);
    const s2 = scoreAccountHardening({
      answers: ["primary_email_2fa", "passkey_or_hardware_key", "password_manager", "recovery_contacts_current", "carrier_port_out_pin", "credit_freeze"].map(id => ans(id as AccountHardeningItemId, true)),
      evidence: ALL_NEEDS, asOf: ASOF,
    });
    expect(s2.nextActions).toEqual(["os_browser_auto_update", "browser_extension_enrolled", "desktop_agent_enrolled"]);
  });
  it("reuses only explicitly compatible prior-version answers with their original timestamp", () => {
    const prior = "account-hardening-v0" as unknown as "account-hardening-v1";
    const manifest = { ...ACCOUNT_HARDENING_V1, items: ACCOUNT_HARDENING_V1.items.map(i => i.id === "password_manager" ? { ...i, compatiblePriorVersions: [prior] } : i) };
    const answers = [
      { ...ans("password_manager", true), checklistVersion: prior },
      { ...ans("primary_email_2fa", true), checklistVersion: prior },
    ];
    const s = scoreAccountHardening({ answers, evidence: ALL_NEEDS, asOf: ASOF, manifest });
    expect(state(s, "password_manager")).toBe("complete");
    expect(s.items.find(i => i.id === "password_manager")!.answeredAt).toBe(fresh.toISOString());
    expect(state(s, "primary_email_2fa")).toBe("unanswered");
  });
});
