import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/dashboard/Dashboard";
import type { HouseholdResponse, VerdictListItem, VerdictSummaryResponse } from "@/lib/dashboard-types";

const OWNER_HOUSEHOLD: HouseholdResponse = {
  tenantId: "t1",
  name: "The Parkers",
  role: "owner",
  members: [
    { userId: "u-owner", name: "Olive", email: "olive@example.test", role: "owner" },
    { userId: "u-max", name: "Max", email: "max@example.test", role: "member" },
  ],
};

function summary(patch: Partial<VerdictSummaryResponse> = {}): VerdictSummaryResponse {
  return {
    sinceDays: 30,
    total: 0,
    byLabel: { malicious: 0, suspicious: 0, likely_safe: 0, insufficient_evidence: 0 },
    bySubjectType: { email: 0, sms: 0, url: 0, page: 0, signin_alert: 0, file: 0, conversation: 0 },
    topIndicators: [],
    topDomains: [],
    perDay: [],
    ...patch,
  };
}

function item(id: string, verdict: VerdictListItem["verdict"], headline: string, userId = "u-max"): VerdictListItem {
  return {
    id,
    subjectType: "url",
    verdict,
    confidence: 0.9,
    headline,
    source: "chat",
    createdAt: new Date().toISOString(),
    userId,
    conversationId: null,
    artifactId: null,
  };
}

const USAGE = {
  monthlyChecks: { used: 7, limit: 50, resetAt: "2099-01-01T00:00:00Z" },
  dailyTokens: { used: 1200, limit: 300000, resetAt: "2099-01-01T00:00:00Z" },
};

let calls: string[];
let data: { summary: VerdictSummaryResponse; lists: Record<string, VerdictListItem[]>; next?: Record<string, string | null> };

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  data = { summary: summary(), lists: {} };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(url.pathname + url.search);
      if (url.pathname === "/api/usage") return json(USAGE);
      if (url.pathname === "/api/verdicts/summary") return json({ ...data.summary, sinceDays: Number(url.searchParams.get("sinceDays")) });
      if (url.pathname === "/api/verdicts") {
        const key = url.searchParams.get("cursor") ?? url.searchParams.get("label") ?? "all";
        return json({ items: data.lists[key] ?? [], nextCursor: data.next?.[key] ?? null });
      }
      return new Response("{}", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dashboard", () => {
  it("shows the empty state for a new household, with forwarding and playbook entry points", async () => {
    render(<Dashboard household={OWNER_HOUSEHOLD} forwardingUsed={false} />);
    expect(await screen.findByText("Nothing checked yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Set up email forwarding/ })).toHaveAttribute("href", "/settings/forwarding");
    expect(screen.getByRole("link", { name: /Check a link/ })).toHaveAttribute("href", "/chat");
    expect(screen.getByRole("link", { name: "I clicked a link" })).toHaveAttribute("href", "/chat?playbook=clicked_link");
    expect(screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/chat?playbook="))).toHaveLength(6);
  });

  it("renders tiles, needs attention, charts, recent activity and load more from the APIs", async () => {
    data.summary = summary({
      total: 12,
      byLabel: { malicious: 2, suspicious: 3, likely_safe: 6, insufficient_evidence: 1 },
      topIndicators: [{ category: "lookalike_domain", count: 4 }],
      topDomains: [{ domain: "paypa1.test", count: 2 }],
      perDay: [{ day: new Date().toISOString().slice(0, 10), malicious: 2, suspicious: 3, likely_safe: 6, insufficient_evidence: 1 }],
    });
    data.lists = {
      malicious: [item("v1", "malicious", "Fake PayPal login")],
      suspicious: [item("v2", "suspicious", "Odd delivery text")],
      all: [item("v1", "malicious", "Fake PayPal login"), item("v3", "likely_safe", "Real bank email", "u-owner")],
      c1: [item("v4", "likely_safe", "Older check")],
    };
    data.next = { all: "c1" };

    render(<Dashboard household={OWNER_HOUSEHOLD} forwardingUsed />);
    const tiles = await screen.findAllByTestId("stat-tile");
    expect(tiles.map((t) => t.textContent)).toEqual(["Checked12", "Dangerous2", "Suspicious3", "Likely safe6"]);

    const attention = screen.getByRole("list", { name: "Needs attention" });
    expect(within(attention).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/verdicts/v1", "/verdicts/v2"]);
    expect(within(attention).getAllByText(/· Max/)).toHaveLength(2); // owner viewing everyone sees who checked it

    expect(screen.getAllByTestId("day-bar")).toHaveLength(30);
    expect(screen.getByText("Lookalike domain")).toBeInTheDocument();
    expect(screen.getByText("paypa1.test")).toBeInTheDocument();
    expect(screen.getByText("Email forwarding is set up")).toBeInTheDocument();
    expect(await screen.findByText(/7/, { selector: "span.text-2xl" })).toBeInTheDocument();

    const recent = screen.getByRole("list", { name: "Recent activity" });
    expect(within(recent).getAllByRole("listitem")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Recent activity" })).getAllByRole("listitem")).toHaveLength(3));
    expect(calls).toContain("/api/verdicts?limit=10&cursor=c1");
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("refetches for the chosen range and member", async () => {
    data.lists = { all: [item("v1", "likely_safe", "Fine")] };
    data.summary = summary({ total: 1, byLabel: { malicious: 0, suspicious: 0, likely_safe: 1, insufficient_evidence: 0 } });
    render(<Dashboard household={OWNER_HOUSEHOLD} forwardingUsed={false} />);
    await screen.findAllByTestId("stat-tile");
    await userEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(calls).toContain("/api/verdicts/summary?sinceDays=7"));
    await userEvent.selectOptions(screen.getByLabelText("Filter by member"), "u-max");
    await waitFor(() => expect(calls).toContain("/api/verdicts/summary?sinceDays=7&userId=u-max"));
    expect(calls).toContain("/api/verdicts?label=malicious&userId=u-max&limit=10");
  });

  it("hides the member filter for members", async () => {
    render(<Dashboard household={{ ...OWNER_HOUSEHOLD, role: "member" }} forwardingUsed={false} />);
    await screen.findByText("Nothing checked yet");
    expect(screen.queryByLabelText("Filter by member")).not.toBeInTheDocument();
  });
});
