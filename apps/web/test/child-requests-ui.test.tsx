import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildRequestsPanel } from "@/components/household/ChildRequestsPanel";
import { DecideRequestView } from "@/components/household/DecideRequestView";
import type { ChildRequestItem } from "@/lib/child-request-types";

afterEach(() => vi.unstubAllGlobals());

const item = (over: Partial<ChildRequestItem> = {}): ChildRequestItem => ({
  id: "11111111-1111-4111-8111-111111111111",
  memberId: "m1",
  memberName: "Sam",
  deviceName: "Family PC",
  kind: "more_time",
  detail: { minutes: 30 },
  summary: "30 more minutes",
  reason: "I am on a call <b>with</b> my class",
  status: "pending",
  createdAt: "2026-11-02T15:00:00.000Z",
  expiresAt: "2026-11-03T05:00:00.000Z",
  decidedAt: null,
  grant: null,
  ...over,
});

describe("ChildRequestsPanel", () => {
  it("renders nothing without requests", () => {
    const { container } = render(<ChildRequestsPanel initial={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists a request with the child's words quoted as text, and approves with the owner's minutes", async () => {
    const fetchMock = vi.fn(async () => Response.json({ request: item({ status: "approved" }), message: "Sam now has 45 more minutes today on Family PC." }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ChildRequestsPanel initial={[item()]} />);
    expect(screen.getByRole("heading", { name: "Requests (1 waiting)" })).toBeInTheDocument();
    // The reason is text, never markup, and says Neo does not act on it.
    expect(screen.getByText("“I am on a call <b>with</b> my class”")).toBeInTheDocument();
    expect(screen.getByText(/Sam wrote this. Neo does not act on it/)).toBeInTheDocument();
    expect(screen.getByText(/Approving gives Sam 30 minutes today on Family PC/)).toBeInTheDocument();

    const minutes = screen.getByRole("spinbutton", { name: /Minutes to give/ });
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "45");
    expect(screen.getByText(/Approving gives Sam 45 minutes today/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/household/requests/11111111-1111-4111-8111-111111111111/decision",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "approve", minutes: 45 }) }),
    );
    expect(await screen.findByText("Sam now has 45 more minutes today on Family PC.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("will not send minutes outside 1 to 120", async () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<ChildRequestsPanel initial={[item()]} />);
    const minutes = screen.getByRole("spinbutton");
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "121");
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  });

  it("offers once or always for a site, and sends the scope", async () => {
    const fetchMock = vi.fn(async () => Response.json({ request: item({ kind: "unblock_site", status: "approved" }), message: "example.com is now always allowed for Sam." }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ChildRequestsPanel initial={[item({ kind: "unblock_site", detail: { domain: "example.com" }, summary: "example.com", reason: null })]} />);
    expect(screen.getByLabelText("Just for 1 hour")).toBeChecked();
    await userEvent.click(screen.getByLabelText("Always"));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ decision: "approve", scope: "always" }) }));
  });

  it("denies, and shows the server's error without changing the list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "This request was already approved.", code: "already_decided" }, { status: 409 })));
    render(<ChildRequestsPanel initial={[item({ reason: null })]} />);
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This request was already approved.");
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("shows answered requests without buttons", () => {
    render(<ChildRequestsPanel initial={[item({ status: "denied" })]} />);
    const list = screen.getByRole("list");
    expect(within(list).getByText("Said no")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("DecideRequestView", () => {
  it("shows the request with a confirm and posts the token with the owner's choice", async () => {
    const fetchMock = vi.fn(async () => Response.json({ request: item({ status: "denied" }), message: "You said no to Sam's request for 30 more minutes. Nothing was changed." }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DecideRequestView state="ready" request={item()} token="tok123" action="deny" />);
    expect(screen.getByText(/Nothing happens until you press a button/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled(); // opening the page decides nothing
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ decision: "deny", token: "tok123" }) }));
    expect(await screen.findByRole("status")).toHaveTextContent("You said no to Sam's request");
  });

  it.each([
    ["forbidden", /Only a household owner/],
    ["decided", /already been answered/],
    ["expired", /has expired/],
    ["token_invalid", /isn't valid/],
    ["token_expired", /24 hours/],
  ] as const)("says plainly why a %s link does nothing", (state, text) => {
    render(<DecideRequestView state={state} request={null} token="t" action="approve" />);
    expect(screen.getByRole("alert")).toHaveTextContent(text);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
