// @vitest-environment node
/**
 * The eve chat's parity tools (_specs/v2-m3-cutover.md section 2): `get_playbook` (2c) and the
 * "Was this you?" pair (2e), `pending_signin_alerts` and `confirm_signin`. The tenant and user come
 * from the verified caller only, a foreign or malformed id is `not_found`, only the alert's own member
 * can answer (the card's rule: an owner gets `not_found`), `confirm_signin` needs approval every time,
 * and the model sees only the wrapToolResult envelope.
 */
import { wrapToolResult } from "@neo/core";
import { auditEvents, saveVerdict, tenantScoped } from "@neo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import confirmSignin from "../agent/tools/confirm_signin";
import getPlaybook from "../agent/tools/get_playbook";
import pendingSigninAlerts from "../agent/tools/pending_signin_alerts";
import { PLAYBOOK_IDS } from "@/lib/playbooks";
import { loadPlaybooks } from "@/lib/server/playbooks";
import { finalizeSigninVerdict, persistSigninEvent } from "@/lib/server/signin/service";
import { getSigninStore } from "@/lib/server/signin/store";
import { createEveFixture, type EveFixture, type Person } from "./helpers/eve-db";
import { stubBaseEnv } from "./helpers/routes";
import { analyzeRaw, googleAlertRaw, triaged } from "./signin-fixtures";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/server/db", () => ({ getDb: () => holder.db }));

type Tool = {
  approval: { request: (ctx: unknown) => unknown; prompt: (ctx: unknown) => string };
  execute(input: unknown, ctx: unknown): Promise<unknown>;
  toModelOutput(output: unknown): { type: string; value: string };
  inputSchema: { safeParse(v: unknown): { success: boolean; data?: unknown } };
};
const tool = (t: unknown) => t as Tool;

function ctxFor(p: Person | null) {
  return {
    abortSignal: new AbortController().signal,
    session: { auth: { current: p ? { principalType: "user", principalId: p.userId, attributes: { tenantId: p.tenantId, role: p.role } } : null } },
  };
}

async function run(t: unknown, p: Person | null, input: unknown): Promise<Record<string, unknown>> {
  const parsed = tool(t).inputSchema.safeParse(input);
  if (!parsed.success) throw new Error("invalid input");
  return (await tool(t).execute(parsed.data, ctxFor(p))) as Record<string, unknown>;
}

let fx: EveFixture;
beforeAll(async () => {
  fx = await createEveFixture();
}, 60_000);
afterAll(async () => {
  await fx.close();
});
beforeEach(() => {
  holder.db = fx.db;
  stubBaseEnv(vi);
});
afterEach(() => vi.unstubAllEnvs());

/** A chat-saved sign-in verdict with its "Was this you?" check and stored event, for `p`. */
async function signinVerdict(p: Person): Promise<string> {
  const analysis = await analyzeRaw(googleAlertRaw());
  const fin = await finalizeSigninVerdict({ tenantId: p.tenantId, userId: p.userId, analysis, verdict: triaged("suspicious"), source: "forwarded" });
  expect(fin.verdict.signin_check).toBeDefined();
  const { id } = await saveVerdict(fx.db, { tenantId: p.tenantId, userId: p.userId, source: "chat", verdict: fin.verdict });
  await persistSigninEvent({ tenantId: p.tenantId, userId: p.userId, verdictId: id, event: fin.event });
  return id;
}

describe("get_playbook (2c)", () => {
  it("returns the same playbook text the old chat uses, wrapped for the model", async () => {
    for (const id of PLAYBOOK_IDS) {
      const out = await run(getPlaybook, fx.kid, { id });
      expect(out).toMatchObject({ id, playbook: loadPlaybooks()[id] });
      expect(tool(getPlaybook).toModelOutput(out)).toEqual({ type: "text", value: wrapToolResult("get_playbook", out) });
    }
    expect(tool(getPlaybook).toModelOutput(await run(getPlaybook, fx.kid, { id: "clicked_link" })).value).toContain("_neo_trust_boundary");
  });

  it("needs a signed-in household member and a known id, and takes no tenant", async () => {
    await expect(run(getPlaybook, null, { id: "clicked_link" })).rejects.toThrow(/authenticated Neo household member/);
    expect(tool(getPlaybook).inputSchema.safeParse({ id: "not_a_playbook" }).success).toBe(false);
    expect(tool(getPlaybook).inputSchema.safeParse({ id: "clicked_link", tenantId: fx.other.tenantId }).success).toBe(false);
  });
});

describe("pending_signin_alerts (2e)", () => {
  it("lists only the caller's own pending alert, minimized and wrapped; nobody else sees it", async () => {
    const id = await signinVerdict(fx.kid);
    const mine = await run(pendingSigninAlerts, fx.kid, {});
    expect(mine).toMatchObject({ count: 1, alerts: [{ verdictId: id, provider: "google", device: "Windows" }] });
    expect(JSON.stringify(mine)).not.toContain("203.0.113.24"); // no IP address
    expect(tool(pendingSigninAlerts).toModelOutput(mine).value).toBe(wrapToolResult("pending_signin_alerts", mine));
    // The household owner and another household never see the member's alert (no user selector exists).
    expect(await run(pendingSigninAlerts, fx.owner, {})).toMatchObject({ count: 0 });
    expect(await run(pendingSigninAlerts, fx.other, {})).toMatchObject({ count: 0 });
    expect(tool(pendingSigninAlerts).inputSchema.safeParse({ userId: fx.kid.userId }).success).toBe(false);
    await expect(run(pendingSigninAlerts, null, {})).rejects.toThrow(/authenticated Neo household member/);
  });
});

describe("confirm_signin (2e)", () => {
  it("needs approval on every call, with a fixed prompt that quotes nothing from the alert", () => {
    expect(tool(confirmSignin).approval.request({ toolInput: { verdictId: "x", wasMe: true } })).toBe("user-approval");
    expect(tool(confirmSignin).approval.request({ toolInput: undefined })).toBe("user-approval");
    const yes = tool(confirmSignin).approval.prompt({ input: { verdictId: "x", wasMe: true } });
    const no = tool(confirmSignin).approval.prompt({ input: { verdictId: "Windows", wasMe: false } });
    expect(yes).toMatch(/was you/);
    expect(no).toMatch(/was not you/);
    expect(no).not.toContain("Windows");
  });

  it("is strict: no tenant or user in the input, and wasMe must be a boolean", () => {
    const schema = tool(confirmSignin).inputSchema;
    expect(schema.safeParse({ verdictId: "v", wasMe: true }).success).toBe(true);
    expect(schema.safeParse({ verdictId: "v", wasMe: true, tenantId: fx.other.tenantId }).success).toBe(false);
    expect(schema.safeParse({ verdictId: "v", wasMe: true, userId: fx.kid.userId }).success).toBe(false);
    expect(schema.safeParse({ verdictId: "v", wasMe: "yes" }).success).toBe(false);
    expect(schema.safeParse({ verdictId: "", wasMe: true }).success).toBe(false);
  });

  it("only the alert's own member can answer: owner, another household and malformed ids get not_found", async () => {
    const id = await signinVerdict(fx.kid);
    const notFound = { ok: false, error: "not_found" };
    expect(await run(confirmSignin, fx.owner, { verdictId: id, wasMe: true })).toMatchObject(notFound);
    expect(await run(confirmSignin, fx.other, { verdictId: id, wasMe: true })).toMatchObject(notFound);
    expect(await run(confirmSignin, fx.kid, { verdictId: "not-a-uuid", wasMe: true })).toMatchObject(notFound);
    expect(await run(confirmSignin, fx.kid, { verdictId: crypto.randomUUID(), wasMe: true })).toMatchObject(notFound);
    // Nothing was remembered by any of those.
    expect(await getSigninStore().isKnownDevice(fx.kid.tenantId, fx.kid.userId, "google", "Windows")).toBe(false);
  });

  it("yes remembers the device (and the alert stops being pending); no forgets it and points to the playbook", async () => {
    const id = await signinVerdict(fx.kid);
    const yes = await run(confirmSignin, fx.kid, { verdictId: id, wasMe: true });
    expect(yes).toMatchObject({ ok: true, wasMe: true });
    expect(yes).not.toHaveProperty("playbook");
    expect(await getSigninStore().isKnownDevice(fx.kid.tenantId, fx.kid.userId, "google", "Windows")).toBe(true);
    expect(await run(pendingSigninAlerts, fx.kid, {})).toMatchObject({ count: 0 });
    expect(tool(confirmSignin).toModelOutput(yes).value).toBe(wrapToolResult("confirm_signin", yes));

    const no = await run(confirmSignin, fx.kid, { verdictId: id, wasMe: false });
    expect(no).toMatchObject({ ok: true, wasMe: false, playbook: "account_takeover" });
    expect(await getSigninStore().isKnownDevice(fx.kid.tenantId, fx.kid.userId, "google", "Windows")).toBe(false);
    const audited = await tenantScoped(fx.db, fx.kid.tenantId).select(auditEvents);
    expect(audited.filter((e) => e.eventType === "signin.answered").map((e) => e.metadata)).toEqual([
      { verdictId: id, wasMe: true, via: "eve_chat" },
      { verdictId: id, wasMe: false, via: "eve_chat" },
    ]);
  });

  it("a verdict with no sign-in question is no_signin_check, and a caller who is not in the household is refused at once", async () => {
    const { id: plain } = await saveVerdict(fx.db, { tenantId: fx.kid.tenantId, userId: fx.kid.userId, source: "chat", verdict: triaged("suspicious") });
    expect(await run(confirmSignin, fx.kid, { verdictId: plain, wasMe: true })).toMatchObject({ ok: false, error: "no_signin_check" });

    // A session that still claims this household but whose user is not a member of it (removed since it was issued).
    const stale: Person = { ...fx.other, tenantId: fx.kid.tenantId, role: "member" };
    const id = await signinVerdict(fx.kid);
    expect(await run(confirmSignin, stale, { verdictId: id, wasMe: true })).toMatchObject({ ok: false, error: "not_allowed" });
    expect(await getSigninStore().isKnownDevice(fx.kid.tenantId, fx.kid.userId, "google", "Windows")).toBe(false);
  });
});
