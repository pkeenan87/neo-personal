import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HouseholdSettingsView } from "@/components/HouseholdSettings";
import { InviteView, deletionSummary } from "@/components/InviteView";
import { ToastProvider } from "@/components/toast-context";
import type { HouseholdResponse } from "@/lib/dashboard-types";
import type { InvitePreviewResponse } from "@/lib/household-types";

vi.mock("@/lib/auth-client", () => ({ signOut: vi.fn(async () => undefined) }));

const SECRET = `neo_inv_${"a".repeat(43)}`;
const ACCOUNT = { email: "grandma@example.test", name: "Grandma" };

const NEW_USER: InvitePreviewResponse = {
  householdName: "Pat's household",
  inviterName: "Pat",
  kind: "email",
  emailMatches: true,
  alreadyMember: false,
  currentHousehold: { name: "Grandma's household", role: "owner", memberCount: 1, conversationCount: 0, verdictCount: 0, hasForwardingAddress: false },
};

const WITH_HISTORY: InvitePreviewResponse = {
  ...NEW_USER,
  currentHousehold: { ...NEW_USER.currentHousehold!, conversationCount: 3, verdictCount: 1, hasForwardingAddress: true },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InviteView", () => {
  it("lets a brand-new user join without an extra confirmation", async () => {
    const fetchMock = vi.fn(async () => Response.json({ tenantId: "t", householdName: "Pat's household" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<InviteView secret={SECRET} preview={NEW_USER} error={null} account={ACCOUNT} />);

    expect(screen.getByRole("heading", { name: "Join Pat's household" })).toBeInTheDocument();
    expect(screen.getByText(/nothing is lost/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Join Pat's household" }));
    expect(fetchMock).toHaveBeenCalledWith(`/api/invites/${SECRET}/accept`, expect.objectContaining({ method: "POST", body: JSON.stringify({ confirmLeave: true }) }));
    expect(await screen.findByText("You joined Pat's household.")).toBeInTheDocument();
  });

  it("lists what will be deleted and requires acknowledging it", async () => {
    render(<InviteView secret={SECRET} preview={WITH_HISTORY} error={null} account={ACCOUNT} />);
    expect(screen.getByText(/3 chats, 1 saved check, your forwarding address/)).toBeInTheDocument();
    const join = screen.getByRole("button", { name: "Join Pat's household" });
    expect(join).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
    expect(join).toBeEnabled();
  });

  it("blocks joining with the wrong account and offers to switch", () => {
    render(<InviteView secret={SECRET} preview={{ ...NEW_USER, emailMatches: false }} error={null} account={ACCOUNT} />);
    expect(screen.getByText(/sent to a different email address/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join Pat's household" })).toBeDisabled();
  });

  it("shows the server's message for each error, with a way forward", async () => {
    const { unmount } = render(
      <InviteView secret={SECRET} preview={null} error={{ code: "not_found", message: "This invite is not valid." }} account={ACCOUNT} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("This invite is not valid.");
    expect(screen.getByText(/Ask the person who invited you/)).toBeInTheDocument();

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Wrong account.", code: "email_mismatch" }, { status: 403 })));
    unmount();
    render(<InviteView secret={SECRET} preview={NEW_USER} error={null} account={ACCOUNT} />);
    await userEvent.click(screen.getByRole("button", { name: "Join Pat's household" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong account.");
    expect(screen.getByRole("button", { name: /Sign out and use a different account/ })).toBeInTheDocument();
  });

  it("summarizes deletions", () => {
    expect(deletionSummary(NEW_USER.currentHousehold!)).toEqual([]);
    expect(deletionSummary(WITH_HISTORY.currentHousehold!)).toEqual(["3 chats", "1 saved check", "your forwarding address"]);
  });
});

describe("HouseholdSettingsView", () => {
  const HOME: HouseholdResponse = {
    tenantId: "t",
    name: "Pat's household",
    role: "owner",
    members: [
      { userId: "u-owner", name: "Pat", email: "pat@example.test", role: "owner" },
      { userId: "u-kid", name: "Kid", email: "kid@example.test", role: "member" },
    ],
    invites: [
      {
        id: "i1",
        kind: "link",
        email: null,
        tokenPrefix: "abcdefgh",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
        invitedByName: "Pat",
      },
    ],
  };

  function renderView(home: HouseholdResponse, currentUserId = "u-owner") {
    return render(
      <ToastProvider>
        <HouseholdSettingsView initial={home} currentUserId={currentUserId} />
      </ToastProvider>,
    );
  }

  it("shows members, invites and a confirmation before removing someone", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/household" ? Response.json({ ...HOME, members: HOME.members.slice(0, 1) }) : new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderView(HOME);
    expect(screen.getByText("Link invite neo_inv_abcdefgh…")).toBeInTheDocument();
    expect(screen.getByText(/expires in 6 days/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Remove Kid" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Remove Kid?" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/household/members/u-kid", { method: "DELETE" });
    // The list refreshes from the server and Kid is gone.
    await vi.waitFor(() => expect(screen.queryByText("Kid")).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith("/api/household", expect.anything());
  });

  it("gives members a leave button and no owner controls", () => {
    renderView({ ...HOME, role: "member", invites: [] }, "u-kid");
    expect(screen.getByRole("button", { name: "Leave household" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.queryByText("Invite someone")).toBeNull();
  });
});
