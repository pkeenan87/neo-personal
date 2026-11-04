// @vitest-environment node
/**
 * No silent expiry (_specs/v2-m3-cutover.md section 4): an `end_session` request that nobody answers is
 * expired by the 5-minute sweep, its pending action is settled as failed with reason "expired", the
 * incident says so to `get_incident`, and the tool's result says up front that it is a request that
 * expires. Liveness is two minutes.
 */
import { deviceCommands, devices, incidentActions, tenantScoped, DEVICE_COMMAND_TTL_MS } from "@neo/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import endSession from "../agent/tools/end_session";
import getIncident from "../agent/tools/get_incident";
import { memoryAuditLog } from "@/lib/server/audit";
import { applyCommandResult, expireStaleCommands, listExpiredCommands } from "@/lib/server/device-commands";
import { END_SESSION_LIVE_WITHIN_MS } from "@/lib/server/end-session";
import { loadIncident } from "@/lib/server/incident-data";
import { resetRateLimits } from "@/lib/server/rate-limit";
import { addRemoteIncident, alertRow, createEveFixture, type EveFixture, type Person } from "./helpers/eve-db";
import { stubBaseEnv } from "./helpers/routes";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/server/db", () => ({ getDb: () => holder.db }));

type Tool = { execute(input: unknown, ctx: unknown): Promise<unknown>; toModelOutput(output: unknown): { value: string } };
const ctxFor = (p: Person) => ({ abortSignal: new AbortController().signal, session: { auth: { current: { principalType: "user", principalId: p.userId, attributes: { tenantId: p.tenantId, role: p.role } } } } });
const call = async (t: unknown, p: Person, input: unknown) => (await (t as Tool).execute(input, ctxFor(p))) as Record<string, unknown>;

let fx: EveFixture;
beforeAll(async () => {
  fx = await createEveFixture();
}, 60_000);
afterAll(async () => {
  await fx.close();
});
beforeEach(async () => {
  holder.db = fx.db;
  stubBaseEnv(vi);
  resetRateLimits();
  memoryAuditLog().length = 0;
  await tenantScoped(fx.db, fx.kid.tenantId).delete(deviceCommands);
  await tenantScoped(fx.db, fx.kid.tenantId).update(devices, { lastSeenAt: new Date() }, eq(devices.id, fx.kid.deviceId));
});
afterEach(() => vi.unstubAllEnvs());

const actionsOf = (alertId: string) => tenantScoped(fx.db, fx.kid.tenantId).select(incidentActions, eq(incidentActions.alertId, alertId));
const later = (ms: number) => new Date(Date.now() + ms);

async function requestFor(): Promise<{ incidentId: string; commandId: string }> {
  const incidentId = await addRemoteIncident(fx.db, fx.kid);
  const r = await call(endSession, fx.owner, { incidentId });
  expect(r.ok).toBe(true);
  return { incidentId, commandId: r.commandId as string };
}

describe("the result says it is a request that expires", () => {
  it("in every variant: asked, already asked, and no confirmation", async () => {
    const { incidentId } = await requestFor();
    const again = await call(endSession, fx.owner, { incidentId: await addRemoteIncident(fx.db, fx.kid) });
    expect(String(again.message)).toMatch(/Already requested/);
    for (const r of [again, await (async () => (await call(endSession, fx.owner, { incidentId }))) ()]) expect(String(r.message)).toMatch(/expires in 10 minutes if the computer does not answer/);

    await tenantScoped(fx.db, fx.kid.tenantId).delete(deviceCommands);
    const first = await call(endSession, fx.owner, { incidentId: await addRemoteIncident(fx.db, fx.kid) });
    expect(String(first.message)).toMatch(/^Requested\./);
    expect(String(first.message)).toMatch(/This is a request: it expires in 10 minutes if the computer does not answer/);
    // The model sees the same words, inside the envelope.
    expect((endSession as unknown as Tool).toModelOutput(first).value).toContain("expires in 10 minutes");
  });
});

describe("liveness is two minutes", () => {
  it("refuses a device not seen within two minutes with the plain message, and sends nothing", async () => {
    expect(END_SESSION_LIVE_WITHIN_MS).toBe(120_000);
    const incidentId = await addRemoteIncident(fx.db, fx.kid);
    await tenantScoped(fx.db, fx.kid.tenantId).update(devices, { lastSeenAt: new Date(Date.now() - 150_000) }, eq(devices.id, fx.kid.deviceId));
    const r = await call(endSession, fx.owner, { incidentId });
    expect(r).toMatchObject({ ok: false, error: "device_offline" });
    expect(String(r.message)).toMatch(/^Neo can't reach that device right now/);
    expect(await tenantScoped(fx.db, fx.kid.tenantId).select(deviceCommands)).toHaveLength(0);
    await tenantScoped(fx.db, fx.kid.tenantId).update(devices, { lastSeenAt: new Date(Date.now() - 90_000) }, eq(devices.id, fx.kid.deviceId));
    expect(await call(endSession, fx.owner, { incidentId })).toMatchObject({ ok: true });
  });
});

describe("expiry is eager", () => {
  it("expires an unanswered command, settles its action as failed/expired, audits it, and the incident says so", async () => {
    const { incidentId, commandId } = await requestFor();
    expect(await listExpiredCommands(later(5 * 60_000))).toEqual([]);
    const past = later(DEVICE_COMMAND_TTL_MS + 60_000);
    expect(await listExpiredCommands(past)).toEqual([{ id: commandId, tenantId: fx.kid.tenantId }]);
    // Reading changed nothing.
    expect((await tenantScoped(fx.db, fx.kid.tenantId).select(deviceCommands))[0]?.status).toBe("pending");

    expect(await expireStaleCommands(past)).toBe(1);
    const [row] = await tenantScoped(fx.db, fx.kid.tenantId).select(deviceCommands);
    expect(row).toMatchObject({ id: commandId, status: "expired", result: { outcome: "expired", reason: "no_response" } });
    expect(await actionsOf(incidentId)).toEqual([expect.objectContaining({ kind: "end_session", status: "failed", result: expect.objectContaining({ commandId, reason: "expired" }) })]);
    const { auditEvents } = await import("@neo/db");
    expect((await tenantScoped(fx.db, fx.kid.tenantId).select(auditEvents, eq(auditEvents.eventType, "device.command_expired"))).map((e) => e.metadata)).toContainEqual({ commandId, alertId: incidentId });
    // The incident stays open for the owner, and says what happened.
    expect((await alertRow(fx.db, fx.kid.tenantId, incidentId))?.status).toBe("open");
    const loaded = await loadIncident({ tenantId: fx.owner.tenantId, userId: fx.owner.userId, role: "owner" }, incidentId);
    expect(loaded?.incident.endSessionRequests).toEqual([expect.objectContaining({ status: "failed", note: "The request to end the session expired — the device didn't respond." })]);
    const viaTool = (getIncident as unknown as Tool).toModelOutput(await call(getIncident, fx.owner, { incidentId })).value;
    expect(viaTool).toContain("the device didn't respond");
    // Nothing more to do on the next sweep.
    expect(await expireStaleCommands(past)).toBe(0);
  });

  it("leaves a command that is still within its ten minutes, and one the device already answered", async () => {
    const live = await requestFor();
    const answered = await (async () => {
      await tenantScoped(fx.db, fx.kid.tenantId).delete(deviceCommands, eq(deviceCommands.id, live.commandId));
      return requestFor();
    })();
    expect(await applyCommandResult({ tenantId: fx.kid.tenantId, deviceId: fx.kid.deviceId, commandId: answered.commandId, outcome: "declined", detail: "kept" })).toBe("applied");
    expect(await expireStaleCommands(later(60_000))).toBe(0);
    expect(await expireStaleCommands(later(DEVICE_COMMAND_TTL_MS + 60_000))).toBe(0);
    expect((await tenantScoped(fx.db, fx.kid.tenantId).select(deviceCommands, eq(deviceCommands.id, answered.commandId)))[0]?.status).toBe("declined");
  });

  it("shows one line per request: an answered request replaces its pending line", async () => {
    const { incidentId, commandId } = await requestFor();
    const caller = { tenantId: fx.owner.tenantId, userId: fx.owner.userId, role: "owner" as const };
    expect((await loadIncident(caller, incidentId))?.incident.endSessionRequests).toEqual([expect.objectContaining({ status: "pending", note: expect.stringMatching(/Waiting for the device/) })]);
    await applyCommandResult({ tenantId: fx.kid.tenantId, deviceId: fx.kid.deviceId, commandId, outcome: "done", detail: "closed" });
    const notes = (await loadIncident(caller, incidentId))?.incident.endSessionRequests ?? [];
    expect(notes.map((n) => n.status)).toEqual(["done"]);
    expect(notes[0]?.note).toMatch(/ended the remote session/);
  });

  it("an incident that never had a request has no endSessionRequests", async () => {
    const incidentId = await addRemoteIncident(fx.db, fx.kid);
    const loaded = await loadIncident({ tenantId: fx.owner.tenantId, userId: fx.owner.userId, role: "owner" }, incidentId);
    expect(loaded?.incident).not.toHaveProperty("endSessionRequests");
  });
});
