// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as confirmPOST } from "@/app/api/agent/confirm/route";
import { POST as agentPOST } from "@/app/api/agent/route";
import { DELETE as convDELETE, GET as convGET } from "@/app/api/conversations/route";
import { GET as healthGET } from "@/app/api/health/route";
import { readAgentEvents } from "@/lib/ndjson";
import { splitVerdictSegments } from "@/lib/verdict-fence";
import type { AgentEvent } from "@/types/agent-event";
import { collect } from "./fixtures";

function post(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function events(res: Response): Promise<AgentEvent[]> {
  return collect(readAgentEvents(res.body!));
}

beforeEach(() => {
  vi.stubEnv("MOCK_MODE", "true");
  vi.stubEnv("DEV_AUTH_BYPASS", "true");
  vi.stubEnv("MOCK_STREAM_DELAY_MS", "0");
  vi.stubEnv("VERCEL_ENV", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("API route stubs", () => {
  it("GET /api/health reports ok and a version", async () => {
    const body = (await healthGET().json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("rejects unauthenticated requests without the dev bypass", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "false");
    expect((await agentPOST(post("/api/agent", { message: "hi" }))).status).toBe(401);
    expect((await convGET()).status).toBe(401);
  });

  it("never honours the dev bypass on a production deployment", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await agentPOST(post("/api/agent", { message: "hi" }))).status).toBe(401);
  });

  it("validates the request body", async () => {
    expect((await agentPOST(post("/api/agent", { message: "" }))).status).toBe(400);
    expect((await agentPOST(post("/api/agent", { message: "x", conversationId: "../etc" }))).status).toBe(400);
    expect((await agentPOST(post("/api/agent", { message: "x".repeat(20_001) }))).status).toBe(400);
  });

  it("returns 503 when MOCK_MODE is off (no real agent wired yet)", async () => {
    vi.stubEnv("MOCK_MODE", "false");
    const res = await agentPOST(post("/api/agent", { message: "hi" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "agent_unavailable" });
  });

  it("streams the scripted check_url turn and persists the conversation", async () => {
    const res = await agentPOST(post("/api/agent", { message: "Is https://paypa1.example/login safe?" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const id = res.headers.get("x-conversation-id")!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const evs = await events(res);
    const types = evs.map((e) => e.type);
    expect(types[0]).toBe("thinking");
    expect(types).toContain("tool_start");
    expect(types.slice(-2)).toEqual(["usage", "done"]);
    const start = evs.find((e) => e.type === "tool_start");
    expect(start).toMatchObject({ name: "check_url", input: { url: "https://paypa1.example/login" } });
    const result = evs.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ name: "check_url", result: { normalized_url: "https://paypa1.example/login" } });

    const text = evs.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
    const verdicts = splitVerdictSegments(text).filter((s) => s.kind === "verdict");
    expect(verdicts).toHaveLength(1);

    const list = (await (await convGET()).json()) as { conversations: Array<{ id: string; title: string }> };
    expect(list.conversations[0]).toMatchObject({ id, title: "Is https://paypa1.example/login safe?" });

    expect((await agentPOST(post("/api/agent", { message: "again", conversationId: id }))).status).toBe(200);
    expect(
      (await agentPOST(post("/api/agent", { message: "x", conversationId: "00000000-0000-4000-8000-000000000999" })))
        .status,
    ).toBe(404);

    const del = await convDELETE(new Request(`http://localhost/api/conversations?id=${id}`, { method: "DELETE" }));
    expect(del.status).toBe(204);
    const after = (await (await convGET()).json()) as { conversations: Array<{ id: string }> };
    expect(after.conversations.find((c) => c.id === id)).toBeUndefined();
  });

  it("confirm-test emits confirmation_required, and /confirm resumes exactly once", async () => {
    const res = await agentPOST(post("/api/agent", { message: "confirm-test https://paypa1.example" }));
    const id = res.headers.get("x-conversation-id")!;
    const evs = await events(res);
    const conf = evs.find((e) => e.type === "confirmation_required");
    expect(conf).toMatchObject({ name: "report_phish" });
    expect(evs.at(-1)).toEqual({ type: "done", stop_reason: "confirmation_required" });
    const confId = (conf as { id: string }).id;

    expect((await confirmPOST(post("/api/agent/confirm", { conversationId: id, id: "wrong", approved: true }))).status).toBe(409);

    const ok = await confirmPOST(post("/api/agent/confirm", { conversationId: id, id: confId, approved: true }));
    expect(ok.status).toBe(200);
    const resumed = await events(ok);
    expect(resumed.find((e) => e.type === "tool_result")).toMatchObject({ name: "report_phish" });
    expect(resumed.at(-1)).toMatchObject({ type: "done", stop_reason: "end_turn" });

    const again = await confirmPOST(post("/api/agent/confirm", { conversationId: id, id: confId, approved: true }));
    expect(again.status).toBe(409);
  });
});
