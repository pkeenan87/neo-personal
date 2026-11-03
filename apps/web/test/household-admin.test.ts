// @vitest-environment node
/** requireHouseholdAdmin re-reads the membership role from the database; the caller's own role claim is ignored. */
import { memberships, tenantScoped } from "@neo/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requireHouseholdAdmin } from "@/lib/server/household-admin";
import { resetMemoryState, stubBaseEnv } from "./helpers/routes";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { createEveFixture, type EveFixture } from "./helpers/eve-db";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/server/db", () => ({ getDb: () => holder.db }));

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
afterEach(() => {
  vi.unstubAllEnvs();
  resetMemoryState();
});

describe("with a database", () => {
  it("accepts an owner and refuses a member, whatever role they claim", async () => {
    expect(await requireHouseholdAdmin({ tenantId: fx.owner.tenantId, userId: fx.owner.userId, role: "member" })).toEqual({ ok: true });
    const refused = await requireHouseholdAdmin({ tenantId: fx.kid.tenantId, userId: fx.kid.userId, role: "owner" });
    expect(refused).toMatchObject({ ok: false, status: 403, code: "forbidden" });
  });

  it("refuses an owner who was demoted after their session was issued, and accepts them again once restored", async () => {
    const t = tenantScoped(fx.db, fx.owner.tenantId);
    const actor = { tenantId: fx.owner.tenantId, userId: fx.owner.userId, role: "owner" as const };
    await t.update(memberships, { role: "member" }, eq(memberships.userId, fx.owner.userId));
    expect(await requireHouseholdAdmin(actor)).toMatchObject({ ok: false, status: 403 });
    await t.update(memberships, { role: "owner" }, eq(memberships.userId, fx.owner.userId));
    expect(await requireHouseholdAdmin(actor)).toEqual({ ok: true });
  });

  it("refuses someone who is no longer in the household, and an owner of another household", async () => {
    expect(await requireHouseholdAdmin({ tenantId: fx.owner.tenantId, userId: "gone-user", role: "owner" })).toMatchObject({ ok: false });
    expect(await requireHouseholdAdmin({ tenantId: fx.owner.tenantId, userId: fx.other.userId, role: "owner" })).toMatchObject({ ok: false });
    expect(await requireHouseholdAdmin({ tenantId: fx.other.tenantId, userId: fx.owner.userId, role: "owner" })).toMatchObject({ ok: false });
  });
});

describe("without a database (MOCK_MODE)", () => {
  beforeEach(() => {
    holder.db = null;
  });

  it("reads the in-memory household", async () => {
    setMemoryMembers("t1", [
      { userId: "o", name: "Pat", email: "p@x.test", role: "owner" },
      { userId: "m", name: "Kid", email: "k@x.test", role: "member" },
    ]);
    expect(await requireHouseholdAdmin({ tenantId: "t1", userId: "o", role: "member" })).toEqual({ ok: true });
    expect(await requireHouseholdAdmin({ tenantId: "t1", userId: "m", role: "owner" })).toMatchObject({ ok: false });
    expect(await requireHouseholdAdmin({ tenantId: "t1", userId: "stranger", role: "owner" })).toMatchObject({ ok: false });
  });

  it("falls back to the claimed role only for a household nothing is registered for", async () => {
    expect(await requireHouseholdAdmin({ tenantId: "unregistered", userId: "u", role: "owner" })).toEqual({ ok: true });
    expect(await requireHouseholdAdmin({ tenantId: "unregistered", userId: "u", role: "member" })).toMatchObject({ ok: false });
  });
});
