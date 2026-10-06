import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db, Tx } from "./client.js";
import { breachObservations, monitoredAddresses, type BreachCheckStatus, type BreachObservation, type MonitoredAddress } from "./schema/index.js";
import { tenantScoped } from "./tenant.js";

const MAX_EXTRA_ADDRESSES = 5;
const SEND_LIMIT = 3;
const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export type AddressRow = Omit<MonitoredAddress, "verificationSendTimes" | "verificationTokenHash" | "verificationExpiresAt" | "verifiedAt" | "lastCheckedAt" | "lastSuccessfulCheckAt"> & {
  verificationTokenHash?: string;
  verificationExpiresAt?: Date;
  verifiedAt?: Date;
  lastCheckedAt?: Date;
  lastSuccessfulCheckAt?: Date;
  verificationPending: boolean;
};
export type ObservationRow = Omit<BreachObservation, "breachDomain" | "breachDate" | "addedDate" | "retiredAt"> & {
  domain?: string;
  breachDate?: Date;
  addedDate?: Date;
  retiredAt?: Date;
};
export type CheckStatus = BreachCheckStatus;

export type RequestVerificationResult = {
  status: "reserved" | "already_verified" | "rate_limited" | "address_limit";
  address?: AddressRow;
};

export type BreachObservationInput = {
  breachName: string;
  domain?: string;
  breachDate?: Date;
  addedDate?: Date;
  dataClasses: string[];
  retiredAt?: Date;
};

function addressResult(row: MonitoredAddress): AddressRow {
  const { verificationSendTimes: _sendTimes, ...safe } = row;
  return {
    ...safe,
    encryptedAddress: new Uint8Array(row.encryptedAddress),
    verificationTokenHash: row.verificationTokenHash ?? undefined,
    verificationExpiresAt: row.verificationExpiresAt ?? undefined,
    verifiedAt: row.verifiedAt ?? undefined,
    lastCheckedAt: row.lastCheckedAt ?? undefined,
    lastSuccessfulCheckAt: row.lastSuccessfulCheckAt ?? undefined,
    verificationPending: row.verifiedAt === null,
  };
}

function observationResult(row: BreachObservation): ObservationRow {
  const { breachDomain, ...safe } = row;
  return {
    ...safe,
    domain: breachDomain ?? undefined,
    breachDate: row.breachDate ?? undefined,
    addedDate: row.addedDate ?? undefined,
    retiredAt: row.retiredAt ?? undefined,
  };
}

function lockKey(tenantId: string, userId: string): string {
  return `breach-addresses:${tenantId}:${userId}`;
}

async function lockUser(tx: Tx, tenantId: string, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(tenantId, userId)}, 0))`);
}

async function lockVerificationDigest(tx: Tx, tenantId: string, digest: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`breach-verification:${tenantId}:${digest}`}, 0))`);
}

export const breachMonitoring = {
  async addVerifiedAddress(db: Db, input: {
    tenantId: string;
    userId: string;
    addressId: string;
    digest: string;
    encryptedAddress: Uint8Array;
    verifiedAt: Date;
    now: Date;
  }): Promise<AddressRow> {
    return tenantScoped(db, input.tenantId).transaction(async (t) => {
      await lockUser(t.tx, input.tenantId, input.userId);
      await t.delete(monitoredAddresses, and(
        eq(monitoredAddresses.userId, input.userId),
        eq(monitoredAddresses.verificationSource, "sign_in"),
        ne(monitoredAddresses.digest, input.digest),
      ));
      const existing = await t.first(monitoredAddresses, and(
        eq(monitoredAddresses.userId, input.userId),
        eq(monitoredAddresses.digest, input.digest),
      ));
      if (existing) {
        const [updated] = await t.update(monitoredAddresses, {
          verificationSource: "sign_in",
          encryptedAddress: input.encryptedAddress,
          verifiedAt: input.verifiedAt,
          verificationTokenHash: null,
          verificationExpiresAt: null,
          updatedAt: input.now,
        }, eq(monitoredAddresses.id, existing.id));
        if (!updated) throw new Error("Failed to update verified sign-in address");
        return addressResult(updated);
      }
      const [created] = await t.insert(monitoredAddresses, {
        id: input.addressId,
        userId: input.userId,
        digest: input.digest,
        encryptedAddress: input.encryptedAddress,
        verificationSource: "sign_in",
        verifiedAt: input.verifiedAt,
        checkStatus: "never_checked",
        verificationSendTimes: [],
        createdAt: input.now,
        updatedAt: input.now,
      });
      if (!created) throw new Error("Failed to create verified sign-in address");
      return addressResult(created);
    });
  },

  async requestVerification(db: Db, input: {
    tenantId: string;
    userId: string;
    addressId: string;
    digest: string;
    encryptedAddress: Uint8Array;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<RequestVerificationResult> {
    return tenantScoped(db, input.tenantId).transaction(async (t) => {
      await lockUser(t.tx, input.tenantId, input.userId);
      await lockVerificationDigest(t.tx, input.tenantId, input.digest);
      const digestRows = await t.select(monitoredAddresses, eq(monitoredAddresses.digest, input.digest));
      const existing = digestRows.find((row) => row.userId === input.userId);
      if (existing?.verifiedAt) return { status: "already_verified", address: addressResult(existing) };
      if (existing?.verificationSource === "sign_in") {
        throw new Error("Unverified sign-in address violates the monitored-address invariant");
      }
      if (!existing) {
        const extraCount = await t.count(monitoredAddresses, and(
          eq(monitoredAddresses.userId, input.userId),
          eq(monitoredAddresses.verificationSource, "extra"),
        ));
        if (extraCount >= MAX_EXTRA_ADDRESSES) return { status: "address_limit" };
      }

      const priorTimes = digestRows.reduce<Date[]>((longest, row) => row.verificationSendTimes.length > longest.length ? row.verificationSendTimes : longest, []);
      const recentSendTimes = priorTimes.filter((time) => input.now.getTime() - time.getTime() < SEND_WINDOW_MS).sort((a, b) => +a - +b);
      if (recentSendTimes.length >= SEND_LIMIT) return { status: "rate_limited", ...(existing ? { address: addressResult(existing) } : {}) };
      const nextSendTimes = [...recentSendTimes, input.now];

      if (!existing) {
        const [created] = await t.insert(monitoredAddresses, {
          id: input.addressId,
          userId: input.userId,
          digest: input.digest,
          encryptedAddress: input.encryptedAddress,
          verificationSource: "extra",
          verificationTokenHash: input.tokenHash,
          verificationExpiresAt: input.expiresAt,
          checkStatus: "never_checked",
          verificationSendTimes: nextSendTimes,
                    createdAt: input.now,
          updatedAt: input.now,
        });
        if (!created) throw new Error("Failed to reserve verification send");
        if (digestRows.length) await t.update(monitoredAddresses, {
          verificationSendTimes: nextSendTimes,
                    updatedAt: input.now,
        }, eq(monitoredAddresses.digest, input.digest));
        return { status: "reserved", address: addressResult(created) };
      }

      const [updated] = await t.update(monitoredAddresses, {
        verificationTokenHash: input.tokenHash,
        verificationExpiresAt: input.expiresAt,
        verificationSendTimes: nextSendTimes,
                updatedAt: input.now,
      }, and(eq(monitoredAddresses.id, existing.id), isNull(monitoredAddresses.verifiedAt)));
      if (!updated) {
        const current = await t.first(monitoredAddresses, and(eq(monitoredAddresses.id, existing.id), eq(monitoredAddresses.userId, input.userId)));
        return current?.verifiedAt
          ? { status: "already_verified", address: addressResult(current) }
          : { status: "rate_limited", address: current ? addressResult(current) : undefined };
      }
      if (digestRows.some((row) => row.userId !== input.userId)) await t.update(monitoredAddresses, {
        verificationSendTimes: nextSendTimes,
                updatedAt: input.now,
      }, and(eq(monitoredAddresses.digest, input.digest), ne(monitoredAddresses.userId, input.userId)));
      return { status: "reserved", address: addressResult(updated) };
    });
  },

  async verifyAddress(db: Db, input: { tenantId: string; userId: string; tokenHash: string; verifiedAt: Date }): Promise<AddressRow | undefined> {
    const [row] = await tenantScoped(db, input.tenantId).update(monitoredAddresses, {
      verifiedAt: input.verifiedAt,
      verificationTokenHash: null,
      verificationExpiresAt: null,
      updatedAt: input.verifiedAt,
    }, and(
      eq(monitoredAddresses.userId, input.userId),
      eq(monitoredAddresses.verificationSource, "extra"),
      eq(monitoredAddresses.verificationTokenHash, input.tokenHash),
      isNull(monitoredAddresses.verifiedAt),
      gt(monitoredAddresses.verificationExpiresAt, input.verifiedAt),
    ));
    return row ? addressResult(row) : undefined;
  },

  async listAddresses(db: Db, tenantId: string, userId: string): Promise<AddressRow[]> {
    const rows = await tenantScoped(db, tenantId).select(monitoredAddresses, eq(monitoredAddresses.userId, userId), {
      orderBy: [asc(monitoredAddresses.createdAt)],
    });
    return rows.map(addressResult);
  },

  async getAddressForCheck(db: Db, input: { tenantId: string; userId: string; addressId: string }): Promise<AddressRow | undefined> {
    const row = await tenantScoped(db, input.tenantId).first(monitoredAddresses, and(
      eq(monitoredAddresses.id, input.addressId),
      eq(monitoredAddresses.userId, input.userId),
      isNotNull(monitoredAddresses.verifiedAt),
    ));
    return row ? addressResult(row) : undefined;
  },

  async removeAddress(db: Db, input: { tenantId: string; userId: string; addressId: string }): Promise<boolean> {
    const rows = await tenantScoped(db, input.tenantId).delete(monitoredAddresses, and(
      eq(monitoredAddresses.id, input.addressId),
      eq(monitoredAddresses.userId, input.userId),
      eq(monitoredAddresses.verificationSource, "extra"),
    ));
    return rows.length > 0;
  },

  async deleteUserAddresses(db: Db, tenantId: string, userId: string): Promise<number> {
    const rows = await tenantScoped(db, tenantId).delete(monitoredAddresses, eq(monitoredAddresses.userId, userId));
    return rows.length;
  },

  async updateCheck(db: Db, input: {
    tenantId: string;
    userId: string;
    addressId: string;
    status: CheckStatus;
    checkedAt: Date;
  }): Promise<boolean> {
    const values = input.status === "failed"
      ? { checkStatus: input.status, lastCheckedAt: input.checkedAt, updatedAt: input.checkedAt }
      : { checkStatus: input.status, lastCheckedAt: input.checkedAt, lastSuccessfulCheckAt: input.checkedAt, updatedAt: input.checkedAt };
    const rows = await tenantScoped(db, input.tenantId).update(monitoredAddresses, values, and(
      eq(monitoredAddresses.id, input.addressId),
      eq(monitoredAddresses.userId, input.userId),
      isNotNull(monitoredAddresses.verifiedAt),
      or(isNull(monitoredAddresses.lastCheckedAt), lte(monitoredAddresses.lastCheckedAt, input.checkedAt)),
    ));
    return rows.length > 0;
  },

  async upsertObservations(db: Db, input: {
    tenantId: string;
    userId: string;
    addressId: string;
    observations: BreachObservationInput[];
    now: Date;
  }): Promise<{ newObservations: ObservationRow[] }> {
    return tenantScoped(db, input.tenantId).transaction(async (t) => {
      await t.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${
        `breach-observations:${input.tenantId}:${input.addressId}`
      }, 0))`);
      const address = await t.first(monitoredAddresses, and(
        eq(monitoredAddresses.id, input.addressId),
        eq(monitoredAddresses.userId, input.userId),
        isNotNull(monitoredAddresses.verifiedAt),
      ));
      if (!address) return { newObservations: [] };
      const unique = [...new Map(input.observations.map((observation) => [observation.breachName, observation])).values()];
      if (unique.length === 0) return { newObservations: [] };
      const names = unique.map((observation) => observation.breachName);
      const existing = await t.select(breachObservations, and(
        eq(breachObservations.monitoredAddressId, input.addressId),
        inArray(breachObservations.breachName, names),
      ));
      const alreadySeen = new Set(existing.map((row) => row.breachName));
      const newAlertNames = new Set(unique.filter((item) => !alreadySeen.has(item.breachName) && !item.retiredAt).map((item) => item.breachName));
      const rows = await t.tx.insert(breachObservations).values(unique.map((item) => ({
        tenantId: input.tenantId,
        monitoredAddressId: input.addressId,
        breachName: item.breachName,
        breachDomain: item.domain ?? null,
        breachDate: item.breachDate ?? null,
        addedDate: item.addedDate ?? null,
        dataClasses: item.dataClasses,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        retiredAt: item.retiredAt ?? null,
      }))).onConflictDoUpdate({
        target: [breachObservations.tenantId, breachObservations.monitoredAddressId, breachObservations.breachName],
        set: {
          breachDomain: sql`excluded.breach_domain`,
          breachDate: sql`excluded.breach_date`,
          addedDate: sql`excluded.added_date`,
          dataClasses: sql`excluded.data_classes`,
          lastSeenAt: input.now,
          retiredAt: sql`coalesce(${breachObservations.retiredAt}, excluded.retired_at)`,
        },
      }).returning();
      return { newObservations: rows.filter((row) => newAlertNames.has(row.breachName) && row.retiredAt === null).map(observationResult) };
    });
  },

  async listObservations(db: Db, input: { tenantId: string; userId: string; addressId: string }): Promise<ObservationRow[]> {
    const address = await tenantScoped(db, input.tenantId).first(monitoredAddresses, and(
      eq(monitoredAddresses.id, input.addressId),
      eq(monitoredAddresses.userId, input.userId),
    ));
    if (!address) return [];
    const rows = await tenantScoped(db, input.tenantId).select(breachObservations, eq(breachObservations.monitoredAddressId, input.addressId), {
      orderBy: [desc(breachObservations.firstSeenAt)],
    });
    return rows.map(observationResult);
  },

  async listEligibleAddressIds(db: Db, input: { cursor?: string; limit?: number } = {}): Promise<{
    items: Array<{ tenantId: string; userId: string; addressId: string }>;
    nextCursor?: string;
  }> {
    const limit = input.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid breach-address page size");
    let cursor: [string | null, string | null, string | null] = [null, null, null];
    if (input.cursor) {
      const value: unknown = JSON.parse(input.cursor);
      if (!Array.isArray(value) || value.length !== 3 || value.some((part) => typeof part !== "string")) throw new Error("Invalid breach-address cursor");
      cursor = value as [string, string, string];
    }
    const result = await db.execute(sql`
      SELECT tenant_id, user_id, address_id
      FROM public.list_monitored_breach_addresses(${cursor[0]}::uuid, ${cursor[1]}::text, ${cursor[2]}::uuid, ${limit}::integer)
    `);
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
    const items = rows.map((row) => ({
      tenantId: String(row.tenant_id),
      userId: String(row.user_id),
      addressId: String(row.address_id),
    }));
    const last = items.at(-1);
    const nextCursor = items.length === limit && last ? JSON.stringify([last.tenantId, last.userId, last.addressId]) : undefined;
    return { items, nextCursor };
  },

  async purgeExpiredVerificationTokens(db: Db): Promise<number> {
    const result = await db.execute(sql`SELECT public.purge_expired_breach_verification_tokens() AS purged`);
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
    return Number(rows[0]?.purged ?? 0);
  },
};
