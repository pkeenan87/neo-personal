import type { SessionContext } from "eve/context";

/** Tenant and user of the verified caller. Fails closed: internal paths can have no caller. */
export function requireTenantCaller(ctx: SessionContext): { tenantId: string; userId: string } {
  const caller = ctx.session.auth.current;
  const tenantId = caller?.attributes.tenantId;
  if (caller?.principalType !== "user" || typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error("An authenticated Neo household member is required.");
  }
  return { tenantId, userId: caller.principalId };
}
