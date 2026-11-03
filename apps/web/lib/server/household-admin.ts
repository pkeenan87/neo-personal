/**
 * `requireHouseholdAdmin`: the server-side owner check for the v2 console routes and the acting eve
 * tools (_specs/v2-m1-elder.md section 8). It ignores whatever role the caller carries (the session
 * cache, an eve caller attribute) and re-reads the membership from the database, so an owner who was
 * demoted or removed since their session was issued is refused at once.
 *
 * Imports nothing from Next, so the eve server can bundle it. Without DATABASE_URL (MOCK_MODE, tests)
 * it reads the in-memory household; a household with no registered memory members falls back to the
 * role the caller claims, which only the zero-infrastructure dev path ever reaches.
 */
import { getMembershipRole, tenantScoped } from "@neo/db";
import { getDb } from "./db";
import { memoryListMembers } from "./memory-state";

export interface HouseholdActor {
  tenantId: string;
  userId: string;
  /** The role the caller carries; only the no-database fallback ever looks at it. */
  role?: "owner" | "member";
}

export type AdminCheck = { ok: true } | { ok: false; status: 403; code: "forbidden"; message: string };

const NOT_ADMIN: AdminCheck = { ok: false, status: 403, code: "forbidden", message: "Only the household owner can do this." };

/** The user's role in the household from the database, else the memory twin; undefined when not a member. */
export async function currentHouseholdRole(actor: HouseholdActor): Promise<"owner" | "member" | undefined> {
  const db = getDb();
  if (db) return getMembershipRole(tenantScoped(db, actor.tenantId), actor.userId);
  const registered = memoryListMembers(actor.tenantId);
  const entry = registered.find((m) => m.userId === actor.userId);
  if (entry) return entry.role;
  return registered.length === 0 ? actor.role : undefined;
}

/** Ok only when the actor is an owner of the household right now. A storage error propagates (routes answer 503; the tools refuse). */
export async function requireHouseholdAdmin(actor: HouseholdActor): Promise<AdminCheck> {
  return (await currentHouseholdRole(actor)) === "owner" ? { ok: true } : NOT_ADMIN;
}
