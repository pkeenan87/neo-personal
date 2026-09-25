import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checklistKey, VerdictDetail } from "@/components/dashboard/VerdictDetail";
import { ToastProvider } from "@/components/toast-context";
import type { VerdictDetailResponse } from "@/lib/dashboard-types";
import { VERDICT_FIXTURE } from "./fixtures";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

const ID = "00000000-0000-4000-8000-000000000042";

function detail(patch: Partial<VerdictDetailResponse> = {}): VerdictDetailResponse {
  return {
    id: ID,
    subjectType: VERDICT_FIXTURE.subject_type,
    verdict: VERDICT_FIXTURE.verdict,
    confidence: VERDICT_FIXTURE.confidence,
    headline: VERDICT_FIXTURE.headline,
    source: "chat",
    createdAt: "2026-09-20T12:00:00.000Z",
    userId: "u1",
    conversationId: "11111111-2222-4333-8444-555555555555",
    artifactId: null,
    body: VERDICT_FIXTURE,
    conversation: { id: "11111111-2222-4333-8444-555555555555", title: "Is this text real?" },
    artifact: null,
    inbound: null,
    memberName: "Max",
    ...patch,
  };
}

function show(d: VerdictDetailResponse) {
  return render(
    <ToastProvider>
      <VerdictDetail detail={d} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  push.mockReset();
});

describe("VerdictDetail", () => {
  it("renders the card, warning signs, IOCs, origin and the Ask Neo link", () => {
    show(detail());
    expect(screen.getByRole("article", { name: "Verdict: Suspicious" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ask Neo about this/ })).toHaveAttribute("href", `/chat?verdict=${ID}`);
    expect(screen.getByRole("link", { name: "Is this text real?" })).toHaveAttribute("href", "/chat/11111111-2222-4333-8444-555555555555");

    const signs = screen.getByRole("region", { name: "Warning signs" });
    const rows = within(signs).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]!.textContent)).toEqual(["high", "low"]);

    const iocs = screen.getByRole("region", { name: "Links, domains and numbers involved" });
    expect(within(iocs).getAllByTestId("ioc-row")).toHaveLength(4);
    expect(within(iocs).getByRole("link", { name: /Check this URL again/ })).toHaveAttribute(
      "href",
      `/chat?check=${encodeURIComponent("https://bit.ly/3xYz")}`,
    );
    expect(within(iocs).getByRole("button", { name: "Copy https://bit.ly/3xYz" })).toBeInTheDocument();
    // No artifact → no evidence section.
    expect(screen.queryByRole("region", { name: "Evidence" })).not.toBeInTheDocument();
  });

  it("persists the actions checklist in localStorage only", async () => {
    const { unmount } = show(detail());
    const list = screen.getByRole("region", { name: "Your checklist" });
    const boxes = within(list).getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    await userEvent.click(boxes[1]!);
    expect(boxes[1]).toBeChecked();
    expect(window.localStorage.getItem(checklistKey(ID))).toBe("[1]");
    unmount();
    show(detail());
    expect(within(screen.getByRole("region", { name: "Your checklist" })).getAllByRole("checkbox")[1]).toBeChecked();
  });

  it("shows an image artifact inline with a download link and expiry", () => {
    show(
      detail({
        artifactId: "a1",
        artifact: { id: "a1", kind: "image", filename: "shot.png", mimeType: "image/png", sizeBytes: 50_000, expiresAt: "2026-10-20T00:00:00.000Z", expired: false },
      }),
    );
    const evidence = screen.getByRole("region", { name: "Evidence" });
    expect(within(evidence).getByRole("img", { name: "Evidence: shot.png" })).toHaveAttribute("src", "/api/artifacts/a1");
    expect(within(evidence).getByRole("link", { name: /Download/ })).toHaveAttribute("href", "/api/artifacts/a1?download=1");
    expect(evidence).toHaveTextContent(/kept until October 20, 2026/);
  });

  it("offers the raw email for .eml evidence and explains expired or missing evidence", () => {
    const eml = { id: "a2", kind: "eml", filename: "m.eml", mimeType: "message/rfc822", sizeBytes: 900, expiresAt: null, expired: false };
    const { unmount } = show(detail({ artifactId: "a2", artifact: eml }));
    expect(screen.getByRole("link", { name: /Download raw email/ })).toBeInTheDocument();
    unmount();

    const r2 = show(detail({ artifactId: "a2", artifact: { ...eml, expiresAt: "2026-09-01T00:00:00.000Z", expired: true } }));
    expect(screen.getByRole("region", { name: "Evidence" })).toHaveTextContent(/expired on September 1, 2026/);
    expect(screen.queryByRole("link", { name: /Download/ })).not.toBeInTheDocument();
    r2.unmount();

    show(detail({ artifactId: "a2", artifact: null }));
    expect(screen.getByRole("region", { name: "Evidence" })).toHaveTextContent(/no longer available/);
  });

  it("describes forwarded and deleted-conversation origins", () => {
    const { unmount } = show(
      detail({ source: "inbound", conversation: null, conversationId: null, inbound: { status: "done", receivedAt: "2026-09-02T09:00:00.000Z", forwardedBy: "Olive" } }),
    );
    expect(screen.getByRole("region", { name: "Where this came from" })).toHaveTextContent("Forwarded by Olive on September 2, 2026");
    unmount();
    show(detail({ conversation: null, conversationId: null }));
    expect(screen.getByRole("region", { name: "Where this came from" })).toHaveTextContent(/conversation that has since been deleted/);
  });

  it("deletes after confirmation and returns to the dashboard", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    show(detail());
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: /Delete this check and its evidence/ }));
    expect(fetchMock).toHaveBeenCalledWith(`/api/verdicts/${ID}`, { method: "DELETE" });
    expect(push).toHaveBeenCalledWith("/dashboard");
    vi.unstubAllGlobals();
  });
});
