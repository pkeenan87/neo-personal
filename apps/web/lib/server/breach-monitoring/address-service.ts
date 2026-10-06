import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { breachMonitoring, users, type AddressRow, type Db, type RequestVerificationResult } from "@neo/db";
import type { EnvSource } from "@/lib/env";
import {
  decryptMonitoredAddress,
  deriveMonitoredAddressDigest,
  encryptMonitoredAddress,
  hashVerificationToken,
  issueVerificationToken,
  normalizeBreachAddress,
} from "./crypto";

export type AddVerifiedAddressInput = {
  tenantId: string; userId: string; addressId: string; digest: string;
  encryptedAddress: Uint8Array; verifiedAt: Date; now: Date;
};
export type RequestVerificationInput = {
  tenantId: string; userId: string; addressId: string; digest: string;
  encryptedAddress: Uint8Array; verificationTokenHash: string;
  verificationExpiresAt: Date; now: Date;
};
export type VerifyAddressInput = {
  tenantId: string; userId: string; verificationTokenHash: string; verifiedAt: Date;
};

export interface BreachAddressStore {
  listAddresses(tenantId: string, userId: string): Promise<AddressRow[]>;
  addVerifiedAddress(input: AddVerifiedAddressInput): Promise<AddressRow>;
  requestVerification(input: RequestVerificationInput): Promise<RequestVerificationResult>;
  verifyAddress(input: VerifyAddressInput): Promise<AddressRow | undefined>;
  removeAddress(tenantId: string, userId: string, addressId: string): Promise<boolean>;
  deleteUserAddresses(tenantId: string, userId: string): Promise<number>;
}

export type BreachVerificationEmail = {
  to: string;
  verificationUrl: string;
  idempotencyKey: string;
};
export type BreachAddressView = {
  id: string;
  email: string;
  source: "sign_in" | "extra";
  verificationStatus: "pending" | "verified";
  verifiedAt: string | null;
  checkStatus: AddressRow["checkStatus"];
  lastCheckedAt: string | null;
  lastSuccessfulCheckAt: string | null;
};

type VerifiedSigninAddress = { email: string; emailVerified: Date | null };
type ServiceInput = { tenantId: string; userId: string };

export function createBreachAddressService(deps: {
  store: BreachAddressStore;
  source?: EnvSource;
  baseUrl: string;
  now?: () => Date;
  resolveVerifiedSignin(userId: string): Promise<VerifiedSigninAddress | undefined>;
  sendVerificationEmail(message: BreachVerificationEmail): Promise<void>;
  mailConfigured?: boolean;
}) {
  const source = deps.source ?? process.env;
  const now = deps.now ?? (() => new Date());

  async function ensureSigninAddress(input: ServiceInput): Promise<void> {
    const identity = await deps.resolveVerifiedSignin(input.userId);
    if (!identity?.email || !identity.emailVerified) return;
    let email: string;
    try {
      email = normalizeBreachAddress(identity.email);
    } catch {
      return;
    }
    const digest = await deriveMonitoredAddressDigest(input.tenantId, email, source);
    const addresses = await deps.store.listAddresses(input.tenantId, input.userId);
    if (addresses.some((address) => address.verificationSource === "sign_in" && address.digest === digest)) return;
    const addressId = randomUUID();
    const encryptedAddress = encryptMonitoredAddress(email, { ...input, addressId }, source);
    await deps.store.addVerifiedAddress({
      ...input,
      addressId,
      digest,
      encryptedAddress,
      verifiedAt: identity.emailVerified,
      now: now(),
    });
  }

  async function listAddresses(input: ServiceInput): Promise<BreachAddressView[]> {
    await ensureSigninAddress(input);
    const addresses = await deps.store.listAddresses(input.tenantId, input.userId);
    const views: Array<BreachAddressView | undefined> = addresses.map((address) => {
      let email: string;
      try {
        email = decryptMonitoredAddress(
          address.encryptedAddress,
          { tenantId: address.tenantId, userId: address.userId, addressId: address.id },
          source,
        );
      } catch {
        // One undecryptable row must not take down the whole list; log the id only, never the address.
        console.warn("breach-monitoring: skipping undecryptable monitored address", address.id);
        return undefined;
      }
      return {
        id: address.id,
        email,
        source: address.verificationSource,
        verificationStatus: address.verifiedAt ? "verified" : "pending",
        verifiedAt: address.verifiedAt?.toISOString() ?? null,
        checkStatus: address.checkStatus,
        lastCheckedAt: address.lastCheckedAt?.toISOString() ?? null,
        lastSuccessfulCheckAt: address.lastSuccessfulCheckAt?.toISOString() ?? null,
      };
    });
    return views.filter((view): view is BreachAddressView => view !== undefined);
  }

  async function requestExtraAddress(input: ServiceInput & { email: string }): Promise<{ status: RequestVerificationResult["status"] | "invalid_address" | "unconfigured" | "email_unconfigured" | "email_failed" }> {
    let email: string;
    try {
      email = normalizeBreachAddress(input.email);
    } catch {
      return { status: "invalid_address" };
    }
    if (deps.mailConfigured === false) return { status: "email_unconfigured" };
    try {
      const digest = await deriveMonitoredAddressDigest(input.tenantId, email, source);
      const addressId = randomUUID();
      const encryptedAddress = encryptMonitoredAddress(email, { tenantId: input.tenantId, userId: input.userId, addressId }, source);
      const token = issueVerificationToken();
      const verificationTokenHash = hashVerificationToken(token);
      const sentAt = now();
      const result = await deps.store.requestVerification({
        tenantId: input.tenantId,
        userId: input.userId,
        addressId,
        digest,
        encryptedAddress,
        verificationTokenHash,
        verificationExpiresAt: new Date(sentAt.getTime() + 24 * 60 * 60 * 1000),
        now: sentAt,
      });
      if (result.status !== "reserved") return { status: result.status };
      const verificationUrl = new URL("/settings/breaches/verify", deps.baseUrl);
      verificationUrl.searchParams.set("token", token);
      try {
        await deps.sendVerificationEmail({
          to: email,
          verificationUrl: verificationUrl.toString(),
          idempotencyKey: `breach-verification-${randomUUID()}`,
        });
      } catch {
        return { status: "email_failed" };
      }
      return { status: "reserved" };
    } catch (error) {
      if (error instanceof Error && (error.message.includes("NEO_MASTER_KEY") || error.message.includes("master key"))) {
        return { status: "unconfigured" };
      }
      if (error instanceof Error && error.message.includes("valid email address")) return { status: "invalid_address" };
      throw error;
    }
  }

  async function confirmAddress(input: ServiceInput & { token: string }): Promise<{ verified: boolean }> {
    let verificationTokenHash: string;
    try {
      verificationTokenHash = hashVerificationToken(input.token);
    } catch {
      return { verified: false };
    }
    const result = await deps.store.verifyAddress({
      tenantId: input.tenantId,
      userId: input.userId,
      verificationTokenHash,
      verifiedAt: now(),
    });
    return { verified: Boolean(result) };
  }

  async function removeAddress(input: ServiceInput & { addressId: string }): Promise<{ removed: boolean }> {
    return { removed: await deps.store.removeAddress(input.tenantId, input.userId, input.addressId) };
  }

  return { listAddresses, requestExtraAddress, confirmAddress, removeAddress, ensureVerifiedSigninAddress: ensureSigninAddress };
}

export function createDbBreachAddressStore(db: Db): BreachAddressStore {
  return {
    listAddresses: (tenantId, userId) => breachMonitoring.listAddresses(db, tenantId, userId),
    addVerifiedAddress: (input) => breachMonitoring.addVerifiedAddress(db, input),
    requestVerification: (input) => breachMonitoring.requestVerification(db, {
      tenantId: input.tenantId, userId: input.userId, addressId: input.addressId, digest: input.digest,
      encryptedAddress: input.encryptedAddress, tokenHash: input.verificationTokenHash, expiresAt: input.verificationExpiresAt, now: input.now,
    }),
    verifyAddress: (input) => breachMonitoring.verifyAddress(db, {
      tenantId: input.tenantId, userId: input.userId, tokenHash: input.verificationTokenHash, verifiedAt: input.verifiedAt,
    }),
    removeAddress: (tenantId, userId, addressId) => breachMonitoring.removeAddress(db, { tenantId, userId, addressId }),
    deleteUserAddresses: (tenantId, userId) => breachMonitoring.deleteUserAddresses(db, tenantId, userId),
  };
}

export function createDbBreachAddressService(input: {
  db: Db; source?: EnvSource; baseUrl: string; sendVerificationEmail(message: BreachVerificationEmail): Promise<void>;
  mailConfigured?: boolean; now?: () => Date;
}) {
  return createBreachAddressService({
    store: createDbBreachAddressStore(input.db),
    source: input.source,
    baseUrl: input.baseUrl,
    now: input.now,
    mailConfigured: input.mailConfigured,
    resolveVerifiedSignin: async (userId) => {
      const [user] = await input.db.select({ email: users.email, emailVerified: users.emailVerified }).from(users).where(eq(users.id, userId)).limit(1);
      return user?.email && user.emailVerified ? { email: user.email, emailVerified: user.emailVerified } : undefined;
    },
    sendVerificationEmail: input.sendVerificationEmail,
  });
}
