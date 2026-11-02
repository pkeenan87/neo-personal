import type { SessionContext } from "eve/context";
import type { IncidentCaller } from "@/lib/server/incident-data";

/** The part of an eve caller (`ctx.session.auth.current`, `onMessage`'s `ctx.eve.caller`) that Neo reads. */
export interface EveCaller {
  readonly principalType: string;
  readonly principalId: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/**
 * Tenant, user and role of a verified caller (set by agent/lib/app-session.ts), or null. An unknown
 * role counts as a plain member.
 */
export function tenantCallerOf(caller: EveCaller | null | undefined): IncidentCaller | null {
  const tenantId = caller?.attributes.tenantId;
  if (caller?.principalType !== "user" || typeof tenantId !== "string" || tenantId.length === 0) return null;
  return { tenantId, userId: caller.principalId, role: caller.attributes.role === "owner" ? "owner" : "member" };
}

/** Tenant, user and role of the verified caller. Fails closed: internal paths can have no caller. */
export function requireTenantCaller(ctx: SessionContext): IncidentCaller {
  const caller = tenantCallerOf(ctx.session.auth.current);
  if (!caller) throw new Error("An authenticated Neo household member is required.");
  return caller;
}
