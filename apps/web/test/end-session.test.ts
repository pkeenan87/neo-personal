// @vitest-environment node
/**
 * The `end_session` eve tool and its server side (_specs/v2-m3-cutover.md section 4) on PGlite with the
 * committed migrations: approval is `always()`, the owner check re-reads the database, the device, tool
 * and remote ID come from the incident's stored signals, a device that has not been in contact is refused,
 * the elder (or anyone but a child) confirms on screen, the command rides in the device's signed policy
 * bundle, and only the device it was sent to can answer it.
 */
import { wrapToolResult } from "@neo/core";
import { deviceCommands, devices, incidentActions, listOpenDeviceCommands, members, tenantScoped } from "@neo/db";
import { verifyPolicyEnvelope, type PolicyEnvelope } from "@neo/verdict";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import endSession from "../agent/tools/end_session";
import { memoryAuditLog } from "@/lib/server/audit";
import { DEVICE_COMMAND_TTL_MS } from "@neo/db";
import { applyCommandResult } from "@/lib/server/device-commands";
import { compileDeviceBundle, currentPolicyInfo, servePolicy } from "@/lib/server/policy-bundles";
import { getPolicySigningService, setPolicySigningServiceForTests } from "@/lib/server/policy-signer";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { ingestSignals } from "@/lib/server/signals/ingest";
import type { DeviceSession } from "@/lib/session";
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
const tool = endSession as unknown as Tool;

function ctxFor(p: Person | null, claimedRole: "owner" | "member" = p?.role ?? "member") {
  return {
    abortSignal: new AbortController().signal,
    session: { auth: { current: p ? { principalType: "user", principalId: p.userId, attributes: { tenantId: p.tenantId, role: claimedRole } } : null } },
  };
}

async function run(p: Person | null, input: unknown, claimedRole?: "owner" | "member"): Promise<Record<string, unknown>> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error("invalid input");
  return (await tool.execute(parsed.data, ctxFor(p, claimedRole))) as Record<string, unknown>;
}

let fx: EveFixture;
beforeAll(async () => {
  fx = await createEveFixture();
}, 60_000);
afterAll(async () => {
  await fx.close();
});
beforeEach(async () => {
  holder.db = fx.db;
  // The devices must look in contact: the request needs a device seen within two minutes.
  await setLastSeen(fx.kid, new Date());
  await setLastSeen(fx.owner, new Date());
  stubBaseEnv(vi);
  setPolicySigningServiceForTests(undefined);
  resetRateLimits();
  memoryAuditLog().length = 0;
});
afterEach(() => vi.unstubAllEnvs());

const commandsOf = (p: Person) => tenantScoped(fx.db, p.tenantId).select(deviceCommands, eq(deviceCommands.deviceId, p.deviceId));
const actionsOf = (p: Person, alertId: string) => tenantScoped(fx.db, p.tenantId).select(incidentActions, eq(incidentActions.alertId, alertId));
const sessionOf = (p: Person): DeviceSession => ({
  tenantId: p.tenantId,
  memberId: p.memberId,
  deviceId: p.deviceId,
  userId: p.userId,
  role: p.role,
  email: "x@example.test",
  name: p.deviceName,
  desktopTokenId: "token",
  scopes: ["device"],
});
async function setMode(p: Person, mode: "standard" | "elder" | "child"): Promise<void> {
  await tenantScoped(fx.db, p.tenantId).update(members, { mode, role: mode === "standard" ? "adult" : mode, ...(mode === "child" ? { birthYear: new Date().getUTCFullYear() - 12 } : {}) }, eq(members.id, p.memberId));
}
async function setLastSeen(p: Person, at: Date | null): Promise<void> {
  await tenantScoped(fx.db, p.tenantId).update(devices, { lastSeenAt: at }, eq(devices.id, p.deviceId));
}
async function clearCommands(p: Person): Promise<void> {
  await tenantScoped(fx.db, p.tenantId).delete(deviceCommands, eq(deviceCommands.deviceId, p.deviceId));
}

describe("approval and input", () => {
  it("requires approval on every call", () => {
    expect(tool.approval.request({ toolInput: { incidentId: "x" } })).toBe("user-approval");
    expect(tool.approval.request({ toolInput: undefined })).toBe("user-approval");
    expect(tool.approval.prompt({})).toMatch(/confirm on screen/);
  });

  it("takes an incident id only: no tool id, peer id, device or tenant", () => {
    expect(Object.keys(tool.inputSchema.shape)).toEqual(["incidentId"]);
    for (const extra of [{ toolId: "teamviewer" }, { peerId: "1" }, { deviceId: fx.kid.deviceId }, { tenantId: fx.other.tenantId }, { requiresConfirmation: false }]) {
      expect(tool.inputSchema.safeParse({ incidentId: fx.ownerAlertId, ...extra }).success).toBe(false);
    }
  });

  it("shows the model only the wrapToolResult envelope", () => {
    const out = { ok: true, message: "Requested." };
    expect(tool.toModelOutput(out)).toEqual({ type: "text", value: wrapToolResult("end_session", out) });
  });

  it("refuses a caller-less session", async () => {
    await expect(run(null, { incidentId: fx.ownerAlertId })).rejects.toThrow(/authenticated Neo household member/);
  });
});

describe("who may ask, and for what", () => {
  it("refuses a household member (and a caller that claims owner) and sends nothing", async () => {
    const id = await addRemoteIncident(fx.db, fx.kid);
    expect(await run(fx.kid, { incidentId: id })).toMatchObject({ ok: false, error: "not_allowed" });
    expect(await run(fx.kid, { incidentId: id }, "owner")).toMatchObject({ ok: false, error: "not_allowed" });
    expect(await commandsOf(fx.kid)).toHaveLength(0);
    expect(await actionsOf(fx.kid, id)).toHaveLength(0);
  });

  it("answers not_found for another household's incident, a bad id and without a database", async () => {
    expect(await run(fx.owner, { incidentId: fx.otherAlertId })).toEqual({ ok: false, error: "not_found" });
    expect(await run(fx.owner, { incidentId: "nope" })).toEqual({ ok: false, error: "not_found" });
    expect(await run(fx.other, { incidentId: fx.kidAlertId })).toEqual({ ok: false, error: "not_found" });
    holder.db = null;
    expect(await run(fx.owner, { incidentId: fx.kidAlertId })).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses an incident that shows no incoming remote session, and records the refusal", async () => {
    const noSignal = await addRemoteIncident(fx.db, fx.kid, null);
    const outgoing = await addRemoteIncident(fx.db, fx.kid, { toolId: "anydesk", direction: "outgoing" });
    const unknownTool = await addRemoteIncident(fx.db, fx.kid, { toolId: "not-a-real-tool", direction: "incoming" });
    const wrongKind = await addRemoteIncident(fx.db, fx.kid, { toolId: "anydesk", direction: "incoming" }, { kind: "scam_page" });
    for (const id of [noSignal, outgoing, unknownTool, wrongKind]) {
      expect(await run(fx.owner, { incidentId: id })).toMatchObject({ ok: false, error: "no_session" });
      expect(await actionsOf(fx.kid, id)).toEqual([expect.objectContaining({ kind: "end_session", status: "failed", approvedBy: fx.owner.userId })]);
    }
    expect(await commandsOf(fx.kid)).toHaveLength(0);
  });

  it("refuses an incident that is already closed", async () => {
    const id = await addRemoteIncident(fx.db, fx.kid);
    const { resolveAlert } = await import("@neo/db");
    await resolveAlert(fx.db, fx.kid.tenantId, id, "resolved", fx.owner.userId);
    expect(await run(fx.owner, { incidentId: id })).toMatchObject({ ok: false, error: "already_closed" });
  });
});

describe("the request", () => {
  it("derives the device, tool and remote ID from the stored signal and says it only requested", async () => {
    await setMode(fx.kid, "standard");
    await clearCommands(fx.kid);
    const id = await addRemoteIncident(fx.db, fx.kid, { toolId: "anydesk", direction: "incoming", peerId: "123 456 789" });
    const r = await run(fx.owner, { incidentId: id });
    expect(r).toMatchObject({ ok: true, action: "end_session", incidentId: id, status: "requested", requiresConfirmation: true });
    expect(String(r.message)).toMatch(/^Requested\./);
    expect(String(r.message)).toMatch(/Waiting for Kid to confirm/);
    // It says nothing has ended; it never claims the session did.
    expect(String(r.message).replace(/nothing has ended yet/i, "")).not.toMatch(/\bended\b|\bis over\b|\bwas closed\b/i);

    const [cmd] = await commandsOf(fx.kid);
    expect(cmd).toMatchObject({ kind: "end_session", status: "pending", deviceId: fx.kid.deviceId, alertId: id, requestedBy: fx.owner.userId, requiresConfirmation: true, payload: { toolId: "anydesk", peerId: "123 456 789" } });
    expect(cmd!.expiresAt.getTime() - cmd!.createdAt.getTime()).toBeLessThanOrEqual(DEVICE_COMMAND_TTL_MS);
    expect(r.commandId).toBe(cmd!.id);
    expect(await actionsOf(fx.kid, id)).toEqual([expect.objectContaining({ kind: "end_session", status: "pending", requestedBy: "agent", approvedBy: fx.owner.userId, result: expect.objectContaining({ commandId: cmd!.id }) })]);
    const { auditEvents } = await import("@neo/db");
    expect((await tenantScoped(fx.db, fx.kid.tenantId).select(auditEvents, eq(auditEvents.eventType, "incident.action"))).map((e) => e.metadata)).toContainEqual({ alertId: id, kind: "end_session", status: "pending" });
    // The incident stays open until the device answers.
    expect((await alertRow(fx.db, fx.kid.tenantId, id))?.status).toBe("open");
  });

  it("needs the person to confirm for an elder, a standard member and the owner's own computer, but not for a child", async () => {
    for (const [person, mode, expected] of [
      [fx.kid, "elder", true],
      [fx.kid, "standard", true],
      [fx.owner, "standard", true],
      [fx.kid, "child", false],
    ] as const) {
      await setMode(person, mode);
      await clearCommands(person);
      const id = await addRemoteIncident(fx.db, person);
      const r = await run(fx.owner, { incidentId: id });
      expect(r, `${mode}`).toMatchObject({ ok: true, requiresConfirmation: expected });
      expect((await commandsOf(person))[0]?.requiresConfirmation).toBe(expected);
      if (!expected) expect(String(r.message)).not.toMatch(/confirm/);
    }
    await setMode(fx.kid, "standard");
  });

  it("refuses a computer that has not been in contact for more than ten minutes, and sends nothing", async () => {
    await clearCommands(fx.kid);
    const id = await addRemoteIncident(fx.db, fx.kid);
    await setLastSeen(fx.kid, new Date(Date.now() - 3 * 60_000));
    const r = await run(fx.owner, { incidentId: id });
    expect(r).toMatchObject({ ok: false, error: "device_offline" });
    expect(String(r.message)).toMatch(/last checked in 3 minutes ago/);
    expect(String(r.message)).toMatch(/Nothing was sent/);
    expect(await commandsOf(fx.kid)).toHaveLength(0);
    // A computer seen a minute ago is reachable.
    await setLastSeen(fx.kid, new Date(Date.now() - 60_000));
    expect(await run(fx.owner, { incidentId: id })).toMatchObject({ ok: true });
    await setLastSeen(fx.kid, new Date());
  });

  it("refuses a revoked device and a browser extension", async () => {
    await clearCommands(fx.kid);
    const id = await addRemoteIncident(fx.db, fx.kid);
    await tenantScoped(fx.db, fx.kid.tenantId).update(devices, { kind: "browser_extension", platform: "chrome" }, eq(devices.id, fx.kid.deviceId));
    expect(await run(fx.owner, { incidentId: id })).toMatchObject({ ok: false, error: "not_supported" });
    await tenantScoped(fx.db, fx.kid.tenantId).update(devices, { kind: "desktop_agent", platform: "linux", revokedAt: new Date() }, eq(devices.id, fx.kid.deviceId));
    expect(await run(fx.owner, { incidentId: id })).toMatchObject({ ok: false, error: "not_supported" });
    await tenantScoped(fx.db, fx.kid.tenantId).update(devices, { revokedAt: null }, eq(devices.id, fx.kid.deviceId));
    expect(await commandsOf(fx.kid)).toHaveLength(0);
  });

  it("does not queue a second command for the same device and tool", async () => {
    await clearCommands(fx.kid);
    const a = await addRemoteIncident(fx.db, fx.kid);
    const b = await addRemoteIncident(fx.db, fx.kid);
    const first = await run(fx.owner, { incidentId: a });
    const second = await run(fx.owner, { incidentId: b });
    expect(second).toMatchObject({ ok: true, commandId: first.commandId });
    expect(String(second.message)).toMatch(/^Already requested/);
    expect(await commandsOf(fx.kid)).toHaveLength(1);
  });

  it("limits requests per computer", async () => {
    await clearCommands(fx.kid);
    const id = await addRemoteIncident(fx.db, fx.kid);
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 7; i++) last = await run(fx.owner, { incidentId: id });
    expect(last).toMatchObject({ ok: false, error: "rate_limited" });
  });
});

describe("the policy bundle", () => {
  it("carries the command only while it is pending and unexpired, and its presence changes policyVersion", async () => {
    await clearCommands(fx.kid);
    const device = (await tenantScoped(fx.db, fx.kid.tenantId).first(devices, eq(devices.id, fx.kid.deviceId)))!;
    const ref = { id: device.id, tenantId: device.tenantId, userId: device.userId, memberId: device.memberId };
    const before = await compileDeviceBundle(ref);
    expect(before.commands).toBeUndefined();
    expect("commands" in before).toBe(false);

    const id = await addRemoteIncident(fx.db, fx.kid, { toolId: "anydesk", direction: "incoming", peerId: "9 9" });
    const r = await run(fx.owner, { incidentId: id });
    const withCommand = await compileDeviceBundle(ref);
    expect(withCommand.commands).toEqual([{ id: r.commandId, kind: "end_session", sessionRef: { toolId: "anydesk", peerId: "9 9" }, requiresConfirmation: true, expiresAt: expect.any(String) }]);
    expect(withCommand.policyVersion).not.toBe(before.policyVersion);
    expect(await currentPolicyInfo(ref)).toEqual({ policyVersion: withCommand.policyVersion, pendingCommand: true });

    // Past its expiry the bundle is exactly the one without commands.
    const after = await compileDeviceBundle(ref, new Date(Date.now() + DEVICE_COMMAND_TTL_MS + 1000));
    expect(after.commands).toBeUndefined();
    expect(after.policyVersion).toBe(before.policyVersion);
    expect((await currentPolicyInfo(ref)).pendingCommand).toBe(true);
  });

  it("is signed with the command, marks it delivered on a 200 only, and counts as contact", async () => {
    await clearCommands(fx.kid);
    await setLastSeen(fx.kid, new Date());
    const id = await addRemoteIncident(fx.db, fx.kid);
    const r = await run(fx.owner, { incidentId: id });
    const svc = getPolicySigningService()!;

    const res = await servePolicy(sessionOf(fx.kid), null);
    expect(res).toMatchObject({ ok: true, status: 200 });
    if (!res.ok || res.status !== 200) throw new Error("expected 200");
    const verified = await verifyPolicyEnvelope(res.envelope as PolicyEnvelope, await svc.publicKeys());
    expect(verified.ok).toBe(true);
    expect(res.envelope.bundle.commands?.[0]?.id).toBe(r.commandId);
    const [row] = await commandsOf(fx.kid);
    expect(row?.status).toBe("delivered");
    const device = await tenantScoped(fx.db, fx.kid.tenantId).first(devices, eq(devices.id, fx.kid.deviceId));
    expect(device?.lastSeenAt).toBeInstanceOf(Date);

    // A matching ETag is a 304: nothing is re-marked and it carries no bundle.
    const again = await servePolicy(sessionOf(fx.kid), `"${res.policyVersion}"`);
    expect(again).toMatchObject({ ok: true, status: 304 });
    expect((await listOpenDeviceCommands(fx.db, fx.kid.tenantId, fx.kid.deviceId))).toHaveLength(1);
  });

  it("leaves the other devices of the household without the command", async () => {
    await clearCommands(fx.kid);
    await clearCommands(fx.owner);
    const sent = await run(fx.owner, { incidentId: await addRemoteIncident(fx.db, fx.kid) });
    expect(sent.ok).toBe(true);
    const other = (await tenantScoped(fx.db, fx.owner.tenantId).first(devices, eq(devices.id, fx.owner.deviceId)))!;
    const bundle = await compileDeviceBundle({ id: other.id, tenantId: other.tenantId, userId: other.userId, memberId: other.memberId });
    expect(bundle.commands).toBeUndefined();
  });
});

describe("command_result", () => {
  async function pending(person: Person): Promise<string> {
    await clearCommands(person);
    const id = await addRemoteIncident(fx.db, person);
    const r = await run(fx.owner, { incidentId: id });
    expect(r.ok).toBe(true);
    return r.commandId as string;
  }
  const event = (commandId: string, outcome: string, extra: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), type: "command", detector: "command_result", observedAt: new Date().toISOString(), commandId, outcome, ...extra });
  const send = (person: Person, events: unknown[]) => ingestSignals(sessionOf(person), person.deviceId, { events }, new Date());

  it("done closes the command, resolves the incident, and writes the action and the audit event", async () => {
    const commandId = await pending(fx.kid);
    const [before] = await commandsOf(fx.kid);
    const r = await send(fx.kid, [event(commandId, "done", { detail: "closed" })]);
    expect(r).toMatchObject({ ok: true, value: { results: [{ status: "accepted" }] } });
    const [row] = await commandsOf(fx.kid);
    expect(row).toMatchObject({ status: "done", result: { outcome: "done", detail: "closed" } });
    expect(row!.completedAt).toBeInstanceOf(Date);
    const alert = await alertRow(fx.db, fx.kid.tenantId, before!.alertId!);
    expect(alert?.status).toBe("resolved");
    const actions = await actionsOf(fx.kid, before!.alertId!);
    expect(actions.map((a) => a.status).sort()).toEqual(["done", "pending"]);
    expect(actions.find((a) => a.status === "done")?.result).toMatchObject({ commandId, outcome: "done", confirmed: true });
    const { auditEvents } = await import("@neo/db");
    expect((await tenantScoped(fx.db, fx.kid.tenantId).select(auditEvents, eq(auditEvents.eventType, "device.command_result"))).map((e) => e.metadata)).toContainEqual(expect.objectContaining({ commandId, outcome: "done" }));
    // It is no longer in the bundle.
    expect(await listOpenDeviceCommands(fx.db, fx.kid.tenantId, fx.kid.deviceId)).toHaveLength(0);
  });

  it("declined, failed and expired close the command and leave the incident open", async () => {
    for (const [outcome, status, actionStatus] of [
      ["declined", "declined", "rejected"],
      ["failed", "failed", "failed"],
      ["expired", "expired", "rejected"],
    ] as const) {
      const commandId = await pending(fx.kid);
      const [before] = await commandsOf(fx.kid);
      await send(fx.kid, [event(commandId, outcome, { detail: "kept" })]);
      expect((await commandsOf(fx.kid))[0]).toMatchObject({ status, result: { outcome, detail: "kept" } });
      expect((await alertRow(fx.db, fx.kid.tenantId, before!.alertId!))?.status).toBe("open");
      expect((await actionsOf(fx.kid, before!.alertId!)).map((a) => a.status).sort()).toEqual([actionStatus, "pending"].sort());
    }
  });

  it("rejects an answer from a different device, an unknown command and another household's command", async () => {
    const commandId = await pending(fx.kid);
    const wrongDevice = await send(fx.owner, [event(commandId, "done")]);
    expect(wrongDevice).toMatchObject({ ok: true, value: { results: [{ status: "rejected", reason: "invalid" }] } });
    const unknown = await send(fx.kid, [event(crypto.randomUUID(), "done")]);
    expect(unknown).toMatchObject({ ok: true, value: { results: [{ status: "rejected", reason: "invalid" }] } });
    const cross = await send(fx.other, [event(commandId, "done")]);
    expect(cross).toMatchObject({ ok: true, value: { results: [{ status: "rejected", reason: "invalid" }] } });
    expect((await commandsOf(fx.kid))[0]?.status).toBe("pending");
    expect(await applyCommandResult({ tenantId: fx.other.tenantId, deviceId: fx.other.deviceId, commandId, outcome: "done" })).toBe("rejected");
  });

  it("answers once: a retried batch or a second answer changes nothing", async () => {
    const commandId = await pending(fx.kid);
    const first = event(commandId, "declined");
    expect(await send(fx.kid, [first])).toMatchObject({ value: { results: [{ status: "accepted" }] } });
    expect(await send(fx.kid, [first])).toMatchObject({ value: { results: [{ status: "duplicate" }] } });
    expect(await send(fx.kid, [event(commandId, "done")])).toMatchObject({ value: { results: [{ status: "duplicate" }] } });
    expect((await commandsOf(fx.kid))[0]).toMatchObject({ status: "declined", result: { outcome: "declined" } });
  });

  it("drops a detail code it does not know and rejects a malformed answer", async () => {
    const commandId = await pending(fx.kid);
    await send(fx.kid, [event(commandId, "failed", { detail: "free_text_from_a_compromised_device" })]);
    expect((await commandsOf(fx.kid))[0]?.result).toEqual({ outcome: "failed" });
    const bad = await send(fx.kid, [event(commandId, "exploded"), { ...event(commandId, "done"), extra: 1 }]);
    expect(bad).toMatchObject({ value: { results: [{ status: "rejected", reason: "invalid" }, { status: "rejected", reason: "invalid" }] } });
  });
});
