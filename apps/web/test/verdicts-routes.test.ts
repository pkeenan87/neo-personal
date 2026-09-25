// @vitest-environment node
import { MOCK_URLS } from "@neo/tools";
import type { Verdict } from "@neo/verdict";
import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as agentPOST } from "@/app/api/agent/route";
import { GET as householdGET } from "@/app/api/household/route";
import { DELETE as verdictDELETE, GET as verdictGET } from "@/app/api/verdicts/[id]/route";
import { GET as listGET } from "@/app/api/verdicts/route";
import { GET as summaryGET } from "@/app/api/verdicts/summary/route";
import type { HouseholdResponse, VerdictDetailResponse, VerdictListResponse, VerdictSummaryResponse } from "@/lib/dashboard-types";
import { messagesFromStored, type StoredMessage } from "@/lib/chat-state";
import { memoryAuditLog } from "@/lib/server/audit";
import { getConversationStore } from "@/lib/server/conversation-store";
import { getArtifactStore } from "@/lib/server/artifacts";
import { memoryState, memoryVerdicts, setMemoryMembers } from "@/lib/server/memory-state";
import { DEV_SESSION_IDS } from "@/lib/session";
import { VERDICT_FIXTURE } from "./fixtures";
import { events, post, resetMemoryState, stubBaseEnv } from "./helpers/routes";

const authState = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

const TENANT = "00000000-0000-4000-8000-0000000000cc";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000dd";
const OWNER = { userId: "owner-1", tenantId: TENANT, role: "owner" as const, email: "olive@example.test", name: "Olive" };
const MEMBER = { userId: "member-1", tenantId: TENANT, role: "member" as const, email: "max@example.test", name: "Max" };
const OUTSIDER = { userId: "outsider-1", tenantId: OTHER_TENANT, role: "owner" as const, email: "x@example.test", name: "X" };

function signIn(who: typeof OWNER | typeof MEMBER | typeof OUTSIDER): void {
  vi.stubEnv("DEV_AUTH_BYPASS", "false");
  authState.session = {
    userId: who.userId,
    tenantId: who.tenantId,
    role: who.role,
    user: { email: who.email, name: who.name },
    expires: "2099-01-01T00:00:00Z",
  };
}

const get = (url: string) => new Request(`http://localhost${url}`);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

let seq = 0;
function seed(
  userId: string,
  patch: Partial<Verdict> = {},
  opts: { tenantId?: string; minutesAgo?: number; artifactId?: string; source?: "chat" | "inbound" } = {},
): string {
  const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  memoryVerdicts().push({
    id,
    tenantId: opts.tenantId ?? TENANT,
    userId,
    conversationId: null,
    source: opts.source ?? "chat",
    artifactId: opts.artifactId ?? null,
    verdict: { ...VERDICT_FIXTURE, ...patch },
    createdAt: new Date(Date.now() - (opts.minutesAgo ?? seq) * 60_000),
  });
  return id;
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

beforeEach(() => {
  stubBaseEnv(vi);
  resetMemoryState();
  authState.session = null;
  seq = 0;
  setMemoryMembers(TENANT, [
    { userId: OWNER.userId, name: OWNER.name, email: OWNER.email, role: "owner" },
    { userId: MEMBER.userId, name: MEMBER.name, email: MEMBER.email, role: "member" },
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("role enforcement", () => {
  beforeEach(() => {
    seed(OWNER.userId, { verdict: "malicious" });
    seed(MEMBER.userId, { verdict: "suspicious" });
    seed(MEMBER.userId, { verdict: "likely_safe" });
    seed(OUTSIDER.userId, {}, { tenantId: OTHER_TENANT });
  });

  it("401 without a session", async () => {
    vi.stubEnv("DEV_AUTH_BYPASS", "false");
    expect((await listGET(get("/api/verdicts"))).status).toBe(401);
    expect((await summaryGET(get("/api/verdicts/summary"))).status).toBe(401);
    expect((await householdGET()).status).toBe(401);
  });

  it("owner sees every member's verdicts and may filter by member", async () => {
    signIn(OWNER);
    const all = await json<VerdictListResponse>(listGET(get("/api/verdicts")));
    expect(all.items.map((i) => i.userId).sort()).toEqual([MEMBER.userId, MEMBER.userId, OWNER.userId]);
    expect(all.nextCursor).toBeNull();
    const maxOnly = await json<VerdictListResponse>(listGET(get(`/api/verdicts?userId=${MEMBER.userId}`)));
    expect(maxOnly.items).toHaveLength(2);
    expect(maxOnly.items.every((i) => i.userId === MEMBER.userId)).toBe(true);
    // A user outside the household (or removed from it): 404.
    expect((await listGET(get(`/api/verdicts?userId=${OUTSIDER.userId}`))).status).toBe(404);
    expect((await summaryGET(get(`/api/verdicts/summary?userId=${OUTSIDER.userId}`))).status).toBe(404);
  });

  it("member sees only their own verdicts; another member's id is 403 forbidden", async () => {
    signIn(MEMBER);
    const mine = await json<VerdictListResponse>(listGET(get("/api/verdicts")));
    expect(mine.items).toHaveLength(2);
    expect(mine.items.every((i) => i.userId === MEMBER.userId)).toBe(true);
    const res = await listGET(get(`/api/verdicts?userId=${OWNER.userId}`));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden" });
    expect((await summaryGET(get(`/api/verdicts/summary?userId=${OWNER.userId}`))).status).toBe(403);
    const summary = await json<VerdictSummaryResponse>(summaryGET(get("/api/verdicts/summary")));
    expect(summary.total).toBe(2);
    expect(summary.byLabel.malicious).toBe(0);
  });

  it("detail: owner reads a member's verdict, member cannot read the owner's, other tenants get 404", async () => {
    const ownerVerdict = memoryVerdicts().find((r) => r.userId === OWNER.userId)!.id!;
    const memberVerdict = memoryVerdicts().find((r) => r.userId === MEMBER.userId)!.id!;
    signIn(OWNER);
    const d = await json<VerdictDetailResponse>(verdictGET(get("/x"), params(memberVerdict)));
    expect(d).toMatchObject({ id: memberVerdict, userId: MEMBER.userId, memberName: "Max", conversation: null, artifact: null, inbound: null });
    expect(d.body.headline).toBe(VERDICT_FIXTURE.headline);
    expect((await verdictGET(get("/x"), params("not-a-uuid"))).status).toBe(404);

    signIn(MEMBER);
    expect((await verdictGET(get("/x"), params(ownerVerdict))).status).toBe(404);
    expect((await verdictDELETE(get("/x"), params(ownerVerdict))).status).toBe(404);

    signIn(OUTSIDER);
    expect((await verdictGET(get("/x"), params(memberVerdict))).status).toBe(404);
    expect((await json<VerdictListResponse>(listGET(get("/api/verdicts")))).items).toHaveLength(1);
  });

  it("household: owners see emails, members do not", async () => {
    signIn(OWNER);
    const h = await json<HouseholdResponse>(householdGET());
    expect(h).toMatchObject({ tenantId: TENANT, role: "owner" });
    expect(h.members.find((m) => m.userId === MEMBER.userId)?.email).toBe(MEMBER.email);
    signIn(MEMBER);
    const hm = await json<HouseholdResponse>(householdGET());
    expect(hm.role).toBe("member");
    expect(hm.members).toHaveLength(2);
    expect(hm.members.every((m) => m.email === null)).toBe(true);
  });
});

describe("pagination and filters", () => {
  it("walks every page with a keyset cursor, without duplicates", async () => {
    for (let i = 0; i < 23; i++) seed(OWNER.userId, { verdict: i % 2 ? "malicious" : "likely_safe" });
    signIn(OWNER);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: VerdictListResponse = await json<VerdictListResponse>(
        listGET(get(`/api/verdicts?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)),
      );
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(23);
    // Newest first.
    const created = memoryVerdicts().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((r) => r.id);
    expect(seen).toEqual(created);

    const mal = await json<VerdictListResponse>(listGET(get("/api/verdicts?label=malicious&limit=50")));
    expect(mal.items).toHaveLength(11);
    expect(mal.items.every((i) => i.verdict === "malicious")).toBe(true);
  });

  it.each([
    "/api/verdicts?limit=51",
    "/api/verdicts?limit=0",
    "/api/verdicts?label=evil",
    "/api/verdicts?subjectType=fax",
    "/api/verdicts?source=pigeon",
    "/api/verdicts?cursor=%%%",
  ])("400 for %s", async (url) => {
    signIn(OWNER);
    expect((await listGET(get(url))).status).toBe(400);
  });

  it("400 for an unsupported summary range", async () => {
    signIn(OWNER);
    expect((await summaryGET(get("/api/verdicts/summary?sinceDays=5"))).status).toBe(400);
  });
});

describe("summary", () => {
  it("counts match the seeded rows and indicators/domains aggregate across bodies", async () => {
    const ind = (category: string) => ({ severity: "high" as const, category, evidence: "e", explanation: "x" });
    const iocs = (domains: string[]) => ({ urls: [], domains, ips: [], hashes: [], phone_numbers: [] });
    seed(OWNER.userId, { verdict: "malicious", subject_type: "url", indicators: [ind("lookalike_domain"), ind("young_domain")], iocs: iocs(["paypa1.test"]) });
    seed(MEMBER.userId, { verdict: "malicious", subject_type: "email", indicators: [ind("lookalike_domain")], iocs: iocs(["paypa1.test", "evil.test"]) });
    seed(MEMBER.userId, { verdict: "likely_safe", subject_type: "url", indicators: [ind("known_brand")], iocs: iocs(["bank.test"]) });
    seed(OWNER.userId, { verdict: "suspicious" }, { minutesAgo: 60 * 24 * 10 }); // outside 7 days

    signIn(OWNER);
    const s7 = await json<VerdictSummaryResponse>(summaryGET(get("/api/verdicts/summary?sinceDays=7")));
    expect(s7.sinceDays).toBe(7);
    expect(s7.total).toBe(3);
    expect(s7.byLabel).toEqual({ malicious: 2, suspicious: 0, likely_safe: 1, insufficient_evidence: 0 });
    expect(s7.bySubjectType).toMatchObject({ url: 2, email: 1 });
    expect(s7.topIndicators[0]).toEqual({ category: "lookalike_domain", count: 2 });
    expect(s7.topIndicators.map((i) => i.category)).toContain("known_brand");
    // likely_safe verdicts don't contribute domains.
    expect(s7.topDomains).toEqual([
      { domain: "paypa1.test", count: 2 },
      { domain: "evil.test", count: 1 },
    ]);
    expect(s7.perDay.reduce((n, d) => n + d.malicious + d.suspicious + d.likely_safe + d.insufficient_evidence, 0)).toBe(3);

    const s30 = await json<VerdictSummaryResponse>(summaryGET(get("/api/verdicts/summary")));
    expect(s30.sinceDays).toBe(30);
    expect(s30.total).toBe(4);
  });
});

describe("DELETE /api/verdicts/[id]", () => {
  it("removes the verdict and its artifact, writes verdict.deleted, then 404s", async () => {
    const { id: artifactId } = await getArtifactStore()!.put({
      tenantId: TENANT,
      userId: MEMBER.userId,
      kind: "eml",
      filename: "message.eml",
      mimeType: "message/rfc822",
      bytes: new Uint8Array(2048).fill(65),
      source: "upload",
    });
    const id = seed(MEMBER.userId, {}, { artifactId });

    signIn(MEMBER);
    const d = await json<VerdictDetailResponse>(verdictGET(get("/x"), params(id)));
    expect(d.artifact).toMatchObject({ id: artifactId, kind: "eml", filename: "message.eml", sizeBytes: 2048, expired: false });

    const res = await verdictDELETE(get("/x"), params(id));
    expect(res.status).toBe(204);
    expect(await getArtifactStore()!.get(artifactId, TENANT)).toBeUndefined();
    const audit = memoryAuditLog().filter((e) => e.eventType === "verdict.deleted");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tenantId: TENANT, userId: MEMBER.userId, metadata: { verdictId: id, artifactDeleted: true } });
    expect((await verdictGET(get("/x"), params(id))).status).toBe(404);
    expect((await verdictDELETE(get("/x"), params(id))).status).toBe(404);
  });

  it("owner may delete a member's verdict", async () => {
    const id = seed(MEMBER.userId);
    signIn(OWNER);
    expect((await verdictDELETE(get("/x"), params(id))).status).toBe(204);
    expect(memoryVerdicts()).toHaveLength(0);
  });

  it("reports expired evidence and forwarded origin", async () => {
    // Stored 40 days ago with the default 30-day retention: expired, so the store no longer returns it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() - 40 * 86_400_000));
    const { id: artifactId } = await getArtifactStore()!.put({
      tenantId: TENANT,
      userId: MEMBER.userId,
      kind: "inbound_eml",
      mimeType: "message/rfc822",
      bytes: new TextEncoder().encode("x"),
      source: "inbound",
    });
    vi.useRealTimers();
    const id = seed(MEMBER.userId, { subject_type: "email" }, { artifactId, source: "inbound" });
    memoryState().inboundMessages.push({
      id: "00000000-0000-4000-8000-0000000000a1",
      tenantId: TENANT,
      addressId: "00000000-0000-4000-8000-0000000000a2",
      providerMessageId: "em_1",
      fromAddressHash: "h",
      status: "done",
      error: null,
      forwarderUserId: MEMBER.userId,
      verdictId: id,
      artifactId,
      receivedAt: new Date("2026-09-01T10:00:00Z"),
      completedAt: new Date("2026-09-01T10:01:00Z"),
    });
    signIn(OWNER);
    const d = await json<VerdictDetailResponse>(verdictGET(get("/x"), params(id)));
    expect(d.source).toBe("inbound");
    expect(d.artifactId).toBe(artifactId);
    expect(d.artifact).toBeNull(); // expired evidence is gone; the page says so
    expect(d.inbound).toEqual({ status: "done", receivedAt: "2026-09-01T10:00:00.000Z", forwardedBy: "Max" });
  });
});

describe("end to end with the agent (MOCK_MODE, dev tenant)", () => {
  it("a chat verdict is listed and its detail links the conversation", async () => {
    const res = await agentPOST(post("/api/agent", { message: `Is ${MOCK_URLS.phish} safe?` }));
    const conversationId = res.headers.get("x-conversation-id")!;
    await events(res);

    const list = await json<VerdictListResponse>(listGET(get("/api/verdicts")));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ source: "chat", conversationId, verdict: "malicious", userId: DEV_SESSION_IDS.userId });

    const d = await json<VerdictDetailResponse>(verdictGET(get("/x"), params(list.items[0]!.id)));
    expect(d.conversation).toEqual({ id: conversationId, title: `Is ${MOCK_URLS.phish} safe?` });
  });

  it("'Ask Neo about this' adds the stored verdict as a hidden, wrapped block loaded on the server", async () => {
    const id = seed(DEV_SESSION_IDS.userId, { headline: "Stored headline" }, { tenantId: DEV_SESSION_IDS.tenantId });
    const res = await agentPOST(post("/api/agent", { message: "Tell me more about this check", verdictId: id }));
    expect(res.status).toBe(200);
    const conversationId = res.headers.get("x-conversation-id")!;
    await events(res);

    const conv = await getConversationStore().get(conversationId, DEV_SESSION_IDS.tenantId);
    const first = conv!.messages[0]!;
    const blocks = first.content as Array<{ type: string; text: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe("Tell me more about this check");
    expect(blocks[1]!.text).toContain("_neo_trust_boundary");
    expect(blocks[1]!.text).toContain("Stored headline");
    // Hidden when the conversation is shown again.
    const shown = messagesFromStored(conv!.messages as unknown as StoredMessage[]);
    expect(shown[0]).toMatchObject({ role: "user", parts: [{ kind: "text", text: "Tell me more about this check" }] });

    // Unknown, malformed or foreign verdict ids never reach the model.
    const foreign = seed(OUTSIDER.userId, {}, { tenantId: OTHER_TENANT });
    expect((await agentPOST(post("/api/agent", { message: "x", verdictId: foreign }))).status).toBe(404);
    expect((await agentPOST(post("/api/agent", { message: "x", verdictId: "../../etc" }))).status).toBe(400);
  });
});
