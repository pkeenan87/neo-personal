/** The member console in zero-infrastructure mode (memory twins), its list section and form, and the chat approval buttons. */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberConsole } from "@/components/household/MemberConsole";
import { ProtectionMembers } from "@/components/household/ProtectionMembers";
import type { MemberDetailResponse } from "@/lib/member-types";
import { describePolicy, maskEmail } from "@/lib/policy-summary";
import { getMemberDetail, listMemberProfiles, patchMember, putMemberPolicy } from "@/lib/server/member-console";
import { DEV_SESSION_IDS } from "@/lib/server/session-core";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { addMemoryContactMember } from "@/lib/server/memory-members";
import { memoryAuditLog } from "@/lib/server/audit";
import { resetMemoryState, stubBaseEnv } from "./helpers/routes";
import { resetMemoryProtection } from "@/lib/server/memory-members";

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
    const p = await patchMember(owner, max!.id, { displayName: "Maxi", mode: "elder", helperMemberIds: [olive!.id, gran!.id] });
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

  it("works for the DEV_AUTH_BYPASS identity", async () => {
    const dev = { tenantId: DEV_SESSION_IDS.tenantId, userId: DEV_SESSION_IDS.userId, role: "owner" as const };
    const list = await listMemberProfiles(dev);
    expect(list.ok && list.value.members[0]).toMatchObject({ role: "owner", mode: "standard" });
  });
});

function detail(over: Partial<MemberDetailResponse["member"]> = {}, rest: Partial<MemberDetailResponse> = {}): MemberDetailResponse {
  return {
    member: { id: "m1", displayName: "Gran", role: "adult", mode: "elder", hasAccount: false, helperMemberIds: [], hasContact: false, ...over },
    contactHint: null,
    others: [
      { id: "m2", displayName: "Pat", hasAccount: true },
      { id: "m3", displayName: "Sam", hasAccount: true },
    ],
    notify: { helpersNotifyAt: "high", ownersNotifyAt: "high" },
    policySummary: ["Elder mode: stricter."],
    isLastOwner: false,
    ...rest,
  };
}

describe("ProtectionMembers", () => {
  it("lists members with a mode badge and a link to each member page", () => {
    render(
      <ProtectionMembers
        members={[
          { id: "m1", displayName: "Gran", role: "adult", mode: "elder", hasAccount: true, helperMemberIds: [], hasContact: false },
          { id: "m2", displayName: "Pat", role: "owner", mode: "standard", hasAccount: true, helperMemberIds: [], hasContact: false },
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
  it("shows Child as coming soon, warns when an Elder has no helpers, and explains the policy", () => {
    render(<MemberConsole initial={detail()} />);
    expect(screen.getByRole("radio", { name: /Child.*coming soon/ })).toBeDisabled();
    expect(screen.getByText(/No helpers are set/)).toBeInTheDocument();
    expect(screen.getByText("Elder mode: stricter.")).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Save helpers" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ helperMemberIds: ["m2"] });

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
