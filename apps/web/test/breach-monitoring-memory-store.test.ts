import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryBreachAddressStore } from "@/lib/server/breach-monitoring/store";
import { resetMemoryState } from "@/lib/server/memory-state";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const at = (day: number, hour = 0) => new Date(Date.UTC(2026, 9, day, hour));
const input = (n: number, now = at(1)) => ({ tenantId: TENANT, userId: USER, addressId: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`, digest: String(n).padStart(64, "0"), encryptedAddress: new Uint8Array([n]), verificationTokenHash: String(n).repeat(64), verificationExpiresAt: new Date(+now + 24 * 60 * 60_000), now });

beforeEach(() => resetMemoryState());

describe("in-memory breach address store", () => {
  it("keeps reserved addresses across store instances and caps each address at three sends per 24 hours", async () => {
    const first = createMemoryBreachAddressStore();
    expect((await first.requestVerification(input(1))).status).toBe("reserved");
    const second = createMemoryBreachAddressStore();
    const secondMember = await second.requestVerification({ ...input(1, at(1, 1)), userId: "other-user", addressId: "77777777-7777-4777-8777-777777777777", verificationTokenHash: "8".repeat(64) });
    expect(secondMember.status).toBe("reserved");
    expect((await second.requestVerification(input(1, at(1, 2)))).status).toBe("reserved");
    expect((await second.requestVerification(input(1, at(1, 3)))).status).toBe("rate_limited");
    expect((await second.requestVerification({ ...input(1, at(1, 4)), userId: "other-user", addressId: "77777777-7777-4777-8777-777777777777", verificationTokenHash: "9".repeat(64) })).status).toBe("rate_limited");
    expect((await second.requestVerification(input(1, at(2, 1)))).status).toBe("reserved");
  });

  it("limits five extra addresses per user but allows the same digest in another household", async () => {
    const store = createMemoryBreachAddressStore();
    for (let n = 1; n <= 5; n++) expect((await store.requestVerification(input(n))).status).toBe("reserved");
    expect((await store.requestVerification(input(6))).status).toBe("address_limit");
    expect(await store.listAddresses(TENANT, "other-user")).toEqual([]);
    expect((await store.requestVerification({ ...input(1), tenantId: "44444444-4444-4444-8444-444444444444", userId: "other-user" })).status).toBe("reserved");
  });

  it("enforces an exact sliding 24-hour send window", async () => {
    const store = createMemoryBreachAddressStore();
    const base = new Date("2026-10-01T00:00:00.000Z");
    const sendAt = (minute: number, token: string) => {
      const now = new Date(base.getTime() + minute * 60_000);
      return store.requestVerification({ ...input(88, now), verificationTokenHash: token.repeat(64), verificationExpiresAt: new Date(now.getTime() + 24 * 60 * 60_000) });
    };
    expect((await sendAt(0, "a")).status).toBe("reserved");
    expect((await sendAt(1439, "b")).status).toBe("reserved");
    expect((await sendAt(1441, "c")).status).toBe("reserved");
    expect((await sendAt(1442, "d")).status).toBe("reserved");
    expect((await sendAt(1443, "e")).status).toBe("rate_limited");
  });

  it("consumes a confirmation once, and scopes it to tenant and user", async () => {
    const store = createMemoryBreachAddressStore();
    const request = input(7);
    const reserved = await store.requestVerification(request);
    expect(reserved.address).toBeDefined();
    expect(await store.verifyAddress({ tenantId: TENANT, userId: "other-user", verificationTokenHash: request.verificationTokenHash, verifiedAt: at(1, 1) })).toBeUndefined();
    expect(await store.verifyAddress({ tenantId: TENANT, userId: USER, verificationTokenHash: request.verificationTokenHash, verifiedAt: at(1, 1) })).toMatchObject({ id: request.addressId, verificationPending: false });
    expect(await store.verifyAddress({ tenantId: TENANT, userId: USER, verificationTokenHash: request.verificationTokenHash, verifiedAt: at(1, 1) })).toBeUndefined();
  });

  it("does not remove the automatically monitored sign-in address", async () => {
    const store = createMemoryBreachAddressStore();
    const address = await store.addVerifiedAddress({ tenantId: TENANT, userId: USER, addressId: "33333333-3333-4333-8333-000000000008", digest: String(8).padStart(64, "0"), encryptedAddress: new Uint8Array([8]), verifiedAt: at(1), now: at(1) });
    expect(await store.removeAddress(TENANT, USER, address.id)).toBe(false);
    expect(await store.listAddresses(TENANT, USER)).toContainEqual(expect.objectContaining({ id: address.id, verificationSource: "sign_in" }));
  });
});
