import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInterface } from "@/components/ChatInterface";
import { Toaster } from "@/components/Toaster";
import { ToastProvider } from "@/components/toast-context";
import { messagesFromStored } from "@/lib/chat-state";
import type { AgentEvent } from "@neo/core";
import { ndjson, streamingResponse, VERDICT_FIXTURE } from "./fixtures";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

const CONV_ID = "11111111-2222-4333-8444-555555555555";

const CHECK_URL_EVENTS: AgentEvent[] = [
  { type: "thinking", text: "Run check_url." },
  { type: "text_delta", text: "Let me check " },
  { type: "text_delta", text: "that link." },
  { type: "tool_start", id: "tu_1", name: "check_url", input: { url: "https://evil.test" } },
  { type: "tool_result", id: "tu_1", name: "check_url", result: { heuristics: ["lookalike"] } },
  { type: "text_delta", text: "\n\n**Don't open it.**\n\n```verdict\n" },
  { type: "text_delta", text: JSON.stringify(VERDICT_FIXTURE) + "\n```\n" },
  { type: "usage", input_tokens: 100, output_tokens: 20 },
  { type: "done", stop_reason: "end_turn" },
];

const CONFIRM_EVENTS: AgentEvent[] = [
  { type: "text_delta", text: "I need your OK first." },
  {
    type: "confirmation_required",
    id: "tu_c1",
    name: "report_phish",
    input: { url: "https://evil.test" },
    description: "Report https://evil.test to Google Safe Browsing.",
  },
  { type: "done", stop_reason: "confirmation_required" },
];

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let handlers: Record<string, Handler>;
let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  push.mockReset();
  window.history.replaceState(null, "", "/chat");
  handlers = {
    "GET /api/conversations": () =>
      json({ conversations: [{ id: CONV_ID, title: "Is this safe?", updatedAt: new Date().toISOString() }] }),
  };
  fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const key = `${init.method ?? "GET"} ${url.split("?")[0]}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderChat(props: Partial<React.ComponentProps<typeof ChatInterface>> = {}) {
  return render(
    <ToastProvider>
      <ChatInterface
        user={{ name: "Pat Example", email: "pat@example.com" }}
        initialConversations={[]}
        conversationId={null}
        {...props}
      />
      <Toaster />
    </ToastProvider>,
  );
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

describe("ChatInterface", () => {
  it("shows empty-state suggestions that fill the composer", async () => {
    const user = userEvent.setup();
    renderChat();
    await user.click(screen.getByRole("button", { name: /Is this link safe\?/ }));
    expect(screen.getByLabelText("Message Neo")).toHaveValue("Is this link safe? ");
    expect(screen.getByRole("button", { name: "Paste a suspicious text message" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I clicked a link and entered my password" })).toBeInTheDocument();
  });

  it("renders streamed text, a tool trace, and a verdict card; adopts the conversation id", async () => {
    handlers["POST /api/agent"] = () =>
      streamingResponse(ndjson(CHECK_URL_EVENTS), { headers: { "x-conversation-id": CONV_ID } });
    const user = userEvent.setup();
    renderChat();

    await user.type(screen.getByLabelText("Message Neo"), "Is https://evil.test safe?{Enter}");

    expect(await screen.findByText("Don't open it.")).toBeInTheDocument();
    const msg = screen.getByTestId("assistant-message");
    expect(within(msg).getByText("Let me check that link.")).toBeInTheDocument();

    const trace = within(msg).getByTestId("tool-trace");
    expect(trace).toHaveAttribute("data-tool", "check_url");
    expect(trace).toHaveAttribute("data-status", "done");
    expect(trace).toHaveTextContent("Checked the link");
    expect(trace).toHaveTextContent('"lookalike"');

    expect(within(msg).getByRole("article", { name: "Verdict: Suspicious" })).toBeInTheDocument();
    expect(within(msg).getByTestId("thinking-part")).toHaveTextContent("Run check_url.");

    // Request shape + URL/sidebar updated with the new conversation id.
    const agentCall = fetchMock.mock.calls.find((c) => c[0] === "/api/agent")!;
    expect(bodyOf(agentCall)).toEqual({ message: "Is https://evil.test safe?" });
    expect(window.location.pathname).toBe(`/chat/${CONV_ID}`);
    expect(await screen.findByRole("link", { name: /Is this safe\?/ })).toHaveAttribute("aria-current", "page");
    // Composer is back to Send and cleared.
    expect(screen.getByLabelText("Message Neo")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("does not send on Shift+Enter", async () => {
    const user = userEvent.setup();
    renderChat();
    const box = screen.getByLabelText("Message Neo");
    await user.type(box, "line one{Shift>}{Enter}{/Shift}line two");
    expect(box).toHaveValue("line one\nline two");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a confirmation prompt and streams the resumed turn after approval", async () => {
    handlers["POST /api/agent"] = () => streamingResponse(ndjson(CONFIRM_EVENTS), { headers: { "x-conversation-id": CONV_ID } });
    handlers["POST /api/agent/confirm"] = () =>
      streamingResponse(
        ndjson([
          { type: "tool_start", id: "tu_c1", name: "report_phish", input: {} },
          { type: "tool_result", id: "tu_c1", name: "report_phish", result: { reported: true } },
          { type: "text_delta", text: "Reported. Thanks!" },
          { type: "done", stop_reason: "end_turn" },
        ]),
      );
    const user = userEvent.setup();
    renderChat();

    await user.type(screen.getByLabelText("Message Neo"), "confirm-test https://evil.test{Enter}");
    const prompt = await screen.findByTestId("confirmation-prompt");
    expect(prompt).toHaveTextContent("Report https://evil.test to Google Safe Browsing.");
    // Sending is blocked until the user decides.
    await user.type(screen.getByLabelText("Message Neo"), "another");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    await user.click(within(prompt).getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Reported. Thanks!")).toBeInTheDocument();
    const confirmCall = fetchMock.mock.calls.find((c) => c[0] === "/api/agent/confirm")!;
    expect(bodyOf(confirmCall)).toEqual({ conversationId: CONV_ID, id: "tu_c1", approved: true });
    expect(screen.queryByTestId("confirmation-prompt")).not.toBeInTheDocument();
    expect(screen.getByTestId("confirmation-resolved")).toHaveTextContent("You approved:");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("restores the prompt if the confirm request fails", async () => {
    handlers["POST /api/agent"] = () => streamingResponse(ndjson(CONFIRM_EVENTS), { headers: { "x-conversation-id": CONV_ID } });
    handlers["POST /api/agent/confirm"] = () => json({ error: "There is no pending action with that id." }, 409);
    const user = userEvent.setup();
    renderChat();
    await user.type(screen.getByLabelText("Message Neo"), "confirm-test{Enter}");
    await user.click(within(await screen.findByTestId("confirmation-prompt")).getByRole("button", { name: "Decline" }));
    expect(await screen.findByText("Couldn't send your answer")).toBeInTheDocument();
    expect(screen.getByTestId("confirmation-prompt")).toBeInTheDocument();
  });

  it("stops a streaming response with the Stop button", async () => {
    handlers["POST /api/agent"] = (_url, init) => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(ndjson([{ type: "text_delta", text: "Partial answer" }])));
          init.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
        },
      });
      return new Response(body, { headers: { "x-conversation-id": CONV_ID } });
    };
    const user = userEvent.setup();
    renderChat();
    await user.type(screen.getByLabelText("Message Neo"), "hello{Enter}");
    expect(await screen.findByText("Partial answer")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop response" }));
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("shows the server's error message", async () => {
    handlers["POST /api/agent"] = () => json({ error: "Neo's agent isn't connected yet.", code: "agent_unavailable" }, 503);
    const user = userEvent.setup();
    renderChat();
    await user.type(screen.getByLabelText("Message Neo"), "hi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Neo's agent isn't connected yet.");
  });

  it("hydrates a saved conversation with tool traces and a pending confirmation", () => {
    const initialMessages = messagesFromStored(
      [
        { role: "user", content: "Is https://evil.test safe?" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "check_url", input: { url: "https://evil.test" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: '{"ok":false}' }] },
        { role: "assistant", content: [{ type: "text", text: "It's a scam." }] },
      ],
      { pending: { id: "tu_c1", name: "report_phish", input: {}, description: "Report it?" } },
    );
    renderChat({ conversationId: CONV_ID, initialMessages });
    expect(screen.getByText("Is https://evil.test safe?")).toBeInTheDocument();
    expect(screen.getByTestId("tool-trace")).toHaveTextContent('"ok": false');
    expect(screen.getByText("It's a scam.")).toBeInTheDocument();
    expect(screen.getByTestId("confirmation-prompt")).toHaveTextContent("Report it?");
    // Restored prompts don't steal focus on load.
    expect(screen.getByRole("button", { name: "Approve" })).not.toHaveFocus();
  });

  it("deletes a conversation after a second confirming click", async () => {
    handlers["DELETE /api/conversations"] = () => new Response(null, { status: 204 });
    const user = userEvent.setup();
    renderChat({
      conversationId: CONV_ID,
      initialConversations: [{ id: CONV_ID, title: "Old check", updatedAt: new Date().toISOString() }],
    });
    await user.click(screen.getByRole("button", { name: "Delete Old check" }));
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm delete Old check" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: /Old check/ })).not.toBeInTheDocument());
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/conversations?id=${CONV_ID}`);
    expect(push).toHaveBeenCalledWith("/chat");
  });
});
