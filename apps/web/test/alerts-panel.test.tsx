import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertsPanel } from "@/components/dashboard/AlertsPanel";
import type { AlertItem, AlertListResponse } from "@/lib/alert-types";

function alert(over: Partial<AlertItem> = {}): AlertItem {
  return {
    id: crypto.randomUUID(),
    kind: "member_verdict",
    severity: "high",
    title: "Kid checked something malicious",
    body: 'Kid asked Neo about a link. Summary: "Fake PayPal login page."',
    subjectUserId: "user-kid",
    subjectName: "Kid",
    verdictId: "v-1",
    createdAt: new Date().toISOString(),
    acknowledgedAt: null,
    acknowledgedByName: null,
    ...over,
  };
}

function response(items: AlertItem[]): AlertListResponse {
  return { items, nextCursor: null, openCount: items.length, urgentCount: items.filter((a) => a.severity === "high").length };
}

afterEach(() => vi.unstubAllGlobals());

describe("AlertsPanel", () => {
  it("renders nothing without open alerts", () => {
    const { container } = render(<AlertsPanel initial={response([])} isOwner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows owners the member, a link to the check, and marks alerts as seen", async () => {
    const a = alert();
    const b = alert({ kind: "member_joined", severity: "high", title: "Kid joined your household", verdictId: null });
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    render(<AlertsPanel initial={response([a, b])} isOwner />);

    expect(screen.getByRole("region", { name: "Alerts" })).toBeInTheDocument();
    expect(screen.getAllByText(/Kid ·/)).toHaveLength(2);
    expect(screen.getByRole("link", { name: /See the check/ })).toHaveAttribute("href", "/verdicts/v-1");

    await userEvent.click(screen.getByRole("button", { name: `Mark "${a.title}" as seen` }));
    expect(fetchMock).toHaveBeenCalledWith(`/api/alerts/${a.id}/acknowledge`, { method: "POST" });
    expect(screen.queryByText(a.title)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Mark all as seen" }));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/alerts/acknowledge-all", { method: "POST" });
    expect(screen.queryByRole("region", { name: "Alerts" })).toBeNull();
  });

  it("gives members a read-only list about themselves", () => {
    render(<AlertsPanel initial={response([alert()])} isOwner={false} />);
    expect(screen.getByRole("region", { name: "Alerts about you" })).toBeInTheDocument();
    expect(screen.getByText("The household owner was told about these.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the alert and shows an error when acknowledging fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    const a = alert();
    render(<AlertsPanel initial={response([a])} isOwner />);
    await userEvent.click(screen.getByRole("button", { name: `Mark "${a.title}" as seen` }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't update the alert");
    expect(screen.getByText(a.title)).toBeInTheDocument();
  });
});
