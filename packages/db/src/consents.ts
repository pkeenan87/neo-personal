/**
 * Consent log (_specs/v2-m2-child.md section 3): which acknowledgements a household gave about a
 * member's monitoring. Append-only; every query is tenant-scoped and a row can only name a member
 * of the same household.
 */
import { eq, sql } from "drizzle-orm";
import { CONSENT_KINDS, consents, members, type ConsentKind } from "./schema/index.js";
import type { TenantDb } from "./tenant.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ConsentRow = typeof consents.$inferSelect;

/**
 * Record a consent for a member of the tenant. `evidence` is small, minimized JSON (never contact
 * details or free text). Throws on an unknown kind, a bad id, or a member that is not in the household.
 */
export async function recordConsent(
  tdb: TenantDb,
  input: { memberId: string; kind: ConsentKind; grantedBy: string | null; evidence?: Record<string, unknown> },
): Promise<ConsentRow> {
  if (!(CONSENT_KINDS as readonly string[]).includes(input.kind)) throw new Error("@neo/db: unknown consent kind");
  if (!UUID_RE.test(input.memberId)) throw new Error("@neo/db: invalid member id");
  const evidence = input.evidence ?? {};
  if (JSON.stringify(evidence).length > 1000) throw new Error("@neo/db: consent evidence too large");
  return tdb.transaction(async (t) => {
    const member = await t.first(members, eq(members.id, input.memberId));
    if (!member) throw new Error("@neo/db: member is not in this household");
    const [row] = await t.insert(consents, { memberId: input.memberId, kind: input.kind, grantedBy: input.grantedBy, evidence });
    if (!row) throw new Error("@neo/db: consent insert returned no row");
    return row;
  });
}

/** A member's consents, newest first. */
export async function listConsents(tdb: TenantDb, memberId: string): Promise<ConsentRow[]> {
  if (!UUID_RE.test(memberId)) return [];
  return tdb.select(consents, eq(consents.memberId, memberId), { orderBy: [sql`${consents.grantedAt} desc`, sql`${consents.id} desc`] });
}
