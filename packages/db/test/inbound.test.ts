import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateLocalPart, inbound, inboundAddressFor, isInboundLocalPart } from "../src/inbound.js";
import { inboundAddresses, inboundMessages, verdicts } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

describe("generateLocalPart", () => {
  it('is "check-" + 12 lowercase Crockford base32 chars', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const lp = generateLocalPart();
      expect(lp).toMatch(/^check-[0-9abcdefghjkmnpqrstvwxyz]{12}$/);
      expect(isInboundLocalPart(lp)).toBe(true);
      seen.add(lp);
    }
    expect(seen.size).toBe(2000);
  });

  it("recognizes only well-formed local parts", () => {
    expect(isInboundLocalPart("CHECK-0123456789AB")).toBe(true);
    expect(isInboundLocalPart("check-0123456789ai")).toBe(false); // i is not Crockford
    expect(isInboundLocalPart("check-123")).toBe(false);
    expect(isInboundLocalPart("postmaster")).toBe(false);
  });

  it("builds the address only when NEO_INBOUND_DOMAIN is set", () => {
    expect(inboundAddressFor("check-0123456789ab", {})).toBeNull();
    expect(inboundAddressFor("check-0123456789ab", { NEO_INBOUND_DOMAIN: "Inbound.Example.com " })).toBe(
      "check-0123456789ab@inbound.example.com",
    );
  });
});

describe("inbound", () => {
  let t: TestDb;
  let tenantA: string;
  let tenantB: string;
  let userA: string;

  beforeAll(async () => {
    t = await createTestDb();
    const a = await createUser(t.db, "A");
    userA = a;
    const b = await createUser(t.db, "B");
    ({ tenantId: tenantA } = await createTenantForUser(t.db, { userId: a, name: "A" }));
    ({ tenantId: tenantB } = await createTenantForUser(t.db, { userId: b, name: "B" }));
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    delete process.env.NEO_INBOUND_DOMAIN;
  });

  it("ensureAddress creates once and is stable (also under concurrency)", async () => {
    process.env.NEO_INBOUND_DOMAIN = "inbound.example.test";
    const [x, y, z] = await Promise.all([
      inbound.ensureAddress(t.db, tenantA),
      inbound.ensureAddress(t.db, tenantA),
      inbound.ensureAddress(t.db, tenantA),
    ]);
    expect(y).toEqual(x);
    expect(z).toEqual(x);
    expect(x!.address).toBe(`${x!.localPart}@inbound.example.test`);
    expect(await inbound.ensureAddress(t.db, tenantA)).toEqual(x);
    expect(await tenantScoped(t.db, tenantA).count(inboundAddresses)).toBe(1);
  });

  it("findActiveByLocalPart resolves case-insensitively and ignores junk", async () => {
    const a = await inbound.ensureAddress(t.db, tenantA);
    expect(await inbound.findActiveByLocalPart(t.db, a.localPart)).toEqual({ id: a.id, tenantId: tenantA });
    expect(await inbound.findActiveByLocalPart(t.db, ` ${a.localPart.toUpperCase()} `)).toEqual({ id: a.id, tenantId: tenantA });
    expect(await inbound.findActiveByLocalPart(t.db, "check-000000000000")).toBeUndefined();
    expect(await inbound.findActiveByLocalPart(t.db, "'; drop table inbound_addresses; --")).toBeUndefined();
  });

  it("rotateAddress deactivates the old address immediately", async () => {
    const old = await inbound.ensureAddress(t.db, tenantB);
    const next = await inbound.rotateAddress(t.db, tenantB);
    expect(next.localPart).not.toBe(old.localPart);
    expect(await inbound.findActiveByLocalPart(t.db, old.localPart)).toBeUndefined();
    expect(await inbound.findActiveByLocalPart(t.db, next.localPart)).toEqual({ id: next.id, tenantId: tenantB });
    expect(await inbound.ensureAddress(t.db, tenantB)).toMatchObject({ id: next.id });
    const oldRow = await tenantScoped(t.db, tenantB).first(inboundAddresses, eq(inboundAddresses.id, old.id));
    expect(oldRow).toMatchObject({ active: false });
    expect(oldRow!.rotatedAt).toBeInstanceOf(Date);
  });

  it("records messages idempotently, updates them, counts and lists recent", async () => {
    const a = await inbound.ensureAddress(t.db, tenantA);
    const first = await inbound.recordMessage(t.db, {
      tenantId: tenantA,
      addressId: a.id,
      providerMessageId: "resend-1",
      fromAddressHash: "abc123",
      status: "received",
    });
    expect(first.duplicate).toBe(false);
    const again = await inbound.recordMessage(t.db, {
      tenantId: tenantA,
      addressId: a.id,
      providerMessageId: "resend-1",
      fromAddressHash: "abc123",
      status: "received",
    });
    expect(again).toEqual({ id: first.id, duplicate: true });

    const addr = await tenantScoped(t.db, tenantA).first(inboundAddresses, eq(inboundAddresses.id, a.id));
    expect(addr!.lastUsedAt).toBeInstanceOf(Date);

    const completedAt = new Date();
    await inbound.updateMessage(t.db, first.id, tenantA, { status: "done", error: null, completedAt });
    await inbound.updateMessage(t.db, first.id, tenantB, { status: "failed" }); // foreign tenant: no effect
    const row = await inbound.getMessage(t.db, first.id, tenantA);
    expect(row).toMatchObject({ status: "done", error: null });
    expect(row!.completedAt?.getTime()).toBe(completedAt.getTime());
    expect(await inbound.getMessage(t.db, first.id, tenantB)).toBeUndefined();

    await inbound.recordMessage(t.db, { tenantId: tenantA, addressId: a.id, providerMessageId: "resend-2", fromAddressHash: "x", status: "rejected" });
    expect(await inbound.countRecent(t.db, tenantA, a.id, 3_600_000)).toBe(2);
    expect(await inbound.countRecent(t.db, tenantB, a.id, 3_600_000)).toBe(0);

    const recent = await inbound.listRecent(t.db, tenantA, 20);
    expect(recent.map((r) => r.providerMessageId)).toEqual(["resend-2", "resend-1"]);
    expect(await inbound.listRecent(t.db, tenantB, 20)).toEqual([]);
  });

  it("rejects an invalid status via the check constraint", async () => {
    const a = await inbound.ensureAddress(t.db, tenantA);
    await expect(
      inbound.recordMessage(t.db, {
        tenantId: tenantA,
        addressId: a.id,
        providerMessageId: "resend-bad",
        fromAddressHash: "x",
        status: "bogus" as never,
      }),
    ).rejects.toThrow();
  });

  describe("as the app role (RLS)", () => {
    let addrA: { id: string; localPart: string };

    beforeAll(async () => {
      addrA = await inbound.ensureAddress(t.db, tenantA);
      await becomeAppUser(t.client);
    });
    afterAll(async () => {
      await t.client.exec("reset role");
    });

    it("sees no inbound rows without a tenant context", async () => {
      expect(await t.db.select().from(inboundAddresses)).toEqual([]);
      expect(await t.db.select().from(inboundMessages)).toEqual([]);
    });

    it("resolves an address before the tenant is known via resolve_inbound_address()", async () => {
      expect(await inbound.findActiveByLocalPart(t.db, addrA.localPart)).toEqual({ id: addrA.id, tenantId: tenantA });
    });

    it("hides another tenant's inbound rows from unfiltered raw queries", async () => {
      const rows = await tenantScoped(t.db, tenantB).transaction((s) => s.tx.select().from(inboundMessages));
      expect(rows).toEqual([]);
      const own = await tenantScoped(t.db, tenantA).transaction((s) => s.tx.select().from(inboundMessages));
      expect(own.length).toBeGreaterThan(0);
    });

    it("rejects writing an address or message into another tenant", async () => {
      await expect(
        tenantScoped(t.db, tenantB).transaction((s) =>
          s.tx.insert(inboundAddresses).values({ tenantId: tenantA, localPart: generateLocalPart(), active: false }),
        ),
      ).rejects.toThrow();
      await expect(
        tenantScoped(t.db, tenantB).transaction((s) =>
          s.tx.insert(inboundMessages).values({
            tenantId: tenantA,
            addressId: addrA.id,
            providerMessageId: "cross-tenant",
            fromAddressHash: "x",
            status: "received",
          }),
        ),
      ).rejects.toThrow();
    });

    it("supports the webhook flow end to end under RLS", async () => {
      const found = await inbound.findActiveByLocalPart(t.db, addrA.localPart);
      const { id, duplicate } = await inbound.recordMessage(t.db, {
        tenantId: found!.tenantId,
        addressId: found!.id,
        providerMessageId: "resend-rls-1",
        fromAddressHash: "h",
        status: "received",
      });
      expect(duplicate).toBe(false);
      expect(await inbound.countRecent(t.db, found!.tenantId, found!.id, 60_000)).toBeGreaterThan(0);
      await inbound.updateMessage(t.db, id, found!.tenantId, { status: "analyzing" });
      expect((await inbound.getMessage(t.db, id, found!.tenantId))?.status).toBe("analyzing");
      const rotated = await inbound.rotateAddress(t.db, tenantA);
      expect(await inbound.findActiveByLocalPart(t.db, addrA.localPart)).toBeUndefined();
      expect(await inbound.findActiveByLocalPart(t.db, rotated.localPart)).toEqual({ id: rotated.id, tenantId: tenantA });
    });

    it("purgeOld deletes only old rejected/failed rows, across tenants, via purge_old_inbound_messages()", async () => {
      const a = await inbound.ensureAddress(t.db, tenantA);
      const b = await inbound.ensureAddress(t.db, tenantB);
      const rec = (tenantId: string, addressId: string, providerMessageId: string, status: "rejected" | "failed" | "done") =>
        inbound.recordMessage(t.db, { tenantId, addressId, providerMessageId, fromAddressHash: "h", status });
      const oldRejectedA = await rec(tenantA, a.id, "purge-a-old-rejected", "rejected");
      const oldFailedB = await rec(tenantB, b.id, "purge-b-old-failed", "failed");
      const oldDoneA = await rec(tenantA, a.id, "purge-a-old-done", "done");
      const freshRejectedB = await rec(tenantB, b.id, "purge-b-fresh-rejected", "rejected");
      // Age three rows past the window (owner-only UPDATE of received_at through a definer-free path).
      await t.client.exec("reset role");
      await t.client.query(
        `update inbound_messages set received_at = now() - interval '100 days' where id in ($1, $2, $3)`,
        [oldRejectedA.id, oldFailedB.id, oldDoneA.id],
      );
      await t.client.exec("set role app_user");

      expect(await inbound.purgeOld(t.db, 90)).toBe(2);
      expect(await inbound.getMessage(t.db, oldRejectedA.id, tenantA)).toBeUndefined();
      expect(await inbound.getMessage(t.db, oldFailedB.id, tenantB)).toBeUndefined();
      expect(await inbound.getMessage(t.db, oldDoneA.id, tenantA)).toBeDefined();
      expect(await inbound.getMessage(t.db, freshRejectedB.id, tenantB)).toBeDefined();
      expect(await inbound.purgeOld(t.db, 90)).toBe(0);
    });

    it("findByVerdictId is tenant-scoped", async () => {
      const a = await inbound.ensureAddress(t.db, tenantA);
      const { id } = await inbound.recordMessage(t.db, {
        tenantId: tenantA,
        addressId: a.id,
        providerMessageId: "by-verdict-1",
        fromAddressHash: "h",
        status: "received",
      });
      const verdictId = (
        await tenantScoped(t.db, tenantA).insert(verdicts, {
          userId: userA,
          subjectType: "email",
          verdict: "suspicious",
          confidence: 0.7,
          headline: "h",
          body: {},
          source: "inbound",
        })
      )[0]!.id;
      await inbound.updateMessage(t.db, id, tenantA, { verdictId, status: "done" });
      expect((await inbound.findByVerdictId(t.db, tenantA, verdictId))?.id).toBe(id);
      expect(await inbound.findByVerdictId(t.db, tenantB, verdictId)).toBeUndefined();
      expect(await inbound.findByVerdictId(t.db, tenantA, "not-a-uuid")).toBeUndefined();
    });
  });

  it("does not grant EXECUTE on the definer functions to PUBLIC", async () => {
    const { rows } = await t.client.query<{ proname: string; acl: string | null }>(
      `select proname, proacl::text as acl from pg_proc where proname in ('resolve_inbound_address', 'list_expired_artifacts', 'purge_old_inbound_messages')`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.acl, r.proname).not.toBeNull();
      // An ACL entry for PUBLIC starts with "=" (no role name before it).
      expect(r.acl!.replace(/[{}"]/g, "").split(",").some((e) => e.startsWith("="))).toBe(false);
      expect(r.acl).toContain("app_user=X");
    }
    const { rows: fn } = await t.client.query<{ prosecdef: boolean }>(
      `select prosecdef from pg_proc where proname = 'resolve_inbound_address'`,
    );
    expect(fn[0]?.prosecdef).toBe(true);
  });
});
