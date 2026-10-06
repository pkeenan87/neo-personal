import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { breachMonitoring, users, type Db } from "@neo/db";
import type { EnvSource } from "@/lib/env";
import { deriveMonitoredAddressDigest, encryptMonitoredAddress, normalizeBreachAddress } from "./crypto";

/** Idempotently seed the verified account email after Auth.js resolves its household. */
export async function syncVerifiedSigninAddress(input: {
  db: Db;
  tenantId: string;
  userId: string;
  source?: EnvSource;
  now?: Date;
}): Promise<void> {
  const [user] = await input.db.select({ email: users.email, emailVerified: users.emailVerified }).from(users).where(eq(users.id, input.userId)).limit(1);
  if (!user?.email || !user.emailVerified) return;
  let email: string;
  try {
    email = normalizeBreachAddress(user.email);
  } catch {
    return;
  }
  const source = input.source ?? process.env;
  const digest = await deriveMonitoredAddressDigest(input.tenantId, email, source);
  const existing = await breachMonitoring.listAddresses(input.db, input.tenantId, input.userId);
  if (existing.some((row) => row.verificationSource === "sign_in" && row.digest === digest)) return;
  const addressId = randomUUID();
  const now = input.now ?? new Date();
  await breachMonitoring.addVerifiedAddress(input.db, {
    tenantId: input.tenantId,
    userId: input.userId,
    addressId,
    digest,
    encryptedAddress: encryptMonitoredAddress(email, { tenantId: input.tenantId, userId: input.userId, addressId }, source),
    verifiedAt: user.emailVerified,
    now,
  });
}
