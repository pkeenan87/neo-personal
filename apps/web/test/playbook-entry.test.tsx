import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@neo/core";
import { ChatInterface } from "@/components/ChatInterface";
import { PlaybookButtons } from "@/components/PlaybookButtons";
import { ToastProvider } from "@/components/toast-context";
import { PLAYBOOK_ENTRIES, playbookPrompt } from "@/lib/playbooks";
import { ndjson, streamingResponse } from "./fixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

const CONV_ID = "11111111-2222-4333-8444-555555555555";
const PLAYBOOK_REPLY: AgentEvent[] = [
  { type: "text_delta", text: "<!-- playbook:clicked_link -->\n" },
  { type: "text_delta", text: "**First, close the page.**" },
  { type: "done", stop_reason: "end_turn" },
];

let agentBodies: Array<Record<string, unknown>>;

beforeEach(() => {
  agentBodies = [];
  window.history.replaceState(null, "", "/chat");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.startsWith("/api/conversations")) return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
      if (url === "/api/agent") {
        agentBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return streamingResponse(ndjson(PLAYBOOK_REPLY), { headers: { "x-conversation-id": CONV_ID } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderChat(props: Partial<React.ComponentProps<typeof ChatInterface>> = {}) {
  return render(
    <StrictMode>
      <ToastProvider>
        <ChatInterface user={{ name: "Pat", email: "pat@example.test" }} initialConversations={[]} conversationId={null} {...props} />
      </ToastProvider>
    </StrictMode>,
  );
}

describe("playbook entry points", () => {
  it("chat empty state shows the six playbooks; clicking one sends it with its id", async () => {
    renderChat();
    const group = screen.getByRole("list", { name: "Get help with something that already happened" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(PLAYBOOK_ENTRIES.map((e) => e.title));

    await userEvent.click(within(group).getByRole("button", { name: "I shared a code" }));
    await waitFor(() => expect(agentBodies).toHaveLength(1));
    expect(agentBodies[0]).toEqual({ message: playbookPrompt("shared_code"), playbook: "shared_code" });
    // The marker is hidden in the rendered reply.
    expect(await screen.findByText("First, close the page.")).toBeInTheDocument();
    expect(screen.queryByText(/playbook:clicked_link/)).not.toBeInTheDocument();
  });

  it("/chat?playbook=<id> auto-sends exactly once (StrictMode) and clears the query", async () => {
    window.history.replaceState(null, "", "/chat?playbook=clicked_link");
    renderChat({ autoStart: { message: playbookPrompt("clicked_link"), playbook: "clicked_link" } });
    expect(await screen.findByText("First, close the page.")).toBeInTheDocument();
    expect(agentBodies).toEqual([{ message: "I think I clicked a link in a suspicious message. Help me.", playbook: "clicked_link" }]);
    expect(window.location.search).toBe("");
  });

  it("'Ask Neo about this' auto-sends the verdict id, never the verdict itself", async () => {
    renderChat({ autoStart: { message: 'Tell me more about this check: "Fake PayPal"', verdictId: "00000000-0000-4000-8000-000000000001" } });
    await waitFor(() => expect(agentBodies).toHaveLength(1));
    expect(agentBodies[0]).toEqual({ message: 'Tell me more about this check: "Fake PayPal"', verdictId: "00000000-0000-4000-8000-000000000001" });
  });

  it("?check=<url> pre-fills the composer without sending", async () => {
    renderChat({ prefill: "Check this link again: https://bit.ly/3xYz" });
    expect(screen.getByLabelText("Message Neo")).toHaveValue("Check this link again: https://bit.ly/3xYz");
    await new Promise((r) => setTimeout(r, 20));
    expect(agentBodies).toHaveLength(0);
  });

  it("dashboard buttons link to /chat?playbook=<id>", () => {
    render(<PlaybookButtons />);
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(PLAYBOOK_ENTRIES.map((e) => `/chat?playbook=${e.id}`));
  });
});
