import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressRow, RequestVerificationResult } from "@neo/db";
import {
  createBreachAddressService,
  type BreachAddressStore,
} from "@/lib/server/breach-monitoring/address-service";
import {
  decryptMonitoredAddress,
  deriveMonitoredAddressDigest,
  hashVerificationToken,
} from "@/lib/server/breach-monitoring/crypto";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-05T12:00:00.000Z");
const MASTER = Buffer.alloc(32, 7).toString("base64");

function row(overrides: Partial<AddressRow> = {}): AddressRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    tenantId: TENANT,
    userId: USER,
    digest: "a".repeat(64),
    encryptedAddress: new Uint8Array([1, 2, 3]),
    verificationSource: "extra",
    verifiedAt: undefined,
    verificationTokenHash: undefined,
    verificationExpiresAt: undefined,
    createdAt: NOW,
    updatedAt: NOW,
    lastCheckedAt: undefined,
    lastSuccessfulCheckAt: undefined,
    checkStatus: "never_checked",
    verificationPending: true,
    ...overrides,
  };
}

function harness(opts: {
  master?: string;
  deployed?: boolean;
  resolved?: { email: string; emailVerified: Date | null };
  requestStatus?: RequestVerificationResult["status"];
} = {}) {
  const rows: AddressRow[] = [];
  const requests: unknown[] = [];
  const confirmations: unknown[] = [];
  const mail: unknown[] = [];
  const store: BreachAddressStore = {
    listAddresses: vi.fn(async () => rows),
    addVerifiedAddress: vi.fn(async (input) => {
      const result = row({
        id: input.addressId,
        digest: input.digest,
        encryptedAddress: input.encryptedAddress,
        verificationSource: "sign_in",
        verifiedAt: input.verifiedAt,
        verificationPending: false,
      });
      rows.push(result);
      return result;
    }),
    requestVerification: vi.fn(async (input) => {
      requests.push(input);
      const status = opts.requestStatus ?? "reserved";
      if (status !== "reserved") return { status } as RequestVerificationResult;
      const result = row({
        id: input.addressId,
        digest: input.digest,
        encryptedAddress: input.encryptedAddress,
        verificationTokenHash: input.verificationTokenHash,
        verificationExpiresAt: input.verificationExpiresAt,
      });
      rows.push(result);
      return { status, address: result } as RequestVerificationResult;
    }),
    verifyAddress: vi.fn(async (input) => {
      confirmations.push(input);
      const result = rows.find((candidate) => candidate.verificationTokenHash === input.verificationTokenHash);
      if (!result || !result.verificationExpiresAt || result.verificationExpiresAt <= input.verifiedAt) return undefined;
      const verified = { ...result, verifiedAt: input.verifiedAt, verificationTokenHash: undefined, verificationExpiresAt: undefined, verificationPending: false };
      rows[rows.indexOf(result)] = verified;
      return verified;
    }),
    removeAddress: vi.fn(async (_tenantId, _userId, addressId) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]?.id === addressId) rows.splice(i, 1);
      return rows.length !== before;
    }),
    deleteUserAddresses: vi.fn(async () => 0),
  };
  const service = createBreachAddressService({
    store,
    source: { NEO_MASTER_KEY: opts.master ?? MASTER, ...(opts.deployed ? { VERCEL_ENV: "production" } : {}) },
    baseUrl: "https://neo.example.test",
    now: () => new Date(NOW),
    resolveVerifiedSignin: vi.fn(async () => opts.resolved),
    sendVerificationEmail: vi.fn(async (message) => { mail.push(message); }),
  });
  return { service, store, rows, requests, confirmations, mail };
}

afterEach(() => vi.restoreAllMocks());

describe("breach address lifecycle service", () => {
  it("does not create a sign-in address until the auth user is verified", async () => {
    const pending = harness({ resolved: { email: "Primary@Example.com", emailVerified: null } });
    await pending.service.listAddresses({ tenantId: TENANT, userId: USER });
    expect(pending.store.addVerifiedAddress).not.toHaveBeenCalled();

    const verifiedAt = new Date("2026-10-01T00:00:00.000Z");
    const verified = harness({ resolved: { email: "Primary@Example.com", emailVerified: verifiedAt } });
    const addresses = await verified.service.listAddresses({ tenantId: TENANT, userId: USER });
    expect(verified.store.addVerifiedAddress).toHaveBeenCalledOnce();
    const input = vi.mocked(verified.store.addVerifiedAddress).mock.calls[0]?.[0];
    expect(input?.digest).toBe(await deriveMonitoredAddressDigest(TENANT, "primary@example.com", { NEO_MASTER_KEY: MASTER }));
    expect(Buffer.from(input!.encryptedAddress).includes(Buffer.from("primary@example.com"))).toBe(false);
    expect(decryptMonitoredAddress(input!.encryptedAddress, { tenantId: TENANT, userId: USER, addressId: input!.addressId }, { NEO_MASTER_KEY: MASTER })).toBe("primary@example.com");
    expect(addresses).toContainEqual(expect.objectContaining({ email: "primary@example.com", source: "sign_in" }));
  });

  it("stores only ciphertext and a hash before sending the extra-address confirmation", async () => {
    const h = harness();
    expect(await h.service.requestExtraAddress({ tenantId: TENANT, userId: USER, email: "  Extra@Example.com  " })).toEqual({ status: "reserved" });
    expect(h.requests).toHaveLength(1);
    expect(h.mail).toHaveLength(1);
    const input = h.requests[0] as { digest: string; encryptedAddress: Uint8Array; verificationTokenHash: string; verificationExpiresAt: Date };
    expect(input.digest).toBe(await deriveMonitoredAddressDigest(TENANT, "extra@example.com", { NEO_MASTER_KEY: MASTER }));
    expect(Buffer.from(input.encryptedAddress).includes(Buffer.from("extra@example.com"))).toBe(false);
    expect(input.verificationTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(input.verificationExpiresAt.getTime() - NOW.getTime()).toBe(24 * 60 * 60 * 1000);
    const sent = h.mail[0] as { to: string; verificationUrl: string; idempotencyKey: string };
    expect(sent.to).toBe("extra@example.com");
    expect(sent.verificationUrl).toMatch(/^https:\/\/neo\.example\.test\/settings\/breaches\/verify\?token=[A-Za-z0-9_-]{43}$/);
    const token = new URL(sent.verificationUrl).searchParams.get("token")!;
    expect(input.verificationTokenHash).toBe(await hashVerificationToken(token));
    expect(sent.idempotencyKey).not.toContain("extra@example.com");
  });

  it.each(["rate_limited", "address_limit", "already_verified"] as const)("does not send email when the store returns %s", async (status) => {
    const h = harness({ requestStatus: status });
    expect(await h.service.requestExtraAddress({ tenantId: TENANT, userId: USER, email: "extra@example.com" })).toEqual({ status });
    expect(h.mail).toHaveLength(0);
  });

  it("fails closed without the master key before storing or sending an address", async () => {
    const h = harness({ master: "", deployed: true });
    await expect(h.service.requestExtraAddress({ tenantId: TENANT, userId: USER, email: "extra@example.com" })).resolves.toEqual({ status: "unconfigured" });
    expect(h.store.requestVerification).not.toHaveBeenCalled();
    expect(h.mail).toHaveLength(0);
  });

  it("lists the good addresses when one row has a bad ciphertext, without logging the address", async () => {
    const h = harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await h.service.requestExtraAddress({ tenantId: TENANT, userId: USER, email: "good@example.com" });
    h.rows.push(row({ id: "44444444-4444-4444-8444-444444444444", encryptedAddress: new Uint8Array([9, 9, 9]) }));
    const list = await h.service.listAddresses({ tenantId: TENANT, userId: USER });
    expect(list.map((address) => address.email)).toEqual(["good@example.com"]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("good@example.com");
  });

  it("hashes a confirmation token and scopes it to the authenticated tenant and user", async () => {
    const h = harness();
    await h.service.requestExtraAddress({ tenantId: TENANT, userId: USER, email: "extra@example.com" });
    const email = h.mail[0] as { verificationUrl: string };
    const token = new URL(email.verificationUrl).searchParams.get("token")!;
    await expect(h.service.confirmAddress({ tenantId: TENANT, userId: USER, token })).resolves.toEqual({ verified: true });
    expect(h.confirmations).toEqual([{ tenantId: TENANT, userId: USER, verificationTokenHash: await hashVerificationToken(token), verifiedAt: NOW }]);
    await expect(h.service.confirmAddress({ tenantId: TENANT, userId: USER, token })).resolves.toEqual({ verified: false });
  });
});
