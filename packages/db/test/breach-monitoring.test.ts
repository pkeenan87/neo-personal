import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { breachMonitoring } from "../src/breach-monitoring.js";
import { createTenantForUser } from "../src/tenants.js";
import { breachObservations, memberships, monitoredAddresses } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

let t: TestDb;
let userId: string;
let tenantId: string;
let secondMemberUserId: string;
let otherUserId: string;
let otherTenantId: string;
const at = (day: number, hour = 0) => new Date(Date.UTC(2026, 9, day, hour));
const digest = (n: number) => n.toString(16).padStart(64, "0");
const encrypted = (n: number) => new Uint8Array([0x4e, 0x45, n]);

beforeAll(async () => {
  t = await createTestDb({ createAppUserBeforeMigrations: true });
  const grants = await t.client.query<{ addressSelect: boolean; addressInsert: boolean; addressUpdate: boolean; addressDelete: boolean; observationSelect: boolean; observationInsert: boolean; observationUpdate: boolean; observationDelete: boolean; listExecute: boolean; purgeExecute: boolean }>(
    `SELECT
      has_table_privilege('app_user', 'public.monitored_addresses', 'SELECT') AS "addressSelect",
      has_table_privilege('app_user', 'public.monitored_addresses', 'INSERT') AS "addressInsert",
      has_table_privilege('app_user', 'public.monitored_addresses', 'UPDATE') AS "addressUpdate",
      has_table_privilege('app_user', 'public.monitored_addresses', 'DELETE') AS "addressDelete",
      has_table_privilege('app_user', 'public.breach_observations', 'SELECT') AS "observationSelect",
      has_table_privilege('app_user', 'public.breach_observations', 'INSERT') AS "observationInsert",
      has_table_privilege('app_user', 'public.breach_observations', 'UPDATE') AS "observationUpdate",
      has_table_privilege('app_user', 'public.breach_observations', 'DELETE') AS "observationDelete",
      has_function_privilege('app_user', 'public.list_monitored_breach_addresses(uuid,text,uuid,integer)', 'EXECUTE') AS "listExecute",
      has_function_privilege('app_user', 'public.purge_expired_breach_verification_tokens()', 'EXECUTE') AS "purgeExecute"`,
  );
  expect(grants.rows[0]).toEqual({ addressSelect: true, addressInsert: true, addressUpdate: true, addressDelete: true, observationSelect: true, observationInsert: true, observationUpdate: true, observationDelete: true, listExecute: true, purgeExecute: true });
  const publicExecute = await t.client.query<{ list: boolean; purge: boolean }>(
    `SELECT has_function_privilege('public', 'public.list_monitored_breach_addresses(uuid,text,uuid,integer)', 'EXECUTE') AS list,
            has_function_privilege('public', 'public.purge_expired_breach_verification_tokens()', 'EXECUTE') AS purge`,
  );
  expect(publicExecute.rows[0]).toEqual({ list: false, purge: false });
  userId = await createUser(t.db, "Owner");
  tenantId = (await createTenantForUser(t.db, { userId, name: "A" })).tenantId;
  secondMemberUserId = await createUser(t.db, "Other member");
  await t.db.insert(memberships).values({ tenantId, userId: secondMemberUserId, role: "member" });
  otherUserId = await createUser(t.db, "Other owner");
  otherTenantId = (await createTenantForUser(t.db, { userId: otherUserId, name: "B" })).tenantId;
  await becomeAppUser(t.client);
});

afterAll(async () => { await t?.close(); });

describe("breach monitoring persistence (PGlite as app_user)", () => {
  it("enforces an atomic three-send rolling cap and consumes a token once", async () => {
    const input = { tenantId, userId, digest: digest(1), addressId: "11111111-1111-4111-8111-111111111111", encryptedAddress: encrypted(1), tokenHash: "a".repeat(64), expiresAt: at(6), now: at(5) };
    const first = await breachMonitoring.requestVerification(t.db, input);
    expect(first.status).toBe("reserved");
    expect(first.address?.verificationTokenHash).toBe(input.tokenHash);
    const secondMemberSend = await breachMonitoring.requestVerification(t.db, { ...input, userId: secondMemberUserId, addressId: "88888888-8888-4888-8888-888888888888", tokenHash: "b".repeat(64), now: at(5, 1) });
    const second = await breachMonitoring.requestVerification(t.db, { ...input, tokenHash: "c".repeat(64), now: at(5, 2) });
    expect(secondMemberSend.status).toBe("reserved");
    expect(second.status).toBe("reserved");
    const third = await breachMonitoring.requestVerification(t.db, { ...input, tokenHash: "d".repeat(64), now: at(5, 3) });
    expect(third.status).toBe("rate_limited");
    const otherMemberFourth = await breachMonitoring.requestVerification(t.db, { ...input, userId: secondMemberUserId, addressId: "88888888-8888-4888-8888-888888888888", tokenHash: "e".repeat(64), now: at(5, 4) });
    expect(otherMemberFourth.status).toBe("rate_limited");
    expect(await breachMonitoring.verifyAddress(t.db, { tenantId, userId, tokenHash: "d".repeat(64), verifiedAt: at(5, 5) })).toBeUndefined();
    expect(await breachMonitoring.verifyAddress(t.db, { tenantId, userId, tokenHash: "c".repeat(64), verifiedAt: at(5, 5) })).toMatchObject({ verifiedAt: at(5, 5), verificationPending: false, verificationTokenHash: undefined });
    expect(await breachMonitoring.verifyAddress(t.db, { tenantId, userId, tokenHash: "c".repeat(64), verifiedAt: at(5, 6) })).toBeUndefined();
    const nextDay = await breachMonitoring.requestVerification(t.db, { ...input, digest: digest(2), addressId: "22222222-2222-4222-8222-222222222222", tokenHash: "e".repeat(64), now: at(6, 1), expiresAt: at(7) });
    expect(nextDay.status).toBe("reserved");
    await breachMonitoring.deleteUserAddresses(t.db, tenantId, userId);
    await breachMonitoring.deleteUserAddresses(t.db, tenantId, secondMemberUserId);
  });

  it("enforces five extra addresses per user but permits the same normalized address in another household", async () => {
    for (let i = 10; i < 15; i++) {
      const r = await breachMonitoring.requestVerification(t.db, { tenantId, userId, digest: digest(i), addressId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, encryptedAddress: encrypted(i), tokenHash: `${String(i).padStart(2, "0")}${"f".repeat(62)}`, expiresAt: at(6), now: at(5) });
      expect(r.status).toBe("reserved");
    }
    const sixth = await breachMonitoring.requestVerification(t.db, { tenantId, userId, digest: digest(15), addressId: "00000000-0000-4000-8000-000000000015", encryptedAddress: encrypted(15), tokenHash: "0f" + "e".repeat(62), expiresAt: at(6), now: at(5) });
    expect(sixth.status).toBe("address_limit");
    const anotherHousehold = await breachMonitoring.requestVerification(t.db, { tenantId: otherTenantId, userId: otherUserId, digest: digest(10), addressId: "00000000-0000-4000-8000-000000000016", encryptedAddress: encrypted(16), tokenHash: "10" + "d".repeat(62), expiresAt: at(6), now: at(5) });
    expect(anotherHousehold.status).toBe("reserved");
  });

  it("lists only the tenant user's verified addresses and hides cross-tenant rows", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const verified = await breachMonitoring.addVerifiedAddress(t.db, { tenantId, userId, addressId: id, digest: digest(30), encryptedAddress: encrypted(30), verifiedAt: at(4), now: at(4) });
    expect(verified.verificationPending).toBe(false);
    expect(await breachMonitoring.listAddresses(t.db, tenantId, userId)).toContainEqual(expect.objectContaining({ id }));
    expect(await breachMonitoring.listAddresses(t.db, otherTenantId, userId)).toEqual([]);
    expect(await breachMonitoring.getAddressForCheck(t.db, { tenantId, userId, addressId: id })).toMatchObject({ id, verifiedAt: at(4) });
    expect(await breachMonitoring.getAddressForCheck(t.db, { tenantId, userId: otherUserId, addressId: id })).toBeUndefined();
  });

  it("discovers verified addresses through the grant-limited identifier-only function", async () => {
    const page = await breachMonitoring.listEligibleAddressIds(t.db, { limit: 1000 });
    expect(page.items).toContainEqual({ tenantId, userId, addressId: "33333333-3333-4333-8333-333333333333" });
    expect(page.items.every((item) => Object.keys(item).sort().join(",") === "addressId,tenantId,userId")).toBe(true);
    expect(page.items).not.toContainEqual(expect.objectContaining({ addressId: "00000000-0000-4000-8000-000000000016" }));
  });

  it("updates check freshness truthfully and upserts metadata without re-alerting retired breaches", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    await breachMonitoring.addVerifiedAddress(t.db, { tenantId, userId, addressId: id, digest: digest(40), encryptedAddress: encrypted(40), verifiedAt: at(4), now: at(4) });
    await breachMonitoring.updateCheck(t.db, { tenantId, userId, addressId: id, status: "clean", checkedAt: at(5) });
    expect(await breachMonitoring.getAddressForCheck(t.db, { tenantId, userId, addressId: id })).toMatchObject({ checkStatus: "clean", lastSuccessfulCheckAt: at(5) });
    await breachMonitoring.updateCheck(t.db, { tenantId, userId, addressId: id, status: "failed", checkedAt: at(5, 2) });
    expect(await breachMonitoring.getAddressForCheck(t.db, { tenantId, userId, addressId: id })).toMatchObject({ checkStatus: "failed", lastCheckedAt: at(5, 2), lastSuccessfulCheckAt: at(5) });
    const breach = { breachName: "Northstar", domain: "northstar.example", breachDate: new Date("2024-01-02T00:00:00Z"), addedDate: at(3), dataClasses: ["Passwords"] };
    expect((await breachMonitoring.upsertObservations(t.db, { tenantId, userId, addressId: id, observations: [breach], now: at(5) })).newObservations.map(x => x.breachName)).toEqual(["Northstar"]);
    expect((await breachMonitoring.upsertObservations(t.db, { tenantId, userId, addressId: id, observations: [{ ...breach, domain: "updated.example", dataClasses: ["Passwords", "Usernames"] }], now: at(5, 3) })).newObservations).toEqual([]);
    expect(await breachMonitoring.listObservations(t.db, { tenantId, userId, addressId: id })).toMatchObject([{ breachName: "Northstar", domain: "updated.example", dataClasses: ["Passwords", "Usernames"], firstSeenAt: at(5), lastSeenAt: at(5, 3) }]);
    await breachMonitoring.upsertObservations(t.db, { tenantId, userId, addressId: id, observations: [{ ...breach, retiredAt: at(5, 4) }], now: at(5, 4) });
    expect((await breachMonitoring.upsertObservations(t.db, { tenantId, userId, addressId: id, observations: [{ ...breach, retiredAt: at(5, 4) }], now: at(5, 5) })).newObservations).toEqual([]);
    expect(await breachMonitoring.listObservations(t.db, { tenantId, userId, addressId: id })).toMatchObject([{ retiredAt: at(5, 4) }]);
    const reappeared = await breachMonitoring.upsertObservations(t.db, { tenantId, userId, addressId: id, observations: [{ ...breach, domain: "restored.example" }], now: at(5, 6) });
    expect(reappeared.newObservations).toEqual([]);
    expect(await breachMonitoring.listObservations(t.db, { tenantId, userId, addressId: id })).toMatchObject([{ domain: "restored.example", retiredAt: at(5, 4) }]);
  });

  it("hard-deletes extra address rows and cascades observations", async () => {
    const id = "55555555-5555-4555-8555-555555555555";
    const tokenHash = "5".repeat(64);
    await breachMonitoring.requestVerification(t.db, { tenantId: otherTenantId, userId: otherUserId, addressId: id, digest: digest(50), encryptedAddress: encrypted(50), tokenHash, expiresAt: at(5), now: at(4) });
    await breachMonitoring.verifyAddress(t.db, { tenantId: otherTenantId, userId: otherUserId, tokenHash, verifiedAt: at(4, 1) });
    await breachMonitoring.upsertObservations(t.db, { tenantId: otherTenantId, userId: otherUserId, addressId: id, observations: [{ breachName: "Cascade", dataClasses: [] }], now: at(4) });
    expect(await breachMonitoring.removeAddress(t.db, { tenantId: otherTenantId, userId: otherUserId, addressId: id })).toBe(true);
    expect(await tenantScoped(t.db, otherTenantId).first(monitoredAddresses, eq(monitoredAddresses.id, id))).toBeUndefined();
    expect(await tenantScoped(t.db, otherTenantId).select(breachObservations, eq(breachObservations.monitoredAddressId, id))).toEqual([]);
  });

  it("cleans only expired verification token fields through the security-definer sweeper", async () => {
    const now = new Date();
    const input = { tenantId: otherTenantId, userId: otherUserId, digest: digest(60), addressId: "66666666-6666-4666-8666-666666666666", encryptedAddress: encrypted(60), tokenHash: "6".repeat(64), expiresAt: new Date(+now - 60_000), now: new Date(+now - 24 * 60 * 60_000) };
    await breachMonitoring.requestVerification(t.db, input);
    const before = await tenantScoped(t.db, otherTenantId).first(monitoredAddresses, and(eq(monitoredAddresses.id, input.addressId), eq(monitoredAddresses.userId, otherUserId)));
    expect(before).toMatchObject({ verificationTokenHash: input.tokenHash, verificationExpiresAt: input.expiresAt });
    const purged = await breachMonitoring.purgeExpiredVerificationTokens(t.db);
    const after = await tenantScoped(t.db, otherTenantId).first(monitoredAddresses, and(eq(monitoredAddresses.id, input.addressId), eq(monitoredAddresses.userId, otherUserId)));
    expect(purged).toBeGreaterThanOrEqual(1);
    expect({ tokenHash: after?.verificationTokenHash, expiresAt: after?.verificationExpiresAt }).toEqual({ tokenHash: null, expiresAt: null });
    expect(after).toMatchObject({ encryptedAddress: encrypted(60) });
  });

  it("does not remove the verified sign-in address through the extra-address delete API", async () => {
    const id = "77777777-7777-4777-8777-777777777777";
    await breachMonitoring.addVerifiedAddress(t.db, { tenantId: otherTenantId, userId: otherUserId, addressId: id, digest: digest(70), encryptedAddress: encrypted(70), verifiedAt: at(5), now: at(5) });
    expect(await breachMonitoring.removeAddress(t.db, { tenantId: otherTenantId, userId: otherUserId, addressId: id })).toBe(false);
    expect(await breachMonitoring.getAddressForCheck(t.db, { tenantId: otherTenantId, userId: otherUserId, addressId: id })).toBeDefined();
  });

  it("does not let app_user expire an unexpired token by supplying a future cutoff", async () => {
    const now = new Date();
    const id = "99999999-9999-4999-8999-999999999999";
    const tokenHash = "7".repeat(64);
    await breachMonitoring.requestVerification(t.db, {
      tenantId: otherTenantId, userId: otherUserId, addressId: id, digest: digest(72), encryptedAddress: encrypted(72),
      tokenHash, expiresAt: new Date(+now + 60 * 60_000), now,
    });
    await expect(t.client.query("SELECT public.purge_expired_breach_verification_tokens($1::timestamptz)", [new Date(+now + 2 * 60 * 60_000)])).rejects.toThrow();
    const row = await tenantScoped(t.db, otherTenantId).first(monitoredAddresses, and(eq(monitoredAddresses.id, id), eq(monitoredAddresses.userId, otherUserId)));
    expect(row?.verificationTokenHash).toBe(tokenHash);
  });

  it("purges expired token hashes in bounded batches", async () => {
    await tenantScoped(t.db, otherTenantId).transaction(({ tx }) => tx.execute(sql`
      INSERT INTO public.monitored_addresses (tenant_id, user_id, digest, encrypted_address, verification_source, verification_token_hash, verification_expires_at)
      SELECT ${otherTenantId}::uuid, ${otherUserId}, repeat('a', 56) || lpad(to_hex(n), 8, '0'), decode('deadbeef', 'hex'), 'extra', repeat('b', 56) || lpad(to_hex(n), 8, '0'), clock_timestamp() - interval '1 minute'
      FROM generate_series(1, 1001) AS n
    `));
    expect(await breachMonitoring.purgeExpiredVerificationTokens(t.db)).toBe(1000);
    const remainingFirstBatch = (await tenantScoped(t.db, otherTenantId).select(monitoredAddresses, and(eq(monitoredAddresses.userId, otherUserId), isNotNull(monitoredAddresses.verificationTokenHash)))).filter((row) => row.digest.startsWith("a".repeat(56)));
    expect(remainingFirstBatch).toHaveLength(1);
    expect(await breachMonitoring.purgeExpiredVerificationTokens(t.db)).toBe(1);
    const remainingAfterSecondBatch = (await tenantScoped(t.db, otherTenantId).select(monitoredAddresses, and(eq(monitoredAddresses.userId, otherUserId), isNotNull(monitoredAddresses.verificationTokenHash)))).filter((row) => row.digest.startsWith("a".repeat(56)));
    expect(remainingAfterSecondBatch).toEqual([]);
    await breachMonitoring.deleteUserAddresses(t.db, otherTenantId, otherUserId);
  });

  it("serializes concurrent sends for the same tenant digest across members", async () => {
    await breachMonitoring.deleteUserAddresses(t.db, tenantId, userId);
    await breachMonitoring.deleteUserAddresses(t.db, tenantId, secondMemberUserId);
    const now = new Date();
    const digestValue = digest(86);
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => {
      const userIdForAttempt = index % 2 ? secondMemberUserId : userId;
      const idSuffix = String(index + 1).padStart(12, "0");
      return breachMonitoring.requestVerification(t.db, {
        tenantId,
        userId: userIdForAttempt,
        addressId: `86868686-8686-4686-8686-${idSuffix}`,
        digest: digestValue,
        encryptedAddress: encrypted(86),
        tokenHash: (index + 101).toString(16).padStart(64, "0"),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
        now,
      });
    }));
    const statusCounts = results.reduce<Record<string, number>>((counts, result) => ({ ...counts, [result.status]: (counts[result.status] ?? 0) + 1 }), {});
    expect(statusCounts).toEqual({ reserved: 3, rate_limited: 7 });
    await breachMonitoring.deleteUserAddresses(t.db, tenantId, userId);
    await breachMonitoring.deleteUserAddresses(t.db, tenantId, secondMemberUserId);
  });

  it("enforces the exact rolling 24-hour limit across the boundary", async () => {
    const addressId = "84848484-8484-4484-8484-848484848484";
    const digestValue = digest(84);
    const start = new Date();
    const day = 24 * 60 * 60_000;
    const sendAt = (minute: number, tokenLetter: string) => {
      const now = new Date(start.getTime() + minute * 60_000);
      return breachMonitoring.requestVerification(t.db, {
        tenantId,
        userId: secondMemberUserId,
        addressId,
        digest: digestValue,
        encryptedAddress: encrypted(84),
        tokenHash: tokenLetter.repeat(64),
        expiresAt: new Date(now.getTime() + day),
        now,
      });
    };
    expect((await sendAt(0, "a")).status).toBe("reserved");
    expect((await sendAt(1439, "b")).status).toBe("reserved");
    expect((await sendAt(1441, "c")).status).toBe("reserved");
    expect((await sendAt(1442, "d")).status).toBe("reserved");
    expect((await sendAt(1443, "e")).status).toBe("rate_limited");
    await breachMonitoring.deleteUserAddresses(t.db, tenantId, secondMemberUserId);
  });
});
