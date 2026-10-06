import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { scoreAccountHardening, type AccountHardeningAnswerInput, type AccountHardeningItemId } from "@neo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HardeningChecklist } from "@/components/HardeningChecklist";
import { HardeningCard } from "@/components/dashboard/HardeningCard";
import { hardeningItemViews } from "@/lib/server/hardening-view";

const ASOF = new Date("2026-10-05T12:00:00Z");
const items = hardeningItemViews();
const ans = (itemId: AccountHardeningItemId, value: boolean | "not_applicable", daysAgo = 1): AccountHardeningAnswerInput =>
  ({ itemId, value, checklistVersion: "account-hardening-v1", answeredAt: new Date(+ASOF - daysAgo * 86_400_000) });
const NEEDS = { forwarding_used_30d: "needs_action", browser_extension_enrolled: "needs_action", desktop_agent_enrolled: "needs_action" } as const;
const score = (answers: AccountHardeningAnswerInput[], evidence = NEEDS as Record<string, "complete" | "needs_action" | "unknown">) =>
  scoreAccountHardening({ answers, evidence, asOf: ASOF });
afterEach(() => vi.unstubAllGlobals());

describe("HardeningCard", () => {
  it("shows the percentage, the partial label, and exactly the next three actions in order", () => {
    const s = score([ans("primary_email_2fa", true), ans("passkey_or_hardware_key", true), ans("password_manager", true)],
      { ...NEEDS, forwarding_used_30d: "unknown" });
    render(<HardeningCard score={s} items={items} />);
    expect(screen.getByText("47%")).toBeInTheDocument();
    expect(screen.getByText(/Partial/)).toBeInTheDocument();
    const list = screen.getByRole("list");
    const texts = within(list).getAllByRole("listitem").map(li => li.textContent);
    expect(texts).toEqual([
      "Turn on a port-out PIN or lock with your mobile carrier.",
      "Place a security freeze with Equifax, Experian, and TransUnion.",
      "Turn on automatic security updates for your operating systems and browsers.",
    ].map(t => t));
    expect(screen.getByRole("link", { name: "Open checklist" })).toHaveAttribute("href", "/settings/hardening");
  });

  it("shows not enough answers instead of a percentage", () => {
    render(<HardeningCard score={score([ans("password_manager", true)])} items={items} />);
    expect(screen.getByText(/Not enough answers yet/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("shows owners other members' percentages only, with no item detail", () => {
    render(<HardeningCard score={score([])} items={items} members={[
      { userId: "u1", name: "Max", scorePercent: 60 }, { userId: "u2", name: "Gran", scorePercent: null },
    ]} />);
    const rows = screen.getAllByRole("listitem").filter(li => /Max|Gran/.test(li.textContent ?? ""));
    expect(rows.map(r => r.textContent)).toEqual(["Max60%", "GranNot enough answers"]);
    expect(screen.queryByText(/incomplete|open item/i)).toBeNull();
  });

  it("shows no household section for members", () => {
    render(<HardeningCard score={score([])} items={items} />);
    expect(screen.queryByText("Household members")).toBeNull();
  });
});

describe("HardeningChecklist", () => {
  it("lists every item with weights, You told Neo labels, and stale/unanswered/unknown states", () => {
    const s = score([ans("primary_email_2fa", true), ans("passkey_or_hardware_key", false), ans("password_manager", true, 200)],
      { ...NEEDS, forwarding_used_30d: "unknown" });
    render(<HardeningChecklist initialScore={s} items={items} />);
    expect(screen.getAllByRole("listitem").filter(li => li.querySelector("h2"))).toHaveLength(10);
    expect(screen.getByText("You told Neo: Yes (2026-10-04)")).toBeInTheDocument();
    expect(screen.getByText("You told Neo: No (2026-10-04)")).toBeInTheDocument();
    expect(screen.getByText(/Answer is over 180 days old/)).toBeInTheDocument();
    expect(screen.getAllByText("Status: Not answered").length).toBeGreaterThan(0);
    expect(screen.getByText("Status: Data unavailable right now")).toBeInTheDocument();
    expect(screen.queryByText(/verified/i, { selector: "p.text-sm.font-medium" })).toBeNull();
    expect(screen.getAllByText("15 points").length).toBe(3);
  });

  it("opens only first-party help links in a new tab with noopener noreferrer", () => {
    render(<HardeningChecklist initialScore={score([])} items={items} />);
    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThan(15);
    for (const a of links) {
      expect(a.getAttribute("href")).toMatch(/^https:\/\/(support\.|www\.)/);
      expect(a).toHaveAttribute("rel", "noopener noreferrer");
      expect(a).toHaveAttribute("target", "_blank");
    }
  });

  it("offers not applicable only for the three eligibility exceptions and never a member switcher", () => {
    render(<HardeningChecklist initialScore={score([])} items={items} />);
    expect(screen.getAllByRole("button", { name: "Not applicable" })).toHaveLength(3);
    expect(screen.queryByRole("combobox")).toBeNull();
    const desktop = screen.getByRole("group", { name: "Your answer for Desktop agent enrolled" });
    expect(within(desktop).queryByRole("button", { name: "Yes" })).toBeNull();
  });

  it("posts the answer with the checklist version and updates from the response", async () => {
    const next = score([ans("primary_email_2fa", true)]);
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(next));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<HardeningChecklist initialScore={score([])} items={items} />);
    const group = screen.getByRole("group", { name: "Your answer for Two-factor authentication on your primary email" });
    await user.click(within(group).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(screen.getByText("You told Neo: Yes (2026-10-04)")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/hardening-score/answers", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ itemId: "primary_email_2fa", checklistVersion: "account-hardening-v1", value: true });
  });

  it("shows an error and keeps the old state when saving fails or the version changed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("{}", { status: 409 })).mockRejectedValueOnce(new Error("offline")));
    const user = userEvent.setup();
    render(<HardeningChecklist initialScore={score([])} items={items} />);
    const group = screen.getByRole("group", { name: "Your answer for Password manager" });
    await user.click(within(group).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The checklist changed"));
    await user.click(within(group).getByRole("button", { name: "No" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save"));
    expect(screen.queryByText(/You told Neo:/)).toBeNull();
  });
});
