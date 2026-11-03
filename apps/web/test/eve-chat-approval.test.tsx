/** /chat-v2 shows the agent's approval requests with Approve / Deny buttons and what became of an acting tool call. */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EveChat } from "@/app/chat-v2/EveChat";

const hoisted = vi.hoisted(() => ({
  agent: {} as Record<string, unknown>,
  open: [] as unknown[],
}));
vi.mock("eve/react", () => ({ useEveAgent: () => hoisted.agent }));
vi.mock("eve/events", () => ({ openInteractions: () => hoisted.open }));

function setup(over: { messages?: unknown[]; open?: unknown[]; status?: string } = {}) {
  const respond = vi.fn(async () => undefined);
  hoisted.agent = { messages: over.messages ?? [], status: over.status ?? "idle", error: null, view: {}, send: vi.fn(async () => undefined), respond, newSession: vi.fn() };
  hoisted.open = over.open ?? [];
  return respond;
}

const approval = (id = "i1") => ({
  interactionId: id,
  request: { kind: "approval", prompt: "Close this alert as handled? Neo will not change any settings.", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] },
  answer: undefined,
});

const toolMessage = (name: string, state: string, output?: unknown, outcome?: string) => ({
  id: "m1",
  role: "assistant",
  parts: [{ type: "tool", callId: "c1", name, state, output, interaction: outcome ? { outcome } : undefined }],
});

afterEach(() => vi.clearAllMocks());

describe("EveChat approvals", () => {
  it("renders the prompt with Approve and Deny, and answers with the option id", async () => {
    const respond = setup({ open: [approval()] });
    const user = userEvent.setup();
    render(<EveChat />);
    expect(screen.getByRole("group", { name: "Your approval is needed" })).toBeInTheDocument();
    expect(screen.getByText(/Close this alert as handled/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(respond).toHaveBeenCalledWith([{ interactionId: "i1", optionId: "approve" }]);
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(respond).toHaveBeenLastCalledWith([{ interactionId: "i1", optionId: "deny" }]);
  });

  it("falls back to Approve / Deny when the request carries no options, and ignores other requests", () => {
    setup({ open: [{ interactionId: "i2", request: { kind: "approval", prompt: "Go?" }, answer: undefined }, { interactionId: "i3", request: { kind: "question", prompt: "Which?" }, answer: undefined }] });
    render(<EveChat />);
    expect(screen.getAllByRole("button", { name: /Approve|Deny/ })).toHaveLength(2);
    expect(screen.queryByText("Which?")).not.toBeInTheDocument();
  });

  it("hides a request once an answer was submitted", () => {
    setup({ open: [{ ...approval(), answer: { optionId: "approve" } }] });
    render(<EveChat />);
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("shows the tool result only when it says ok, and never claims success otherwise", () => {
    setup({ messages: [toolMessage("allow_once", "completed", { ok: true, message: "The alert is closed as handled. No settings were changed." })] });
    const { unmount } = render(<EveChat />);
    expect(screen.getByText("The alert is closed as handled. No settings were changed.")).toBeInTheDocument();
    unmount();

    setup({ messages: [toolMessage("mark_expected", "completed", { ok: false, error: "not_remote_access", message: "This alert isn't about a remote-access tool." })] });
    const second = render(<EveChat />);
    expect(screen.getByText("Neo could not do that, so nothing was confirmed.")).toBeInTheDocument();
    second.unmount();

    setup({ messages: [toolMessage("allow_once", "rejected", undefined, "declined")] });
    render(<EveChat />);
    expect(screen.getByText("Denied. Nothing was changed.")).toBeInTheDocument();
  });

  it("says nothing about other tools", () => {
    setup({ messages: [toolMessage("get_incident", "completed", { id: "x" })] });
    render(<EveChat />);
    expect(screen.queryByText(/nothing was confirmed/i)).not.toBeInTheDocument();
  });
});
