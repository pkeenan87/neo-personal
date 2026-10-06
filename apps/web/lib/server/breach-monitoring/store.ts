import type { AddressRow, RequestVerificationResult } from "@neo/db";
import { memoryState } from "../memory-state";
import type { BreachAddressStore } from "./address-service";

type AddVerifiedInput = Parameters<BreachAddressStore["addVerifiedAddress"]>[0];
type RequestInput = Parameters<BreachAddressStore["requestVerification"]>[0];
type VerifyInput = Parameters<BreachAddressStore["verifyAddress"]>[0];
type MemoryAddress = Omit<AddressRow, "verificationTokenHash" | "verificationExpiresAt" | "verifiedAt" | "lastCheckedAt" | "lastSuccessfulCheckAt"> & {
  verificationTokenHash: string | null;
  verificationExpiresAt: Date | null;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  lastSuccessfulCheckAt: Date | null;
  verificationSendTimes: Date[];
};
const SEND_WINDOW_MS = 24 * 60 * 60_000;
const MAX_EXTRA_ADDRESSES = 5;
const MAX_VERIFICATION_SENDS = 3;

function rows(): Map<string, MemoryAddress> {
  return memoryState().breachAddresses as Map<string, MemoryAddress>;
}
function key(row: Pick<MemoryAddress, "tenantId" | "userId" | "digest">): string {
  return JSON.stringify([row.tenantId, row.userId, row.digest]);
}
function clone(row: MemoryAddress): AddressRow {
  const { verificationSendTimes: _sendTimes, ...address } = row;
  return {
    ...structuredClone(address),
    verificationTokenHash: row.verificationTokenHash ?? undefined,
    verificationExpiresAt: row.verificationExpiresAt ?? undefined,
    verifiedAt: row.verifiedAt ?? undefined,
    lastCheckedAt: row.lastCheckedAt ?? undefined,
    lastSuccessfulCheckAt: row.lastSuccessfulCheckAt ?? undefined,
  };
}

export function createMemoryBreachAddressStore(): BreachAddressStore {
  return {
    async listAddresses(tenantId, userId) {
      return [...rows().values()]
        .filter((row) => row.tenantId === tenantId && row.userId === userId)
        .sort((a, b) => +a.createdAt - +b.createdAt)
        .map(clone);
    },
    async addVerifiedAddress(input: AddVerifiedInput) {
      const addressKey = key(input);
      for (const [id, row] of rows()) {
        if (row.tenantId === input.tenantId && row.userId === input.userId && row.verificationSource === "sign_in" && row.digest !== input.digest) rows().delete(id);
      }
      const existing = [...rows().values()].find((row) => key(row) === addressKey);
      if (existing) {
        Object.assign(existing, {
          verificationSource: "sign_in", encryptedAddress: new Uint8Array(input.encryptedAddress), verifiedAt: input.verifiedAt,
          verificationTokenHash: null, verificationExpiresAt: null, updatedAt: input.now, verificationPending: false,
        });
        return clone(existing);
      }
      const row: MemoryAddress = {
        id: input.addressId, tenantId: input.tenantId, userId: input.userId, digest: input.digest,
        encryptedAddress: new Uint8Array(input.encryptedAddress), verificationSource: "sign_in", verifiedAt: input.verifiedAt,
        verificationTokenHash: null, verificationExpiresAt: null, verificationPending: false,
        checkStatus: "never_checked", lastCheckedAt: null, lastSuccessfulCheckAt: null,
        createdAt: input.now, updatedAt: input.now, verificationSendTimes: [],
      };
      rows().set(row.id, row);
      return clone(row);
    },
    async requestVerification(input: RequestInput): Promise<RequestVerificationResult> {
      const digestRows = [...rows().values()].filter((row) => row.tenantId === input.tenantId && row.digest === input.digest);
      let existing = digestRows.find((row) => row.userId === input.userId);
      if (existing?.verifiedAt) return { status: "already_verified", address: clone(existing) };
      if (!existing) {
        const extraCount = [...rows().values()].filter((row) => row.tenantId === input.tenantId && row.userId === input.userId && row.verificationSource === "extra").length;
        if (extraCount >= MAX_EXTRA_ADDRESSES) return { status: "address_limit" };
      }
      const previousTimes = digestRows.reduce<Date[]>((longest, row) => row.verificationSendTimes.length > longest.length ? row.verificationSendTimes : longest, []);
      const recentSendTimes = previousTimes.filter((time) => input.now.getTime() - time.getTime() < SEND_WINDOW_MS).sort((a, b) => +a - +b);
      if (recentSendTimes.length >= MAX_VERIFICATION_SENDS) return { status: "rate_limited", ...(existing ? { address: clone(existing) } : {}) };
      const nextSendTimes = [...recentSendTimes, input.now];
      if (!existing) {
        existing = {
          id: input.addressId, tenantId: input.tenantId, userId: input.userId, digest: input.digest,
          encryptedAddress: new Uint8Array(input.encryptedAddress), verificationSource: "extra", verifiedAt: null,
          verificationTokenHash: input.verificationTokenHash, verificationExpiresAt: input.verificationExpiresAt, verificationPending: true,
          checkStatus: "never_checked", lastCheckedAt: null, lastSuccessfulCheckAt: null,
          createdAt: input.now, updatedAt: input.now, verificationSendTimes: [...nextSendTimes],
        };
        rows().set(existing.id, existing);
      } else {
        existing.verificationTokenHash = input.verificationTokenHash;
        existing.verificationExpiresAt = input.verificationExpiresAt;
        existing.updatedAt = input.now;
      }
      for (const row of digestRows) {
        row.verificationSendTimes = [...nextSendTimes];
        row.updatedAt = input.now;
      }
      return { status: "reserved", address: clone(existing) };
    },
    async verifyAddress(input: VerifyInput) {
      const row = [...rows().values()].find((item) => item.tenantId === input.tenantId && item.userId === input.userId && item.verificationSource === "extra" && !item.verifiedAt && item.verificationTokenHash === input.verificationTokenHash && item.verificationExpiresAt && +item.verificationExpiresAt > +input.verifiedAt);
      if (!row) return undefined;
      row.verifiedAt = input.verifiedAt;
      row.verificationPending = false;
      row.verificationTokenHash = null;
      row.verificationExpiresAt = null;
      row.updatedAt = input.verifiedAt;
      return clone(row);
    },
    async removeAddress(tenantId, userId, addressId) {
      const row = rows().get(addressId);
      if (!row || row.tenantId !== tenantId || row.userId !== userId || row.verificationSource !== "extra") return false;
      return rows().delete(addressId);
    },
    async deleteUserAddresses(tenantId, userId) {
      let removed = 0;
      for (const [id, row] of rows()) if (row.tenantId === tenantId && row.userId === userId) { rows().delete(id); removed++; }
      return removed;
    },
  };
}
