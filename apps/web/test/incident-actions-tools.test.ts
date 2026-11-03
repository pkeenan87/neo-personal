// @vitest-environment node
/**
 * The acting eve tools, `mark_expected` and `allow_once` (_specs/v2-m1-elder.md section 8): approval
 * is `always()`, the owner check re-reads the database, a foreign incident is `not_found`, the tool
 * and remote ID come from the incident's stored signals (the input has no such field), the action and
 * audit rows are written, and the model only sees the wrapToolResult envelope.
 */
import { wrapToolResult } from "@neo/core";
import { incidentActions, listExpectedTools, memberships, tenantScoped } from "@neo/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import allowOnce from "../agent/tools/allow_once";
import markExpected from "../agent/tools/mark_expected";
import { memoryAuditLog } from "@/lib/server/audit";
import { addRemoteIncident, alertRow, createEveFixture, type EveFixture, type Person } from "./helpers/eve-db";
import { stubBaseEnv } from "./helpers/routes";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/server/db", () => ({ getDb: () => holder.db }));

type Tool = {
  approval: { request: (ctx: unknown) => unknown; prompt: (ctx: unknown) => string };
  execute(input: unknown, ctx: unknown): Promise<unknown>;
  toModelOutput(output: unknown): unknown;
  inputSchema: { safeParse(v: unknown): { success: boolean; data?: unknown }; shape: Record<string, unknown> };
};
const tool = (t: unknown) => t as Tool;

/** The role in the eve caller is what the session cache says; the tools must not trust it. */
function ctxFor(p: Person | null, claimedRole: "owner" | "member" = p?.role ?? "member") {
  return {
    abortSignal: new AbortController().signal,
    session: { auth: { current: p ? { principalType: "user", principalId: p.userId, attributes: { tenantId: p.tenantId, role: claimedRole } } : null } },
  };
}

async function run(t: unknown, p: Person | null, input: unknown, claimedRole?: "owner" | "member"): Promise<Record<string, unknown>> {
  const parsed = tool(t).inputSchema.safeParse(input);
  if (!parsed.success) throw new Error("invalid input");
  return (await tool(t).execute(parsed.data, ctxFor(p, claimedRole))) as Record<string, unknown>;
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
  memoryAuditLog().length = 0;
});
afterEach(() => vi.unstubAllEnvs());

const actions = (tenantId: string, alertId: string) => tenantScoped(fx.db, tenantId).select(incidentActions, eq(incidentActions.alertId, alertId));
async function auditRows(tenantId: string, type: string) {
  const { auditEvents } = await import("@neo/db");
  return tenantScoped(fx.db, tenantId).select(auditEvents, eq(auditEvents.eventType, type));
}

describe("approval and input", () => {
  it("both tools require approval on every call", () => {
    for (const t of [markExpected, allowOnce]) {
      expect(tool(t).approval.request({ toolInput: { incidentId: "x" } })).toBe("user-approval");
      expect(tool(t).approval.request({ toolInput: undefined })).toBe("user-approval");
      expect(tool(t).approval.prompt({})).toMatch(/\?/);
    }
  });

  it("take an incident id only: no tool id, peer id or tenant", () => {
    expect(Object.keys(tool(markExpected).inputSchema.shape)).toEqual(["incidentId"]);
    expect(Object.keys(tool(allowOnce).inputSchema.shape).sort()).toEqual(["incidentId", "note"]);
    for (const extra of [{ toolId: "teamviewer" }, { peerId: "1" }, { tenantId: fx.other.tenantId }]) {
      expect(tool(markExpected).inputSchema.safeParse({ incidentId: fx.ownerAlertId, ...extra }).success).toBe(false);
      expect(tool(allowOnce).inputSchema.safeParse({ incidentId: fx.ownerAlertId, ...extra }).success).toBe(false);
    }
  });

  it("treats a blank note as absent", () => {
    expect(tool(allowOnce).inputSchema.safeParse({ incidentId: fx.ownerAlertId, note: "" })).toMatchObject({ success: true, data: {} });
    expect(tool(allowOnce).inputSchema.safeParse({ incidentId: fx.ownerAlertId, note: null }).success).toBe(true);
    expect(tool(allowOnce).inputSchema.safeParse({ incidentId: fx.ownerAlertId, note: "x".repeat(201) }).success).toBe(false);
  });

  it("refuses a caller-less session", async () => {
    await expect(run(markExpected, null, { incidentId: fx.ownerAlertId })).rejects.toThrow(/authenticated Neo household member/);
  });

  it("shows the model only the wrapToolResult envelope", () => {
    const out = { ok: true, message: "done" };
    expect(tool(markExpected).toModelOutput(out)).toEqual({ type: "text", value: wrapToolResult("mark_expected", out) });
    expect(tool(allowOnce).toModelOutput(out)).toEqual({ type: "text", value: wrapToolResult("allow_once", out) });
  });
});

describe("who may act", () => {
  it("refuses a household member and changes nothing", async () => {
    const id = await addRemoteIncident(fx.db, fx.kid);
    const r = await run(allowOnce, fx.kid, { incidentId: id });
    expect(r).toMatchObject({ ok: false, error: "not_allowed" });
    expect((await alertRow(fx.db, fx.kid.tenantId, id))?.status).toBe("open");
    expect(await actions(fx.kid.tenantId, id)).toHaveLength(0);
  });

  it("refuses an eve caller that claims owner when the database says member", async () => {
    const id = await addRemoteIncident(fx.db, fx.kid);
    const r = await run(markExpected, fx.kid, { incidentId: id }, "owner");
    expect(r).toMatchObject({ ok: false, error: "not_allowed" });
    expect(await listExpectedTools(fx.db, fx.kid.tenantId, { deviceId: fx.kid.deviceId })).toHaveLength(0);
  });

  it("refuses a demoted owner whose session still says owner", async () => {
    const id = await addRemoteIncident(fx.db, fx.kid);
    const t = tenantScoped(fx.db, fx.owner.tenantId);
    await t.update(memberships, { role: "member" }, eq(memberships.userId, fx.owner.userId));
    try {
      expect(await run(allowOnce, fx.owner, { incidentId: id }, "owner")).toMatchObject({ ok: false, error: "not_allowed" });
      expect((await alertRow(fx.db, fx.kid.tenantId, id))?.status).toBe("open");
    } finally {
      await t.update(memberships, { role: "owner" }, eq(memberships.userId, fx.owner.userId));
    }
    expect(await run(allowOnce, fx.owner, { incidentId: id })).toMatchObject({ ok: true });
  });

  it("answers not_found for another household's incident, a malformed id and an unknown id", async () => {
    expect(await run(allowOnce, fx.owner, { incidentId: fx.otherAlertId })).toEqual({ ok: false, error: "not_found" });
    expect(await run(markExpected, fx.owner, { incidentId: fx.otherAlertId })).toEqual({ ok: false, error: "not_found" });
    expect(await run(allowOnce, fx.owner, { incidentId: "nope" })).toEqual({ ok: false, error: "not_found" });
    expect(await run(allowOnce, fx.owner, { incidentId: crypto.randomUUID() })).toEqual({ ok: false, error: "not_found" });
    expect((await alertRow(fx.db, fx.other.tenantId, fx.otherAlertId))?.status).toBe("open");
    // The other household's owner cannot act on this household's incident either.
    expect(await run(allowOnce, fx.other, { incidentId: fx.kidAlertId })).toEqual({ ok: false, error: "not_found" });
  });

  it("does nothing without a database", async () => {
    holder.db = null;
    expect(await run(allowOnce, fx.owner, { incidentId: fx.kidAlertId })).toEqual({ ok: false, error: "not_found" });
  });
});

describe("mark_expected", () => {
  it("derives the tool and remote ID from the stored signal, adds them, closes the incident and records it", async () => {
    const id = await addRemoteIncident(fx.db, fx.kid, { toolId: "anydesk", direction: "incoming", peerId: "123 456 789" });
    const r = await run(markExpected, fx.owner, { incidentId: id });
    expect(r).toMatchObject({ ok: true, action: "mark_expected", incidentId: id, status: "false_positive" });
    expect(String(r.message)).toMatch(/AnyDesk/);

    const expected = await listExpectedTools(fx.db, fx.kid.tenantId, { deviceId: fx.kid.deviceId });
    expect(expected).toEqual([expect.objectContaining({ toolId: "anydesk", peerIds: ["123 456 789"], createdBy: fx.owner.userId })]);

    const row = await alertRow(fx.db, fx.kid.tenantId, id);
    expect(row).toMatchObject({ status: "false_positive", acknowledgedBy: fx.owner.userId });
    expect(row?.resolvedAt).toBeInstanceOf(Date);

    expect(await actions(fx.kid.tenantId, id)).toEqual([
      expect.objectContaining({ kind: "mark_expected", requestedBy: "agent", approvedBy: fx.owner.userId, status: "done", result: { toolId: "anydesk", peerSaved: true } }),
    ]);
    expect((await auditRows(fx.kid.tenantId, "incident.action")).map((e) => e.metadata)).toContainEqual({ alertId: id, kind: "mark_expected", status: "done" });
    expect(await auditRows(fx.kid.tenantId, "device.expected_tools_changed")).not.toHaveLength(0);
  });

  it("merges with what is already allowed and keeps it", async () => {
    const t = tenantScoped(fx.db, fx.owner.tenantId);
    const { setExpectedTools } = await import("@neo/db");
    await setExpectedTools(fx.db, { tenantId: fx.owner.tenantId, deviceId: fx.kid.deviceId, tools: [{ toolId: "teamviewer", peerIds: ["999"] }, { toolId: "anydesk", peerIds: ["111"] }], createdBy: fx.owner.userId });
    const id = await addRemoteIncident(fx.db, fx.kid, { toolId: "anydesk", direction: "incoming", peerId: "222" });
    expect(await run(markExpected, fx.owner, { incidentId: id })).toMatchObject({ ok: true });
    const rows = await listExpectedTools(fx.db, fx.kid.tenantId, { deviceId: fx.kid.deviceId });
    expect(rows.find((r) => r.toolId === "teamviewer")?.peerIds).toEqual(["999"]);
    expect(rows.find((r) => r.toolId === "anydesk")?.peerIds).toEqual(["111", "222"]);
    expect(t.tenantId).toBe(fx.owner.tenantId);
  });

  it("uses the stored signal, not anything the model passes", async () => {
    const id = await addRemoteIncident(fx.db, fx.kid, { toolId: "teamviewer", direction: "incoming", peerId: "555" });
    // A model-supplied tool id is rejected by the schema (strict), so the only way in is the incident.
    expect(tool(markExpected).inputSchema.safeParse({ incidentId: id, toolId: "anydesk" }).success).toBe(false);
    await run(markExpected, fx.owner, { incidentId: id });
    const rows = await listExpectedTools(fx.db, fx.kid.tenantId, { deviceId: fx.kid.deviceId });
    expect(rows.some((r) => r.toolId === "teamviewer" && r.peerIds.includes("555"))).toBe(true);
  });

  it("refuses an incident that is not about a remote-access tool, and records the refusal", async () => {
    const noSignal = await addRemoteIncident(fx.db, fx.kid, null);
    expect(await run(markExpected, fx.owner, { incidentId: noSignal })).toMatchObject({ ok: false, error: "not_remote_access" });
    const wrongKind = await addRemoteIncident(fx.db, fx.kid, { toolId: "anydesk", direction: "incoming" }, { kind: "scam_page" });
    expect(await run(markExpected, fx.owner, { incidentId: wrongKind })).toMatchObject({ ok: false, error: "not_remote_access" });
    expect(await run(markExpected, fx.owner, { incidentId: fx.kidAlertId })).toMatchObject({ ok: false, error: "not_remote_access" });
    for (const id of [noSignal, wrongKind]) {
      expect((await alertRow(fx.db, fx.kid.tenantId, id))?.status).toBe("open");
      expect(await actions(fx.kid.tenantId, id)).toEqual([expect.objectContaining({ kind: "mark_expected", status: "failed", approvedBy: fx.owner.userId })]);
    }
  });

  it("refuses an unknown tool or an unsavable remote ID without changing anything", async () => {
    const before = await listExpectedTools(fx.db, fx.kid.tenantId, { deviceId: fx.kid.deviceId });
    const unknown = await addRemoteIncident(fx.db, fx.kid, { toolId: "not-a-real-tool", direction: "incoming" });
    const badPeer = await addRemoteIncident(fx.db, fx.kid, { toolId: "anydesk", direction: "incoming", peerId: "<script>" });
    for (const id of [unknown, badPeer]) {
      const r = await run(markExpected, fx.owner, { incidentId: id });
      expect(r).toMatchObject({ ok: false, error: "failed" });
      expect(String(r.message)).toMatch(/Nothing was changed/);
      expect((await alertRow(fx.db, fx.kid.tenantId, id))?.status).toBe("open");
    }
    expect(await listExpectedTools(fx.db, fx.kid.tenantId, { deviceId: fx.kid.deviceId })).toEqual(before);
  });

  it("respects the limit of 10 tools per device", async () => {
    const { setExpectedTools, listExpectedTools: list } = await import("@neo/db");
    // Ten slots taken (the limit is on the count, so the ids need not be real tools).
    const tools = Array.from({ length: 10 }, (_, i) => ({ toolId: `filler_${i}`, peerIds: [] as string[] }));
    await setExpectedTools(fx.db, { tenantId: fx.owner.tenantId, deviceId: fx.owner.deviceId, tools, createdBy: fx.owner.userId });
    const id = await addRemoteIncident(fx.db, fx.owner, { toolId: "anydesk", direction: "incoming", peerId: "1" });
    expect(await run(markExpected, fx.owner, { incidentId: id })).toMatchObject({ ok: false, error: "failed" });
    expect((await list(fx.db, fx.owner.tenantId, { deviceId: fx.owner.deviceId })).some((r) => r.toolId === "anydesk")).toBe(false);
    expect((await alertRow(fx.db, fx.owner.tenantId, id))?.status).toBe("open");
  });

  it("refuses an incident that is already closed", async () => {
    const id = await addRemoteIncident(fx.db, fx.kid);
    expect(await run(markExpected, fx.owner, { incidentId: id })).toMatchObject({ ok: true });
    expect(await run(markExpected, fx.owner, { incidentId: id })).toMatchObject({ ok: false, error: "already_closed" });
    expect(await actions(fx.kid.tenantId, id)).toHaveLength(1);
  });
});

describe("allow_once", () => {
  it("resolves the incident with no policy change and records the decision and the note", async () => {
    const id = await addRemoteIncident(fx.db, fx.owner);
    const before = await listExpectedTools(fx.db, fx.owner.tenantId, { deviceId: fx.owner.deviceId });
    const r = await run(allowOnce, fx.owner, { incidentId: id, note: "  I was helping Gran  " });
    expect(r).toMatchObject({ ok: true, action: "allow_once", status: "resolved" });
    expect(await listExpectedTools(fx.db, fx.owner.tenantId, { deviceId: fx.owner.deviceId })).toEqual(before);
    const row = await alertRow(fx.db, fx.owner.tenantId, id);
    expect(row).toMatchObject({ status: "resolved" });
    expect(row?.resolvedAt).toBeInstanceOf(Date);
    expect(await actions(fx.owner.tenantId, id)).toEqual([
      expect.objectContaining({ kind: "allow_once", requestedBy: "agent", approvedBy: fx.owner.userId, status: "done", result: { note: "I was helping Gran" } }),
    ]);
    expect((await auditRows(fx.owner.tenantId, "incident.action")).map((e) => e.metadata)).toContainEqual({ alertId: id, kind: "allow_once", status: "done" });
    // The note is not copied into the audit trail.
    expect(JSON.stringify(await auditRows(fx.owner.tenantId, "incident.action"))).not.toContain("Gran");
  });

  it("works on any kind of incident, and refuses one already resolved or marked a false alarm", async () => {
    expect(await run(allowOnce, fx.owner, { incidentId: fx.kidAlertId })).toMatchObject({ ok: true });
    expect(await run(allowOnce, fx.owner, { incidentId: fx.kidAlertId })).toMatchObject({ ok: false, error: "already_closed" });
    const fp = await addRemoteIncident(fx.db, fx.kid);
    await run(markExpected, fx.owner, { incidentId: fp });
    expect(await run(allowOnce, fx.owner, { incidentId: fp })).toMatchObject({ ok: false, error: "already_closed" });
  });

  it("allows an acknowledged incident to be closed", async () => {
    const id = await addRemoteIncident(fx.db, fx.kid);
    const { acknowledgeAlert } = await import("@neo/db");
    await acknowledgeAlert(fx.db, fx.kid.tenantId, id, fx.owner.userId);
    expect(await run(allowOnce, fx.owner, { incidentId: id })).toMatchObject({ ok: true });
  });
});
