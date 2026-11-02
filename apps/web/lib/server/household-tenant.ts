/**
 * A user's household, created on first use. Shared by the Auth.js `session` callback (auth.ts) and
 * the eve channel's in-process session lookup (session-core.ts); imports nothing from Next.
 */
import { hashPii, logger } from "@neo/core";
import { createTenantForUser, findTenantForUser, type Db } from "@neo/db";

/** "<first name>'s household", or "My household" when no name is known. */
export function householdName(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${first}'s household` : "My household";
}

/** Resolve the user's tenant, creating the household once if it is missing (retry path of the spec). */
export async function resolveTenant(db: Db, userId: string, name: string | null | undefined) {
  const existing = await findTenantForUser(db, userId);
  if (existing) return existing;
  try {
    await createTenantForUser(db, { userId, name: householdName(name) });
    return await findTenantForUser(db, userId);
  } catch (err) {
    logger.error("Tenant creation retry failed", "auth", {
      userIdHash: hashPii(userId),
      errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return undefined;
  }
}
