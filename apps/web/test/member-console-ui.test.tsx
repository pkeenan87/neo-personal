/** The member console in zero-infrastructure mode (memory twins), its list section and form, and the chat approval buttons. */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberConsole } from "@/components/household/MemberConsole";
import { ProtectionMembers } from "@/components/household/ProtectionMembers";
import { childDefaults } from "@neo/core";
import type { ChildSettings, ChildView, MemberDetailResponse } from "@/lib/member-types";
import { describePolicy, maskEmail } from "@/lib/policy-summary";
import { CONSENT_TEXT_VERSION } from "@/lib/consent-text";
import { createProtectedMember, getMemberDetail, listMemberProfiles, patchMember, putHouseholdTimeZone, putMemberPolicy } from "@/lib/server/member-console";
import { DEV_SESSION_IDS } from "@/lib/server/session-core";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { addMemoryContactMember } from "@/lib/server/memory-members";
import { memoryAuditLog } from "@/lib/server/audit";
import { resetMemoryState, stubBaseEnv } from "./helpers/routes";
import { resetMemoryProtection } from "@/lib/server/memory-members";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }) }));

const owner = { tenantId: "t-mem", userId: "u-owner", role: "owner" as const };

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryProtection();
  setMemoryMembers("t-mem", [
    { userId: "u-owner", name: "Olive", email: "olive@example.test", role: "owner" },
    { userId: "u-max", name: "Max", email: "max@example.test", role: "member" },
  ]);
  addMemoryContactMember("t-mem", { id: "11111111-1111-4111-8111-111111111111", displayName: "Gran", contact: "" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetMemoryState();
  resetMemoryProtection();
});

describe("memory twin (no database)", () => {
  it("lists members with stable ids and modes, owner only", async () => {
    const list = await listMemberProfiles(owner);
    expect(list.ok && list.value.members.map((m) => [m.displayName, m.role, m.mode, m.hasAccount])).toEqual([
      ["Olive", "owner", "standard", true],
      ["Max", "adult", "standard", true],
      ["Gran", "adult", "standard", false],
    ]);
    const again = await listMemberProfiles(owner);
    expect(again.ok && again.value.members.map((m) => m.id)).toEqual(list.ok ? list.value.members.map((m) => m.id) : []);
    expect(await listMemberProfiles({ ...owner, userId: "u-max", role: "owner" })).toMatchObject({ ok: false, status: 403 });
  });

  it("edits name, mode, helpers, contact and policy, and enforces the last-owner rule", async () => {
    const list = await listMemberProfiles(owner);
    if (!list.ok) throw new Error("list");
    const [olive, max, gran] = list.value.members;
    const p = await patchMember(owner, max!.id, { displayName: "Maxi", mode: "elder", consentTextVersion: CONSENT_TEXT_VERSION, elderAttestation: true, helperMemberIds: [olive!.id, gran!.id] });
    expect(p.ok && p.value.member).toMatchObject({ displayName: "Maxi", mode: "elder", helperMemberIds: [olive!.id, gran!.id] });
    expect(await patchMember(owner, olive!.id, { mode: "elder" })).toMatchObject({ ok: false, status: 409 });
    expect(await patchMember(owner, max!.id, { helperMemberIds: [max!.id] })).toMatchObject({ ok: false, status: 400 });
    const c = await patchMember(owner, gran!.id, { contact: "gran@example.test" });
    expect(c.ok && c.value.contactHint).toBe("g***@example.test");
    const pol = await putMemberPolicy(owner, max!.id, { helpersNotifyAt: "critical" });
    expect(pol.ok && pol.value.notify.helpersNotifyAt).toBe("critical");
    const d = await getMemberDetail(owner, max!.id);
    expect(d.ok && d.value.notify.helpersNotifyAt).toBe("critical");
    expect(memoryAuditLog().map((e) => e.eventType)).toEqual(expect.arrayContaining(["member.updated", "member.mode_changed", "member.helpers_changed", "member.policy_changed"]));
  });

  it("creates a member without an account, then turns on Child mode once the time zone and birth year are known", async () => {
    expect(await createProtectedMember({ ...owner, userId: "u-max", role: "owner" }, { displayName: "Sam", role: "child", birthYear: 2015 })).toMatchObject({ ok: false, status: 403 });
    expect(await createProtectedMember(owner, { displayName: "Sam", role: "child" })).toMatchObject({ ok: false, code: "birth_year_required" });
    const made = await createProtectedMember(owner, { displayName: "Sam", role: "child", birthYear: new Date().getUTCFullYear() - 8 });
    if (!made.ok) throw new Error("create");
    expect(made.value.member).toMatchObject({ displayName: "Sam", role: "child", mode: "standard", hasAccount: false });
    expect(made.value.child).toMatchObject({ band: "under_10", timeZone: null });
    const id = made.value.member.id;

    expect(await patchMember(owner, id, { mode: "child" })).toMatchObject({ ok: false, code: "time_zone_required" });
    expect(await putHouseholdTimeZone(owner, { timeZone: "Nope/Nowhere" })).toMatchObject({ ok: false, code: "invalid_time_zone" });
    expect(await putHouseholdTimeZone(owner, { timeZone: "Europe/London" })).toEqual({ ok: true, value: { timeZone: "Europe/London" } });
    const on = await patchMember(owner, id, { mode: "child", consentTextVersion: CONSENT_TEXT_VERSION });
    expect(on.ok && on.value.member.mode).toBe("child");
    expect(on.ok && on.value.child.settings.web.youtubeRestricted).toBe("strict");

    const bad = await putMemberPolicy(owner, id, { web: { block: ["BAD"] } });
    expect(bad).toMatchObject({ ok: false, status: 400, code: "invalid_policy", fields: [{ path: "web.block.0" }] });
    const saved = await putMemberPolicy(owner, id, { web: { block: ["tiktok.com"] } });
    expect(saved.ok && saved.value.child.settings.web.block).toEqual(["tiktok.com"]);
    expect(saved.ok && saved.value.child.customized).toBe(true);
    expect(memoryAuditLog().map((e) => e.eventType)).toEqual(expect.arrayContaining(["member.created", "member.consent_recorded", "household.time_zone_changed"]));
  });

  it("works for the DEV_AUTH_BYPASS identity", async () => {
    const dev = { tenantId: DEV_SESSION_IDS.tenantId, userId: DEV_SESSION_IDS.userId, role: "owner" as const };
    const list = await listMemberProfiles(dev);
    expect(list.ok && list.value.members[0]).toMatchObject({ role: "owner", mode: "standard" });
  });
});

/** A Child view for the 10-13 band with the defaults in force (the shape the server sends). */
function childView(over: Partial<ChildView> = {}): ChildView {
  const d = childDefaults("10_13");
  const settings = {
    web: { ...d.web!, allow: [], block: [] },
    apps: { block: [], approved: [], requireApproval: true },
    screenTime: { dailyMinutes: { mon: 120, tue: 120, wed: 120, thu: 120, fri: 120, sat: 180, sun: 180 }, downtime: [{ start: "21:00", end: "07:00" }], warnMinutes: 10, allowDuringDowntime: [] },
    childRequestsTo: "owners",
  } as ChildSettings;
  return { birthYear: 2015, band: "10_13", bandAssumed: false, adult: false, timeZone: "America/New_York", defaults: settings, settings, customized: false, ...over };
}

function detail(over: Partial<MemberDetailResponse["member"]> = {}, rest: Partial<MemberDetailResponse> = {}): MemberDetailResponse {
  return {
    member: { id: "m1", displayName: "Gran", role: "adult", mode: "elder", hasAccount: false, helperMemberIds: [], hasContact: false, birthYear: null, ...over },
    contactHint: null,
    others: [
      { id: "m2", displayName: "Pat", hasAccount: true },
      { id: "m3", displayName: "Sam", hasAccount: true },
    ],
    notify: { helpersNotifyAt: "high", ownersNotifyAt: "high" },
    policySummary: ["Elder mode: stricter."],
    child: childView({ birthYear: null, bandAssumed: true }),
    isLastOwner: false,
    ...rest,
  };
}

describe("AddMemberForm", () => {
  it("posts a child with a birth year to the create route and opens the new member's page", async () => {
    const fetchMock = vi.fn(async () => Response.json(detail({ id: "new1", displayName: "Sam", role: "child", mode: "standard", birthYear: 2016 }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ProtectionMembers members={[]} />);
    await user.click(screen.getByRole("button", { name: "Add a person without an account" }));
    await user.type(screen.getByLabelText("Name"), "Sam");
    await user.type(screen.getByLabelText("Birth year"), "2016");
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect([url, init.method, JSON.parse(String(init.body))]).toEqual(["/api/household/protected-members", "POST", { displayName: "Sam", role: "child", birthYear: 2016 }]);
  });

  it("asks for an optional email for an adult, not a birth year, and shows an API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Enter one email address.", code: "invalid_email" }, { status: 400 })));
    const user = userEvent.setup();
    render(<ProtectionMembers members={[]} />);
    await user.click(screen.getByRole("button", { name: "Add a person without an account" }));
    await user.selectOptions(screen.getByLabelText("Role"), "adult");
    expect(screen.queryByLabelText("Birth year")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "Nan");
    await user.type(screen.getByLabelText("Email (optional)"), "nan@example.test");
    await user.click(screen.getByRole("button", { name: "Add person" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter one email address.");
  });
});

describe("ProtectionMembers", () => {
  it("lists members with a mode badge and a link to each member page", () => {
    render(
      <ProtectionMembers
        members={[
          { id: "m1", displayName: "Gran", role: "adult", mode: "elder", hasAccount: true, helperMemberIds: [], hasContact: false, birthYear: null },
          { id: "m2", displayName: "Pat", role: "owner", mode: "standard", hasAccount: true, helperMemberIds: [], hasContact: false, birthYear: null },
        ]}
      />,
    );
    const item = screen.getByRole("link", { name: /Gran/ });
    expect(item).toHaveAttribute("href", "/settings/household/members/m1");
    expect(within(item).getByText("Elder mode")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Pat/ })).toHaveAttribute("href", "/settings/household/members/m2");
  });
});

describe("MemberConsole", () => {
  it("offers Child, warns when an Elder has no helpers, and explains the policy", () => {
    render(<MemberConsole initial={detail()} />);
    expect(screen.getByRole("radio", { name: /Child/ })).toBeEnabled();
    expect(screen.getByText(/No helpers are set/)).toBeInTheDocument();
    expect(screen.getByText("Elder mode: stricter.")).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
  });

  it("shows the notice and the helper attestation before Elder mode, and sends both", async () => {
    const fetchMock = vi.fn(async () => Response.json(detail({ mode: "elder", helperMemberIds: ["m2"] })));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MemberConsole initial={detail({ mode: "standard", helperMemberIds: ["m2"] })} />);
    await user.click(screen.getByRole("radio", { name: /Elder/ }));
    expect(screen.getByRole("heading", { name: /Before you turn on Elder mode for Gran/ })).toBeInTheDocument();
    expect(screen.getByText(/Full web addresses/)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save mode" });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /I have read this and told Gran/ }));
    expect(save).toBeDisabled(); // the attestation is separate
    await user.click(screen.getByRole("checkbox", { name: "I set this up with Gran in person and they agreed to these helpers: Pat." }));
    await user.click(save);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toEqual({ mode: "elder", consentTextVersion: CONSENT_TEXT_VERSION, elderAttestation: true });
    expect(screen.getByRole("link", { name: /What Neo shares about Gran/ })).toHaveAttribute("href", "/settings/household/members/m1/shared");
  });

  it("asks for the birth year and time zone when Child is chosen,and saves the time zone before the mode", async () => {
    const fetchMock = vi.fn(async (url: string) => (url === "/api/household/time-zone" ? Response.json({ timeZone: "America/New_York" }) : Response.json(detail({ mode: "child", birthYear: 2015 }, { child: childView() }))));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MemberConsole initial={detail({ mode: "standard" }, { child: childView({ birthYear: null, bandAssumed: true, timeZone: null }) })} />);
    await user.click(screen.getByRole("radio", { name: /Child/ }));
    expect(screen.getByText(/defaults for ages 10 to 13 \(no birth year yet\)/)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save mode" });
    expect(save).toBeDisabled(); // birth year and time zone are required
    await user.type(screen.getByLabelText(/Birth year \(needed for Child mode\)/), "2015");
    const zone = screen.getByLabelText(/Household time zone/);
    await user.clear(zone);
    await user.type(zone, "America/New_York");
    expect(save).toBeDisabled(); // the notice has to be accepted
    expect(screen.getByRole("heading", { name: /Before you turn on Child mode for Gran/ })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /I have read this and told Gran/ }));
    await user.click(save);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [zoneUrl, zoneInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect([zoneUrl, zoneInit.method, JSON.parse(String(zoneInit.body))]).toEqual(["/api/household/time-zone", "PUT", { timeZone: "America/New_York" }]);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect([url, init.method, JSON.parse(String(init.body))]).toEqual(["/api/household/protected-members/m1", "PATCH", { mode: "child", consentTextVersion: CONSENT_TEXT_VERSION, birthYear: 2015 }]);
    expect(await screen.findByText("Child mode is on.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Child settings" })).toBeInTheDocument();
  });

  it("warns that owners are emailed when Child mode is switched off", async () => {
    const user = userEvent.setup();
    render(<MemberConsole initial={detail({ mode: "child", birthYear: 2015 }, { child: childView() })} />);
    await user.click(screen.getByRole("radio", { name: /Standard/ }));
    expect(screen.getByText(/Every owner will get an email saying Child mode was turned off/)).toBeInTheDocument();
  });

  it("edits the Child settings and sends whole sections to the policy route; field errors from the server are shown", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "Some of these settings are not valid.", code: "invalid_policy", fields: [{ path: "web.block.0", message: "must be a lowercase domain such as example.com" }] }, { status: 400 }))
      .mockResolvedValueOnce(Response.json(detail({ mode: "child", birthYear: 2015 }, { child: childView({ customized: true }) })));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MemberConsole initial={detail({ mode: "child", birthYear: 2015 }, { child: childView() })} />);
    expect(screen.getByRole("checkbox", { name: "Self-harm" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Social media" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Social media" }));
    await user.type(screen.getByLabelText(/Always block these sites/), "TikTok.com{enter}discord.com");
    await user.type(screen.getByLabelText("Always block these apps"), "Roblox Corporation | RobloxPlayerBeta.exe{enter}bundle:com.roblox.RobloxPlayer");
    await user.click(screen.getAllByRole("checkbox", { name: /No limit/ })[5]!); // Saturday
    await user.click(screen.getByRole("button", { name: "Add downtime" }));
    await user.click(screen.getByRole("button", { name: "Save child settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect([url, init.method]).toEqual(["/api/household/protected-members/m1/policy", "PUT"]);
    const body = JSON.parse(String(init.body)) as { web: { categories: string[]; block: string[] }; apps: { block: unknown[]; requireApproval: boolean }; screenTime: { dailyMinutes: Record<string, number | null>; downtime: unknown[] } };
    expect(body.web.categories).toContain("social");
    expect(body.web.block).toEqual(["tiktok.com", "discord.com"]);
    expect(body.apps.block).toEqual([{ signer: "Roblox Corporation", image: "RobloxPlayerBeta.exe" }, { bundleId: "com.roblox.RobloxPlayer" }]);
    expect(body.apps.requireApproval).toBe(true);
    expect(body.screenTime.dailyMinutes.sat).toBeNull();
    expect(body.screenTime.dailyMinutes.mon).toBe(120);
    expect(body.screenTime.downtime).toHaveLength(2);
    expect(await screen.findByText(/web\.block\.0: must be a lowercase domain/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save child settings" }));
    expect(await screen.findByText("Child settings saved.")).toBeInTheDocument();
  });

  it("resets to the age defaults by dropping the member's own sections", async () => {
    const fetchMock = vi.fn(async () => Response.json(detail({ mode: "child", birthYear: 2015 }, { child: childView() })));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MemberConsole initial={detail({ mode: "child", birthYear: 2015 }, { child: childView({ customized: true }) })} />);
    await user.click(screen.getByRole("button", { name: "Reset to age defaults" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ web: null, apps: null, screenTime: null, childRequestsTo: null });
    expect(await screen.findByText("Back to the defaults for this age.")).toBeInTheDocument();
  });

  it("makes a one-time device code for a member without an account", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "c1", code: "ABCD-EFGH-JKLM", expiresAt: "2026-11-09T00:00:00Z", memberName: "Gran" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MemberConsole initial={detail()} />);
    await user.click(screen.getByRole("button", { name: "Make a code" }));
    expect(await screen.findByText("ABCD-EFGH-JKLM")).toBeInTheDocument();
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe("/api/household/protected-members/m1/enrollment-codes");
  });

  it("shows the owner role read-only and blocks Elder for the only owner", () => {
    render(<MemberConsole initial={detail({ role: "owner", mode: "standard", hasAccount: true }, { isLastOwner: true })} />);
    expect(screen.getByText(/the owner role can.t be changed here/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Role" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Elder/ })).toBeDisabled();
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
  });

  it("warns that owners are emailed when Elder mode is switched off, and saves through the PATCH route", async () => {
    const fetchMock = vi.fn(async () => Response.json(detail({ mode: "standard" })));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MemberConsole initial={detail()} />);
    await user.click(screen.getByRole("radio", { name: /Standard/ }));
    expect(screen.getByText(/Every owner will get an email/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save mode" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/household/protected-members/m1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ mode: "standard" });
    expect(await screen.findByText("Mode saved.")).toBeInTheDocument();
  });

  it("sends the helper list and the notify limits, and shows an API error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(detail({ helperMemberIds: ["m2"] })))
      .mockResolvedValueOnce(Response.json({ error: "Nope.", code: "invalid" }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MemberConsole initial={detail()} />);
    await user.click(screen.getByRole("checkbox", { name: "Pat" }));
    expect(screen.getByRole("button", { name: "Save helpers" })).toBeDisabled(); // an Elder's helper change needs the attestation
    await user.click(screen.getByRole("checkbox", { name: /I set this up with Gran in person and they agreed to these helpers: Pat/ }));
    await user.click(screen.getByRole("button", { name: "Save helpers" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ helperMemberIds: ["m2"], elderAttestation: true });

    await user.selectOptions(screen.getByLabelText("Email helpers about"), "critical");
    await user.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/api/household/protected-members/m1/policy");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ helpersNotifyAt: "critical", ownersNotifyAt: "high" });
    expect(await screen.findByText("Nope.")).toBeInTheDocument();
  });
});

describe("policy summary", () => {
  it("describes Elder defaults and Standard in plain words", () => {
    const elder = describePolicy("elder", { remote_access: { unknownPeerSeverity: "critical", sessionWindowMinutes: 30 }, payments: { underPressureWindowMinutes: 60 }, notify: { helpersNotifyAt: "high", ownersNotifyAt: "high" }, devices: { protectionDisabledSeverity: "high" } }).join("\n");
    expect(elder).toMatch(/critical/);
    expect(elder).toMatch(/30 minutes/);
    expect(elder).toMatch(/60 minutes/);
    expect(describePolicy("standard", {}).join("\n")).toMatch(/Helpers are only emailed for people in Elder or Child mode/);
    expect(maskEmail("jane@example.com")).toBe("j***@example.com");
    expect(maskEmail("nonsense")).toBe("***");
  });
});
