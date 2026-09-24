import type { CheckContext, RdapResult } from "../types.js";
import { daysBetween, discardBody, readJson, timeoutSignal } from "../util.js";

export const RDAP_BASE = "https://rdap.org/domain/";

type RdapEntity = { roles?: string[]; vcardArray?: [string, unknown[][]]; publicIds?: { type?: string; identifier?: string }[]; handle?: string };
type RdapDoc = { ldhName?: string; events?: { eventAction?: string; eventDate?: string }[]; entities?: RdapEntity[]; status?: string[] };

function vcardName(e: RdapEntity): string | undefined {
  const props = e.vcardArray?.[1];
  if (!Array.isArray(props)) return undefined;
  for (const p of props) {
    if (Array.isArray(p) && p[0] === "fn" && typeof p[3] === "string" && p[3].trim()) return p[3].trim();
  }
  for (const p of props) {
    if (Array.isArray(p) && p[0] === "org" && typeof p[3] === "string" && p[3].trim()) return p[3].trim();
  }
  return undefined;
}

/** Parse an RDAP domain response (RFC 9083). */
export function parseRdap(domain: string, body: unknown, now: Date): RdapResult {
  const doc = (body ?? {}) as RdapDoc;
  const eventDate = (action: string) => doc.events?.find((e) => e.eventAction === action)?.eventDate;
  const created = eventDate("registration");
  const expires = eventDate("expiration");
  const last_changed = eventDate("last changed");
  const registrarEntity = doc.entities?.find((e) => e.roles?.includes("registrar"));
  const registrar = registrarEntity ? (vcardName(registrarEntity) ?? registrarEntity.publicIds?.[0]?.identifier ?? registrarEntity.handle) : undefined;
  const createdDate = created ? new Date(created) : undefined;
  const age_days = createdDate && !Number.isNaN(createdDate.getTime()) ? Math.max(0, daysBetween(createdDate, now)) : undefined;
  const result: RdapResult = { found: true, domain: (doc.ldhName ?? domain).toLowerCase() };
  if (created) result.created = created;
  if (expires) result.expires = expires;
  if (last_changed) result.last_changed = last_changed;
  if (registrar) result.registrar = registrar;
  if (doc.status?.length) result.status = doc.status;
  if (age_days !== undefined) result.age_days = age_days;
  return result;
}

/** Look up domain registration via rdap.org (redirects to the authoritative RDAP server via the IANA bootstrap). */
export async function checkRdap(domain: string, ctx: CheckContext): Promise<RdapResult> {
  const res = await ctx.deps.fetch(`${RDAP_BASE}${encodeURIComponent(domain)}`, {
    headers: { accept: "application/rdap+json, application/json" },
    redirect: "follow",
    signal: timeoutSignal(ctx.deps.timeoutMs, ctx.signal),
  });
  if (res.status === 404) {
    discardBody(res);
    return { found: false, domain };
  }
  if (!res.ok) {
    discardBody(res);
    throw new Error(`HTTP ${res.status}`);
  }
  return parseRdap(domain, await readJson(res), ctx.deps.now());
}
