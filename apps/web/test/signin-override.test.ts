// @vitest-environment node
import { VerdictSchema, type VerdictLabel } from "@neo/verdict";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGeoLocator } from "@/lib/server/signin/geo";
import { applyAmbiguousSigninCap, applySigninAlertOverride } from "@/lib/server/signin/override";
import { finalizeSigninVerdict, persistSigninEvent } from "@/lib/server/signin/service";
import { memorySigninStore } from "@/lib/server/signin/store";
import { resetMemoryState } from "@/lib/server/memory-state";
import { analyzeRaw, GOOGLE_VERIFIED, googleAlertRaw, googleForwardedRaw, triaged } from "./signin-fixtures";

const TENANT = "00000000-0000-4000-8000-0000000000cc";
const USER = "user-1";
const run = async (raw: string, label: VerdictLabel, templates?: typeof GOOGLE_VERIFIED) =>
  applySigninAlertOverride({ analysis: await analyzeRaw(raw), verdict: triaged(label), ...(templates ? { templates } : {}) });

beforeEach(() => resetMemoryState());

describe("applySigninAlertOverride precedence", () => {
  it("returns a non-alert verdict untouched", async () => {
    const analysis = await analyzeRaw("From: A <a@example.org>\nTo: b@example.com\nSubject: Hi\n\nLunch?\n");
    const v = triaged("likely_safe");
    expect(applySigninAlertOverride({ analysis, verdict: v })).toBe(v);
  });

  it.each([
    ["off-provider sender", { from: "Google <no-reply@accounts-google.example.net>", dkimDomain: "accounts-google.example.net" }],
    ["off-provider link", { links: ["https://google-security.example.net/review"] }],
    ["callback number", { extra: ["Call support at +1 415 555 0132 to secure your account."] }],
    ["reply with code", { extra: ["Reply with the verification code we sent you."] }],
  ])("a fake-alert rule (%s) overrides even a likely_safe model verdict to malicious", async (_n, opts) => {
    const v = await run(googleAlertRaw(opts), "likely_safe", GOOGLE_VERIFIED);
    expect(v.verdict).toBe("malicious");
    expect(v.subject_type).toBe("signin_alert");
    expect(v.indicators[0]!.severity).toBe("high");
    expect(VerdictSchema.safeParse(v).success).toBe(true);
  });

  it("all gates with a verified template -> likely_safe (even if the model said suspicious)", async () => {
    const v = await run(googleAlertRaw(), "suspicious", GOOGLE_VERIFIED);
    expect(v).toMatchObject({ verdict: "likely_safe", subject_type: "signin_alert" });
  });

  it("an unverified template with dkim=pass on the provider domain and provider links is capped at suspicious", async () => {
    expect((await run(googleAlertRaw(), "likely_safe")).verdict).toBe("suspicious");
    expect((await run(googleAlertRaw(), "suspicious")).verdict).toBe("suspicious");
    expect((await run(googleAlertRaw(), "malicious")).verdict).toBe("malicious");
    expect((await run(googleAlertRaw(), "insufficient_evidence")).verdict).toBe("insufficient_evidence");
  });

  it("a verified template still needs dkim, an allowlisted domain and provider links (each gate)", async () => {
    expect((await run(googleAlertRaw({ dkimDomain: "bulk.example.net" }), "likely_safe", GOOGLE_VERIFIED)).verdict).toBe("malicious"); // fake rule 1
    expect((await run(googleAlertRaw({ auth: "absent" }), "likely_safe", GOOGLE_VERIFIED)).verdict).toBe("insufficient_evidence");
  });

  it("absent authentication or a forwarded wrapper becomes insufficient_evidence, never likely_safe", async () => {
    for (const raw of [googleAlertRaw({ auth: "absent" }), googleForwardedRaw()]) {
      for (const verified of [undefined, GOOGLE_VERIFIED]) {
        const v = await run(raw, "likely_safe", verified);
        expect(v.verdict).toBe("insufficient_evidence");
        expect(v.subject_type).toBe("signin_alert");
      }
    }
    // A model that already flagged it keeps its (more severe) verdict.
    expect((await run(googleForwardedRaw(), "suspicious")).verdict).toBe("suspicious");
    expect((await run(googleForwardedRaw(), "malicious")).verdict).toBe("malicious");
  });

  it("adds only static text: no parsed device, location, IP or address reaches headline/indicators/actions", async () => {
    const v = await run(googleAlertRaw({ from: "Google <no-reply@accounts-google.example.net>", dkimDomain: "accounts-google.example.net" }), "suspicious");
    const added = JSON.stringify([v.headline, v.indicators.slice(0, 1), v.recommended_actions.slice(0, 2)]);
    for (const leaked of ["Windows", "Seattle", "203.0.113", "jordan", "example.com"]) expect(added).not.toContain(leaked);
  });

  it("replaces a model headline that could quote the device with static text, whatever the label", async () => {
    const analysis = await analyzeRaw(googleAlertRaw());
    for (const label of ["malicious", "suspicious", "insufficient_evidence"] as const) {
      const v = applySigninAlertOverride({ analysis, verdict: triaged(label, { headline: "New sign-in from Windows in Seattle" }) });
      expect(v.verdict).toBe(label);
      expect(v.headline).not.toMatch(/Windows|Seattle/);
    }
  });

  it("never lets a model-written signin_check through", async () => {
    const analysis = await analyzeRaw(googleAlertRaw());
    const forged = triaged("suspicious", { signin_check: { provider: "google", event: "new_signin", device_label: "x", first_seen: true } });
    expect(applySigninAlertOverride({ analysis, verdict: forged }).signin_check).toBeUndefined();
  });
});

describe("finalizeSigninVerdict (known devices and events)", () => {
  const input = async (raw: string, label: VerdictLabel = "suspicious") => ({ tenantId: TENANT, userId: USER, analysis: await analyzeRaw(raw), verdict: triaged(label), source: "forwarded" as const });

  it("asks only for a first-seen provider/device pair and remembers the answer", async () => {
    const first = await finalizeSigninVerdict(await input(googleAlertRaw()));
    expect(first.verdict.signin_check).toEqual({ provider: "google", event: "new_signin", device_label: "Windows", first_seen: true, coarse_location: "Seattle, WA, USA" });
    expect(first.event).toMatchObject({ provider: "google", event: "new_signin", deviceLabel: "Windows", authenticated: true, source: "forwarded", eventTime: "2026-01-15T12:00:00.000Z" });
    expect(VerdictSchema.safeParse(first.verdict).success).toBe(true);

    await memorySigninStore.rememberDevice(TENANT, USER, "google", "Windows");
    const again = await finalizeSigninVerdict(await input(googleAlertRaw()));
    expect(again.verdict.signin_check?.first_seen).toBe(false);
    // another member or provider is still first-seen
    expect((await finalizeSigninVerdict({ ...(await input(googleAlertRaw())), userId: "user-2" })).verdict.signin_check?.first_seen).toBe(true);
  });

  it("does not ask about a fake alert (its device label is attacker text) but still stores the event as unauthenticated", async () => {
    const fin = await finalizeSigninVerdict(await input(googleAlertRaw({ links: ["https://evil.example.net/x"], auth: "fail" })));
    expect(fin.verdict.verdict).toBe("malicious");
    expect(fin.verdict.signin_check).toBeUndefined();
    expect(fin.event?.authenticated).toBe(false);
  });

  it("strips a model-written signin_check from any verdict, alert or not", async () => {
    const analysis = await analyzeRaw("From: A <a@example.org>\nTo: b@example.com\nSubject: Hi\n\nLunch?\n");
    const forged = triaged("suspicious", { signin_check: { provider: "google", event: "new_signin", device_label: "x", first_seen: true } });
    const fin = await finalizeSigninVerdict({ tenantId: TENANT, userId: USER, analysis, verdict: forged, source: "forwarded" });
    expect(fin.verdict.signin_check).toBeUndefined();
    expect(fin.event).toBeNull();
  });

  it("fills an absent location from the (mock) geolocator, labelled advisory by the UI", async () => {
    const lines = ["A new sign-in on Windows", "Your Google Account was signed in to.", "IP address: 203.0.113.24", "Check activity", "If this wasn't you, secure your account."];
    const geo = { locate: vi.fn(mockGeoLocator.locate) };
    const fin = await finalizeSigninVerdict(await input(googleAlertRaw({ lines })), { geo });
    expect(geo.locate).toHaveBeenCalledWith("203.0.113.24");
    expect(fin.event?.coarseLocation).toBe("Documentation network (mock)");
    expect(await mockGeoLocator.locate("8.8.8.8")).toEqual({ advisory: true });
  });

  it("persists events per member and never throws when the store fails", async () => {
    const fin = await finalizeSigninVerdict(await input(googleAlertRaw()));
    await persistSigninEvent({ tenantId: TENANT, userId: USER, verdictId: "v-1", event: fin.event });
    await persistSigninEvent({ tenantId: TENANT, userId: USER, event: null });
    expect(await memorySigninStore.list(TENANT, USER)).toHaveLength(1);
    expect(await memorySigninStore.list(TENANT, "user-2")).toEqual([]);
    expect(await memorySigninStore.list("other-tenant", USER)).toEqual([]);
    const broken = { ...memorySigninStore, record: async () => { throw new Error("db down"); } };
    await expect(persistSigninEvent({ tenantId: TENANT, userId: USER, event: fin.event }, { store: broken })).resolves.toBeUndefined();
  });
});

describe("owner privacy of stored sign-in alert verdicts", () => {
  it("the unauthenticated branch uses a static headline even when the label is unchanged", async () => {
    const analysis = await analyzeRaw(googleForwardedRaw());
    const v = applySigninAlertOverride({ analysis, verdict: triaged("insufficient_evidence", { headline: "Windows in Seattle at 203.0.113.24" }) });
    expect(v.headline).not.toContain("Seattle");
    expect(v.headline).not.toContain("203.0.113.24");
  });

  it("applyAmbiguousSigninCap: caps likely_safe, keeps other labels, always static headline and no check", () => {
    const forged = { provider: "google", event: "new_signin", device_label: "x", first_seen: true } as const;
    const capped = applyAmbiguousSigninCap(triaged("likely_safe", { headline: "Seattle", signin_check: forged }));
    expect(capped).toMatchObject({ verdict: "suspicious", subject_type: "signin_alert" });
    expect(capped.signin_check).toBeUndefined();
    expect(capped.headline).not.toContain("Seattle");
    expect(capped.confidence).toBeLessThanOrEqual(0.6);
    const kept = applyAmbiguousSigninCap(triaged("malicious", { headline: "Seattle" }));
    expect(kept.verdict).toBe("malicious");
    expect(kept.headline).not.toContain("Seattle");
  });

  it("finalizeSigninVerdict caps a model-claimed signin_alert verdict on a non-alert message", async () => {
    const analysis = await analyzeRaw("From: A <a@example.org>\nTo: b@example.com\nSubject: Hi\n\nLunch?\n");
    const fin = await finalizeSigninVerdict({ tenantId: TENANT, userId: USER, analysis, verdict: triaged("likely_safe", { subject_type: "signin_alert" }), source: "forwarded" });
    expect(fin.verdict.verdict).toBe("suspicious");
    expect(fin.event).toBeNull();
  });
});
