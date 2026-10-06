import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryBreachAddressStore } from "@/lib/server/breach-monitoring/store";
import { acceptInvite, createInvite, removeMember, leave } from "@/lib/server/household";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { resetMemoryState, stubBaseEnv } from "./helpers/routes";

const ids = vi.hoisted(() => ({ tenantId: "11111111-1111-4111-8111-111111111111", ownerId: "owner-1", memberId: "member-1" }));
vi.mock("@/lib/server/alerts", () => ({ alertMemberJoined: vi.fn(), alertMemberLeft: vi.fn() }));

const now = new Date("2026-10-05T10:00:00Z");
async function addr(userId: string, n: number, verified: boolean) {
  const store = createMemoryBreachAddressStore();
  const request = await store.requestVerification({
    tenantId: ids.tenantId, userId, addressId: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`,
    digest: String(n).padStart(64, "0"), encryptedAddress: new Uint8Array([n]), verificationTokenHash: String(n).repeat(64),
    verificationExpiresAt: new Date(+now + 86_400_000), now,
  });
  return verified && request.address ? store.verifyAddress({ tenantId: ids.tenantId, userId, verificationTokenHash: String(n).repeat(64), verifiedAt: now }) : request.address;
}

beforeEach(() => { stubBaseEnv(vi); resetMemoryState(); });
afterEach(() => vi.unstubAllEnvs());

describe("household breach-address cleanup", () => {
  it("deletes pending and verified address material when an owner removes a member", async () => {
    setMemoryMembers(ids.tenantId, [
      { userId: ids.ownerId, role: "owner", name: "Owner", email: null },
      { userId: ids.memberId, role: "member", name: "Member", email: null },
    ]);
    await addr(ids.memberId, 1, false);
    await addr(ids.memberId, 2, true);
    const result = await removeMember({ tenantId: ids.tenantId, userId: ids.ownerId, role: "owner", email: "", name: "Owner", scopes: ["full" as const] }, ids.memberId, "http://localhost:3000");
    expect(result.ok).toBe(true);
    expect(await createMemoryBreachAddressStore().listAddresses(ids.tenantId, ids.memberId)).toEqual([]);
  });

  it("deletes addresses when a member leaves", async () => {
    setMemoryMembers(ids.tenantId, [
      { userId: ids.ownerId, role: "owner", name: "Owner", email: null },
      { userId: ids.memberId, role: "member", name: "Member", email: null },
    ]);
    await addr(ids.memberId, 3, false);
    const result = await leave({ tenantId: ids.tenantId, userId: ids.memberId, role: "member", email: "", name: "Member", scopes: ["full" as const] });
    expect(result.ok).toBe(true);
    expect(await createMemoryBreachAddressStore().listAddresses(ids.tenantId, ids.memberId)).toEqual([]);
  });

  it("deletes old-household addresses when a member accepts an invite elsewhere", async () => {
    const nextTenant = "44444444-4444-4444-8444-444444444444";
    const oldOwner = { tenantId: ids.tenantId, userId: ids.memberId, role: "owner" as const, email: "member@example.test", name: "Member", scopes: ["full" as const] };
    const nextOwner = { tenantId: nextTenant, userId: "owner-next", role: "owner" as const, email: "owner@example.test", name: "Owner", scopes: ["full" as const] };
    setMemoryMembers(ids.tenantId, [{ userId: ids.memberId, role: "owner", name: "Member", email: "member@example.test" }]);
    setMemoryMembers(nextTenant, [{ userId: nextOwner.userId, role: "owner", name: "Owner", email: "owner@example.test" }]);
    await addr(ids.memberId, 4, true);
    const invite = await createInvite(nextOwner, { kind: "link" }, "http://localhost:3000");
    expect(invite.ok).toBe(true);
    if (!invite.ok) return;
    const secret = new URL(invite.value.url).pathname.split("/").at(-1)!;
    expect((await acceptInvite(oldOwner, secret, true)).ok).toBe(true);
    expect(await createMemoryBreachAddressStore().listAddresses(ids.tenantId, ids.memberId)).toEqual([]);
  });
});
