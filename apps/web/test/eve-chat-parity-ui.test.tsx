/**
 * /chat-v2 parity with the old chat (_specs/v2-m3-cutover.md 2d): Neo's replies are rendered with the same
 * MessageContent / VerdictCard the old chat uses, so a verdict block becomes a card; playbook entry points
 * send the same prompts; the "Was this you?" answer shows what became of it.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EveChat } from "@/app/chat-v2/EveChat";
import { playbookPrompt } from "@/lib/playbooks";
import type { Verdict } from "@neo/verdict";

const hoisted = vi.hoisted(() => ({ agent: {} as Record<string, unknown> }));
vi.mock("eve/react", () => ({ useEveAgent: () => hoisted.agent }));
vi.mock("eve/events", () => ({ openInteractions: () => [] }));

const verdict: Verdict = {
  subject_type: "url",
  verdict: "malicious",
  confidence: 0.93,
  headline: "This link is a fake bank login page.",
  indicators: [{ severity: "high", category: "lookalike_domain", evidence: "examp1e-bank.test", explanation: "Imitates a bank." }],
  recommended_actions: [{ action: "Do not enter your password.", urgency: "now" }],
  iocs: { urls: [], domains: ["examp1e-bank.test"], ips: [], hashes: [], phone_numbers: [] },
};
const reply = (text: string) => `Here is what I found.\n\n\`\`\`verdict\n${JSON.stringify(verdict)}\n\`\`\`\n${text}`;

function setup(messages: unknown[] = [], status = "idle") {
  const send = vi.fn(async () => undefined);
  hoisted.agent = { messages, status, error: null, view: {}, send, respond: vi.fn(), newSession: vi.fn() };
  return send;
}
const message = (role: string, text: string, id = "m1") => ({ id, role, parts: [{ type: "text", id: `${id}-p`, text }] });

afterEach(() => vi.clearAllMocks());

describe("verdict cards (2d)", () => {
  it("renders a verdict block in Neo's reply as the old chat's VerdictCard", () => {
    setup([message("assistant", reply("Stay safe."))]);
    render(<EveChat />);
    expect(screen.getByText("Dangerous")).toBeInTheDocument();
    expect(screen.getByText("This link is a fake bank login page.")).toBeInTheDocument();
    expect(screen.getByText("Do not enter your password.")).toBeInTheDocument();
    expect(screen.getByText("Here is what I found.")).toBeInTheDocument();
    expect(screen.getByText("Stay safe.")).toBeInTheDocument();
    expect(screen.queryByText(/"subject_type"/)).not.toBeInTheDocument(); // not raw JSON
  });

  it("shows a placeholder while the block streams, and a notice for an invalid one", () => {
    setup([message("assistant", "Looking.\n\n```verdict\n{\"subject_type\": \"url\"")], "busy");
    const { unmount } = render(<EveChat />);
    expect(screen.getByTestId("verdict-pending")).toBeInTheDocument();
    unmount();

    setup([message("assistant", "```verdict\n{not json}\n```")]);
    render(<EveChat />);
    expect(screen.getByTestId("verdict-invalid")).toBeInTheDocument();
  });

  it("never turns the user's own text into a card, and hides the playbook marker", () => {
    setup([message("user", reply("hi"), "u1"), message("assistant", "<!-- playbook:clicked_link -->\nFirst, close that page.", "a1")]);
    render(<EveChat />);
    expect(screen.queryByText("Dangerous")).not.toBeInTheDocument();
    expect(screen.getByText("First, close that page.")).toBeInTheDocument();
    expect(screen.queryByText(/playbook:clicked_link/)).not.toBeInTheDocument();
  });
});

describe("playbooks (2c)", () => {
  it("offers the old chat's entry points on an empty chat and sends their prompt", async () => {
    const send = setup();
    const user = userEvent.setup();
    render(<EveChat />);
    await user.click(screen.getByRole("button", { name: "I clicked a link" }));
    expect(send).toHaveBeenCalledWith(playbookPrompt("clicked_link"), undefined);
  });

  it("does not crowd an incident chat or a conversation that has begun", () => {
    setup([message("user", "hello", "u1")]);
    const { unmount } = render(<EveChat />);
    expect(screen.queryByRole("button", { name: "I clicked a link" })).not.toBeInTheDocument();
    unmount();
    setup();
    render(<EveChat incidentId="11111111-1111-4111-8111-111111111111" resumeSessionId="s" />);
    expect(screen.queryByRole("button", { name: "I clicked a link" })).not.toBeInTheDocument();
  });
});

describe('"Was this you?" (2e)', () => {
  const tool = (state: string, output?: unknown, outcome?: string) => ({
    id: "m2",
    role: "assistant",
    parts: [{ type: "tool", callId: "c1", name: "confirm_signin", state, output, interaction: outcome ? { outcome } : undefined }],
  });

  it("says what became of the answer, and never claims success without ok", () => {
    setup([tool("completed", { ok: true, message: "Got it. Neo will treat that device as yours from now on." })]);
    const { unmount } = render(<EveChat />);
    expect(screen.getByText("Got it. Neo will treat that device as yours from now on.")).toBeInTheDocument();
    unmount();

    setup([tool("completed", { ok: false, error: "not_found", message: "Neo cannot find that sign-in alert." })]);
    const second = render(<EveChat />);
    expect(screen.getByText("Neo could not do that, so nothing was confirmed.")).toBeInTheDocument();
    second.unmount();

    setup([tool("rejected", undefined, "declined")]);
    render(<EveChat />);
    expect(screen.getByText("Denied. Nothing was changed.")).toBeInTheDocument();
  });
});
