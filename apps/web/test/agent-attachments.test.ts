// @vitest-environment node
import { estimateTokens, prepareMessages, type MessageParam } from "@neo/core";
import { VerdictSchema } from "@neo/verdict";
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as agentPOST } from "@/app/api/agent/route";
import { POST as uploadPOST } from "@/app/api/artifacts/route";
import type { ArtifactUploadResponse, UploadedArtifact } from "@/lib/api-types";
import { attachmentNote, parseAttachmentNote } from "@/lib/attachments";
import { messagesFromStored, type StoredMessage } from "@/lib/chat-state";
import { buildToolRegistry, loadArtifactForTool } from "@/lib/server/agent-run";
import { buildUserContent, getArtifactStore } from "@/lib/server/artifacts";
import { getConversationStore } from "@/lib/server/conversation-store";
import { createMockAnthropicClient, scriptResponse } from "@/lib/server/mock-model";
import { NEO_SYSTEM_PROMPT } from "@/lib/server/system-prompt";
import { memoryVerdicts } from "@/lib/server/verdicts";
import { EML, EML_TEXT, file, PNG_1X1, uploadRequest } from "./helpers/artifacts";
import { events, post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

const DEV_TENANT = "00000000-0000-4000-8000-0000000000aa";
const TENANT_B = { userId: "user-b", tenantId: "00000000-0000-4000-8000-0000000000bb", role: "owner" as const };

function signInAsTenantB(): void {
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  authState.session = { ...TENANT_B, user: { email: "b@example.test", name: "B" }, expires: "2099-01-01T00:00:00Z" };
}

async function upload(files: File[]): Promise<UploadedArtifact[]> {
  const res = await uploadPOST(uploadRequest(files));
  expect(res.status).toBe(200);
  return ((await res.json()) as ArtifactUploadResponse).artifacts;
}

type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
const blocksOf = (m: MessageParam | undefined): Block[] => (m && typeof m.content !== "string" ? (m.content as Block[]) : []);

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryState();
  authState.session = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("attachment notes", () => {
  it("round-trips through parseAttachmentNote", () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const fileNote = attachmentNote({ id, kind: "eml", filename: "Invoice (1).eml", sizeBytes: 12_345 });
    expect(fileNote).toBe(`[Attached file: Invoice (1).eml (eml, 12 KB). Use analyze_email with artifact_ref "${id}".]`);
    expect(parseAttachmentNote(fileNote)).toEqual({ id, kind: "eml", filename: "Invoice (1).eml", size: "12 KB" });
    const imageNote = attachmentNote({ id, kind: "image", filename: "shot.png", sizeBytes: 900 });
    expect(parseAttachmentNote(imageNote)).toEqual({ id, kind: "image", filename: "shot.png", size: "900 B" });
    expect(parseAttachmentNote("Is this safe?")).toBeNull();
  });
});

describe("buildUserContent", () => {
  it("adds a note per attachment, inlines images as base64 blocks, and never inlines .eml bytes", async () => {
    const [png, eml] = await upload([file(PNG_1X1, "shot.png", "image/png"), file(EML, "phish.eml", "message/rfc822")]);
    const store = getArtifactStore()!;
    const metas = [(await store.get(png!.id, DEV_TENANT))!, (await store.get(eml!.id, DEV_TENANT))!];
    const blocks = (await buildUserContent("Is this real?", metas, store, DEV_TENANT)) as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "text", "image", "text"]);
    expect(blocks[0]).toEqual({ type: "text", text: "Is this real?" });
    expect(blocks[1]!.text).toBe(`[Attached image: shot.png (image, ${PNG_1X1.byteLength} B), id "${png!.id}".]`);
    expect(blocks[2]!.source).toEqual({ type: "base64", media_type: "image/png", data: Buffer.from(PNG_1X1).toString("base64") });
    expect(blocks[3]!.text).toBe(`[Attached file: phish.eml (eml, ${EML.byteLength} B). Use analyze_email with artifact_ref "${eml!.id}".]`);
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain("paypa1-secure-login");
    expect(serialized).not.toContain(Buffer.from(EML).toString("base64"));
  });
});

describe("POST /api/agent with attachments (MOCK_MODE)", () => {
  it("runs analyze_email on an uploaded .eml, persists blocks and links the verdict to the artifact", async () => {
    const [eml] = await upload([file(EML, "phish.eml", "message/rfc822")]);
    const res = await agentPOST(post("/api/agent", { message: "Is this email real?", attachments: [{ id: eml!.id }] }));
    expect(res.status).toBe(200);
    const id = res.headers.get("x-conversation-id")!;
    const evs = await events(res);
    expect(evs.find((e) => e.type === "tool_start")).toMatchObject({ name: "analyze_email", input: { artifact_ref: eml!.id } });
    const result = evs.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ name: "analyze_email" });
    expect(result && "is_error" in result ? result.is_error : undefined).toBeFalsy();
    expect(JSON.stringify(result)).not.toContain("artifact_not_found");
    expect(evs.at(-1)).toEqual({ type: "done", stop_reason: "end_turn" });

    const conv = await getConversationStore().get(id, DEV_TENANT);
    const first = conv!.messages[0]!;
    expect(blocksOf(first).map((b) => b.type)).toEqual(["text", "text"]);
    expect(blocksOf(first)[1]!.text).toContain(`artifact_ref "${eml!.id}"`);
    // The tool result entered through the trust boundary.
    expect(JSON.stringify(conv!.messages[2])).toContain("_neo_trust_boundary");

    const [row] = memoryVerdicts();
    expect(row).toMatchObject({ conversationId: id, artifactId: eml!.id });
    expect(VerdictSchema.parse(row!.verdict)).toMatchObject({ subject_type: "email", verdict: "malicious", raw_ref: eml!.id });

    // History renders the attachment as a chip.
    const history = messagesFromStored(conv!.messages as StoredMessage[]);
    expect(history[0]!.parts).toEqual([
      { kind: "text", text: "Is this email real?" },
      { kind: "attachment", attachment: { id: eml!.id, kind: "eml", filename: "phish.eml", size: `${EML.byteLength} B` } },
    ]);
  });

  it("sends a screenshot to the model as an image block and runs analyze_sms", async () => {
    const [png] = await upload([file(PNG_1X1, "text.png", "image/png")]);
    const res = await agentPOST(post("/api/agent", { message: "", attachments: [{ id: png!.id }] }));
    expect(res.status).toBe(200);
    const id = res.headers.get("x-conversation-id")!;
    const evs = await events(res);
    expect(evs.find((e) => e.type === "tool_start")).toMatchObject({ name: "analyze_sms" });

    const conv = await getConversationStore().get(id, DEV_TENANT);
    const first = blocksOf(conv!.messages[0]);
    expect(first.map((b) => b.type)).toEqual(["text", "text", "image"]);
    expect(first[0]!.text).toBe("Can you check this for me?");
    expect(first[2]!.source).toMatchObject({ type: "base64", media_type: "image/png" });
    expect(memoryVerdicts()[0]!.verdict).toMatchObject({ subject_type: "sms" });

    const list = await getConversationStore().list(DEV_TENANT, "00000000-0000-4000-8000-000000000001");
    expect(list.find((c) => c.id === id)?.title).toBe("text.png");

    const history = messagesFromStored(conv!.messages as StoredMessage[]);
    expect(history[0]!.parts).toEqual([
      { kind: "text", text: "Can you check this for me?" },
      { kind: "attachment", attachment: { id: png!.id, kind: "image", filename: "text.png", size: `${PNG_1X1.byteLength} B` } },
    ]);
  });

  it("returns 404 for another tenant's artifact and for unknown ids, and records nothing", async () => {
    const [eml] = await upload([file(EML, "phish.eml", "message/rfc822")]);
    signInAsTenantB();
    const res = await agentPOST(post("/api/agent", { message: "check", attachments: [{ id: eml!.id }] }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
    const unknown = await agentPOST(post("/api/agent", { message: "check", attachments: [{ id: "00000000-0000-4000-8000-000000000999" }] }));
    expect(unknown.status).toBe(404);
    expect(await getConversationStore().list(TENANT_B.tenantId, TENANT_B.userId)).toEqual([]);
  });

  it("validates the attachments field", async () => {
    const id = "00000000-0000-4000-8000-000000000999";
    const six = Array.from({ length: 6 }, () => ({ id }));
    expect((await agentPOST(post("/api/agent", { message: "x", attachments: six }))).status).toBe(400);
    expect((await agentPOST(post("/api/agent", { message: "x", attachments: [{ id: "../x" }] }))).status).toBe(400);
    expect((await agentPOST(post("/api/agent", { message: "x", attachments: "nope" }))).status).toBe(400);
    expect((await agentPOST(post("/api/agent", { message: "", attachments: [] }))).status).toBe(400);
  });

  it("returns 503 storage_unavailable when artifacts are unconfigured", async () => {
    signInAsTenantB();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("MOCK_MODE", "true");
    const res = await agentPOST(post("/api/agent", { message: "x", attachments: [{ id: "00000000-0000-4000-8000-000000000999" }] }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "storage_unavailable" });
  });
});

describe("analyze_email is bound to the session tenant", () => {
  it("loadArtifact reads only the calling tenant's non-image artifacts", async () => {
    const [eml, png] = await upload([file(EML, "phish.eml", "message/rfc822"), file(PNG_1X1, "a.png", "image/png")]);
    const ctx = { tenantId: DEV_TENANT, userId: "u", conversationId: "c" };
    expect(new TextDecoder().decode(await loadArtifactForTool(eml!.id, ctx))).toBe(EML_TEXT);
    expect(await loadArtifactForTool(eml!.id, { ...ctx, tenantId: TENANT_B.tenantId })).toBeUndefined();
    expect(await loadArtifactForTool(png!.id, ctx)).toBeUndefined();
    expect(await loadArtifactForTool("not-a-uuid", ctx)).toBeUndefined();

    const tool = buildToolRegistry({ mock: false }).get("analyze_email")!;
    const foreign = (await tool.execute({ artifact_ref: eml!.id }, { ...ctx, tenantId: TENANT_B.tenantId })) as { errors: string[] };
    expect(foreign.errors).toContain("artifact_not_found");
  });

  it("registers check_url, analyze_email and analyze_sms", () => {
    expect(buildToolRegistry({ mock: false }).list().map((t) => t.name)).toEqual(["analyze_email", "analyze_sms", "check_url"]);
  });
});

describe("system prompt and mock script", () => {
  it("includes the intake guidance and stays byte-stable", () => {
    expect(NEO_SYSTEM_PROMPT).toContain("first transcribe what you see");
    expect(NEO_SYSTEM_PROMPT).toContain("analyze_sms");
    expect(NEO_SYSTEM_PROMPT).toContain("Call check_url only for links they did not analyze");
    expect(NEO_SYSTEM_PROMPT).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  });

  it("scripts analyze_email for file notes and analyze_sms for images", () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const fileTurn = scriptResponse([{ role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: attachmentNote({ id, kind: "eml", filename: "a.eml", sizeBytes: 10 }) }] }]);
    expect(fileTurn.content.find((b) => b.type === "tool_use")).toMatchObject({ name: "analyze_email", input: { artifact_ref: id } });
    const imageTurn = scriptResponse([
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] },
    ]);
    expect(imageTurn.content.find((b) => b.type === "tool_use")).toMatchObject({ name: "analyze_sms" });
    expect(createMockAnthropicClient()).toBeDefined();
  });
});

describe("context manager with persisted image blocks", () => {
  it("counts each image at 1600 tokens and omits older images when compressing", async () => {
    const [png] = await upload([file(PNG_1X1, "shot.png", "image/png")]);
    const store = getArtifactStore()!;
    const meta = (await store.get(png!.id, DEV_TENANT))!;
    const content = (await buildUserContent("first", [meta], store, DEV_TENANT))!;
    const turn1: MessageParam = { role: "user", content };
    expect(estimateTokens([turn1])).toBeGreaterThanOrEqual(1600);

    const history: MessageParam[] = [
      turn1,
      { role: "assistant", content: [{ type: "text", text: "That's a scam." }] },
      { role: "user", content: (await buildUserContent("second", [meta], store, DEV_TENANT))! },
    ];
    const out = await prepareMessages(history, { maxInputTokens: 3000, client: createMockAnthropicClient() });
    expect(blocksOf(out[0]).map((b) => b.type)).toEqual(["text", "text", "text"]);
    expect(blocksOf(out[0])[2]).toEqual({ type: "text", text: "[image omitted]" });
    expect(blocksOf(out[2]).map((b) => b.type)).toEqual(["text", "text", "image"]);
  });
});
