import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentEvent } from "@neo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInterface } from "@/components/ChatInterface";
import { Toaster } from "@/components/Toaster";
import { ToastProvider } from "@/components/toast-context";
import { UsageIndicator } from "@/components/UsageIndicator";
import type { UploadedArtifact } from "@/lib/api-types";
import { ndjson, streamingResponse } from "./fixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

const CONV_ID = "11111111-2222-4333-8444-555555555555";
const EML_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PNG_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const EVENTS: AgentEvent[] = [
  { type: "text_delta", text: "Let me analyze that email." },
  { type: "done", stop_reason: "end_turn" },
];

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let handlers: Record<string, Handler>;
let fetchMock: ReturnType<typeof vi.fn>;
let usage = { used: 3, limit: 50 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function uploaded(file: File, id: string, kind: UploadedArtifact["kind"]): UploadedArtifact {
  return { id, kind, filename: file.name, mimeType: file.type, sizeBytes: file.size, sha256: "0".repeat(64) };
}

const emlFile = () => new File(["From: a@b.neo.test\r\nSubject: hi\r\n\r\nbody"], "phish.eml", { type: "message/rfc822" });
const pngFile = () => new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "shot.png", { type: "image/png" });

beforeEach(() => {
  usage = { used: 3, limit: 50 };
  window.history.replaceState(null, "", "/chat");
  handlers = {
    "GET /api/conversations": () => json({ conversations: [] }),
    "GET /api/usage": () =>
      json({
        monthlyChecks: { ...usage, resetAt: "2099-02-01T00:00:00.000Z" },
        dailyTokens: { used: 0, limit: 300000, resetAt: "2099-01-02T00:00:00.000Z" },
      }),
    "POST /api/artifacts": async (_url, init) => {
      const files = (init.body as FormData).getAll("file") as File[];
      return json({ artifacts: files.map((f) => uploaded(f, f.name.endsWith(".png") ? PNG_ID : EML_ID, f.name.endsWith(".png") ? "image" : "eml")) });
    },
    "POST /api/agent": () => streamingResponse(ndjson(EVENTS), { headers: { "x-conversation-id": CONV_ID } }),
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function renderChat() {
  return render(
    <ToastProvider>
      <ChatInterface user={{ name: "Pat Example", email: "pat@example.com" }} initialConversations={[]} conversationId={null} />
      <Toaster />
    </ToastProvider>,
  );
}

const calls = (key: string) =>
  fetchMock.mock.calls.filter((c) => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${String(c[0]).split("?")[0]}` === key);

describe("Composer attachments", () => {
  it("attaches a file with the button and removes it with its chip's button", async () => {
    const user = userEvent.setup();
    renderChat();
    await user.upload(screen.getByTestId("composer-file-input"), emlFile());
    const chip = await screen.findByTestId("composer-attachment");
    expect(chip).toHaveTextContent("phish.eml");
    // Attachments alone are sendable.
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Remove phish.eml" }));
    expect(screen.queryByTestId("composer-attachment")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(calls("POST /api/artifacts")).toHaveLength(0); // upload happens on send, not on attach
  });

  it("attaches a screenshot pasted from the clipboard", async () => {
    // Stub object URLs for the thumbnail preview (restored in afterEach).
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    renderChat();
    fireEvent.paste(screen.getByLabelText("Message Neo"), { clipboardData: { getData: () => "", files: [pngFile()] } });
    const chip = await screen.findByTestId("composer-attachment");
    expect(within(chip).getByRole("img", { name: "shot.png" })).toHaveAttribute("src", "blob:preview");
  });

  it("accepts dropped files", async () => {
    renderChat();
    const form = screen.getByLabelText("Message Neo").closest("form")!;
    fireEvent.dragOver(form, { dataTransfer: { types: ["Files"], dropEffect: "none" } });
    fireEvent.drop(form, { dataTransfer: { types: ["Files"], files: [emlFile()] } });
    expect(await screen.findByTestId("composer-attachment")).toHaveTextContent("phish.eml");
  });

  it("refuses HEIC and unsupported files with a message", async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderChat();
    await user.upload(screen.getByTestId("composer-file-input"), new File(["x"], "IMG_0001.HEIC", { type: "image/heic" }));
    expect(await screen.findByText(/HEIC photos aren't supported/)).toBeInTheDocument();
    await user.upload(screen.getByTestId("composer-file-input"), new File(["x"], "setup.exe", { type: "application/x-msdownload" }));
    expect(await screen.findByText(/setup.exe isn't supported/)).toBeInTheDocument();
    expect(screen.queryByTestId("composer-attachment")).not.toBeInTheDocument();
  });

  it("turns a paste over 20,000 characters into a text attachment", async () => {
    renderChat();
    fireEvent.paste(screen.getByLabelText("Message Neo"), { clipboardData: { getData: () => "a".repeat(20_001), files: [] } });
    expect(await screen.findByTestId("composer-attachment")).toHaveTextContent("pasted-text.txt");
    expect(screen.getByLabelText("Message Neo")).toHaveValue("");
    expect(await screen.findByText("Attached as a text file")).toBeInTheDocument();
  });

  it("uploads on send, then sends the agent request with the attachment ids", async () => {
    const user = userEvent.setup();
    renderChat();
    await user.upload(screen.getByTestId("composer-file-input"), emlFile());
    await screen.findByTestId("composer-attachment");
    await user.type(screen.getByLabelText("Message Neo"), "Is this real?{Enter}");

    expect(await screen.findByText("Let me analyze that email.")).toBeInTheDocument();
    const [up] = calls("POST /api/artifacts");
    expect(((up![1] as RequestInit).body as FormData).getAll("file").map((f) => (f as File).name)).toEqual(["phish.eml"]);
    const [agent] = calls("POST /api/agent");
    expect(JSON.parse(String((agent![1] as RequestInit).body))).toEqual({ message: "Is this real?", attachments: [{ id: EML_ID }] });
    // Upload strictly before the agent request.
    expect(fetchMock.mock.calls.indexOf(up!)).toBeLessThan(fetchMock.mock.calls.indexOf(agent!));

    // The sent message shows the file; the composer is cleared.
    const mine = screen.getByLabelText("Your message");
    expect(within(mine).getByText("Is this real?")).toBeInTheDocument();
    expect(within(mine).getByTestId("attachment-chip")).toHaveAttribute("href", `/api/artifacts/${EML_ID}`);
    expect(screen.queryByTestId("composer-attachment")).not.toBeInTheDocument();
    // Usage re-fetched after the turn.
    await waitFor(() => expect(calls("GET /api/usage").length).toBeGreaterThanOrEqual(2));
  });

  it("renders a sent screenshot as a thumbnail linking to the inline download", async () => {
    const user = userEvent.setup();
    renderChat();
    await user.upload(screen.getByTestId("composer-file-input"), pngFile());
    await screen.findByTestId("composer-attachment");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Let me analyze that email.");
    const [agent] = calls("POST /api/agent");
    expect(JSON.parse(String((agent![1] as RequestInit).body))).toEqual({ message: "", attachments: [{ id: PNG_ID }] });
    const thumb = within(screen.getByLabelText("Your message")).getByTestId("attachment-thumbnail");
    expect(thumb).toHaveAttribute("href", `/api/artifacts/${PNG_ID}?inline=1`);
    expect(thumb).toHaveAttribute("target", "_blank");
  });

  it("keeps the chips when the agent request fails and resends without uploading again", async () => {
    handlers["POST /api/agent"] = () => json({ error: "Neo can't reach its storage right now.", code: "storage_unavailable" }, 503);
    const user = userEvent.setup();
    renderChat();
    await user.upload(screen.getByTestId("composer-file-input"), emlFile());
    await screen.findByTestId("composer-attachment");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Neo can't reach its storage right now.")).toBeInTheDocument();
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument();

    handlers["POST /api/agent"] = () => streamingResponse(ndjson(EVENTS), { headers: { "x-conversation-id": CONV_ID } });
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Let me analyze that email.");
    expect(calls("POST /api/artifacts")).toHaveLength(1);
    expect(calls("POST /api/agent")).toHaveLength(2);
    expect(screen.queryByTestId("composer-attachment")).not.toBeInTheDocument();
  });

  it("shows an upload error and keeps the message and files", async () => {
    handlers["POST /api/artifacts"] = () => json({ error: "HEIC photos aren't supported yet.", code: "unsupported_type" }, 415);
    const user = userEvent.setup();
    renderChat();
    await user.upload(screen.getByTestId("composer-file-input"), emlFile());
    await screen.findByTestId("composer-attachment");
    await user.type(screen.getByLabelText("Message Neo"), "check{Enter}");
    expect(await screen.findByText("Couldn't upload your files")).toBeInTheDocument();
    expect(screen.getByLabelText("Message Neo")).toHaveValue("check");
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument();
    expect(calls("POST /api/agent")).toHaveLength(0);
  });

  it("rotates placeholder hints on a new conversation", async () => {
    vi.useFakeTimers();
    renderChat();
    const box = screen.getByLabelText("Message Neo");
    expect(box).toHaveAttribute("placeholder", "Paste a suspicious text…");
    act(() => vi.advanceTimersByTime(3600));
    expect(box).toHaveAttribute("placeholder", "Drop an .eml file…");
    act(() => vi.advanceTimersByTime(3600));
    expect(box).toHaveAttribute("placeholder", "Screenshot of an email or message…");
  });
});

describe("UsageIndicator", () => {
  it.each([
    [3, 50, "ok", "3 / 50"],
    [40, 50, "warning", "40 / 50"],
    [50, 50, "exhausted", "resets"],
  ])("shows %i of %i as %s", async (used, limit, level, text) => {
    usage = { used, limit };
    render(<UsageIndicator />);
    const el = await screen.findByTestId("usage-indicator");
    expect(el).toHaveAttribute("data-level", level);
    expect(el).toHaveTextContent(text);
  });

  it("re-fetches when refreshKey changes", async () => {
    const { rerender } = render(<UsageIndicator refreshKey={0} />);
    await screen.findByTestId("usage-indicator");
    usage = { used: 4, limit: 50 };
    rerender(<UsageIndicator refreshKey={1} />);
    await waitFor(() => expect(screen.getByTestId("usage-indicator")).toHaveTextContent("4 / 50"));
  });
});
